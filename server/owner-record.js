'use strict';

// owner-record.js — 오너 직접 매매(바이낸스 실계좌 USDⓈ-M 선물) 자동 기록·채점(2026-10-15, docs/00 "오너 vs 시스템 겨루기").
// 읽기 전용이다: 이 파일의 클라이언트는 서명된 GET 만 보낸다(주문·취소 경로가 아예 없다). 키(.env OWNER_BINANCE_API_KEY /
// OWNER_BINANCE_API_SECRET)가 읽기 말고 다른 권한(선물·현물 주문 · 출금 · 이체 등)을 하나라도 가지면 쓰지 않는다.
// 실계좌 주소는 '읽기'로만 쓴다 — 시스템 주문은 여전히 데모뿐이다(CLAUDE.md).
//   10분마다 규칙 점검: ① 레버리지(실제 노출 ÷ 순자산 > 1.05배) ② 포지션마다 손절 주문(열고 5분 안에) ③ 허용 종목(BTC·ETH·미국 주식)
//   기준점: 선물 지갑에 minEquity(10 USDT) 이상이 처음 들어온 순간 — 기간도 그때부터. 입출금이 보이면 그 자리에서 구간을 끊는다.
//   하루 한 번(한국 09:00 이후): 순자산 · 입출금 반영 수익률 + 같은 시각의 시스템(데모 계좌) 순자산 · 나스닥(QQQUSDT) 가격
//   매주 월요일 성적표 · 위반 · 손실 한도 도달 · 기간 끝은 바로 텔레그램.

const fs = require('fs');
const path = require('path');
const EX = require('./exchange');
const { kstParts } = require('./trend-follow');
const { EXCLUDE } = require('./backtest/fetch-tradfi');

const FAPI = 'https://fapi.binance.com';
const SAPI = 'https://api.binance.com';
const STATE_PATH = path.join(__dirname, '..', 'reports', 'owner-record.json');
const DAY = 86400000;
// 매매 손익이 아닌 돈의 이동(입금·출금·지갑 간 이체·보너스) — 수익률에서 뺀다
const FLOW_TYPES = new Set(['TRANSFER', 'INTERNAL_TRANSFER', 'CROSS_COLLATERAL_TRANSFER', 'STRATEGY_UMFUTURES_TRANSFER', 'COIN_SWAP_DEPOSIT', 'COIN_SWAP_WITHDRAW', 'WELCOME_BONUS']);
const DEFAULTS = Object.freeze({ enabled: false, startDate: null, days: 90, minTrades: 30, maxLossPct: 15, minEquity: 10, checkEveryMin: 10, graceMin: 5, snapshotAtKst: '09:00' });

function effectiveParams(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return {
    enabled: c.enabled === true,
    startDate: /^\d{4}-\d{2}-\d{2}$/.test(String(c.startDate || '')) ? c.startDate : null,
    days: num(c.days, 7, 365, DEFAULTS.days),
    minTrades: num(c.minTrades, 1, 1000, DEFAULTS.minTrades),
    maxLossPct: num(c.maxLossPct, 1, 60, DEFAULTS.maxLossPct),
    minEquity: num(c.minEquity, 1, 1e9, DEFAULTS.minEquity),
    checkEveryMin: num(c.checkEveryMin, 5, 120, DEFAULTS.checkEveryMin),
    graceMin: num(c.graceMin, 0, 60, DEFAULTS.graceMin),
    snapshotAtKst: /^\d{2}:\d{2}$/.test(String(c.snapshotAtKst || '')) ? c.snapshotAtKst : DEFAULTS.snapshotAtKst,
  };
}

// GET /sapi/v1/account/apiRestrictions → 읽기만 켜져 있어야 ok
const PERM_LABEL = Object.freeze({
  enableWithdrawals: '출금', enableFutures: '선물 주문', enableSpotAndMarginTrading: '현물·마진 주문', enableMargin: '마진',
  enableVanillaOptions: '옵션', enableInternalTransfer: '내부 이체', permitsUniversalTransfer: '지갑 간 이체',
  enablePortfolioMarginTrading: '포트폴리오 마진', enableFixApiTrade: 'FIX 주문',
});
function checkKeyRestrictions(r) {
  if (!r || typeof r !== 'object') return { ok: false, problems: ['키 권한 정보를 읽지 못함'], warnings: [] };
  const problems = [];
  if (r.enableReading !== true) problems.push('읽기 권한이 꺼져 있음');
  for (const [k, v] of Object.entries(r)) {
    if (v !== true || k === 'enableReading' || k === 'enableFixReadOnly') continue;
    if (/^(enable|permits)/.test(k)) problems.push(`${PERM_LABEL[k] || k} 권한이 켜져 있음`);
  }
  return { ok: problems.length === 0, problems, warnings: r.ipRestrict === true ? [] : ['IP 제한 없음 — 서버 IP 로 제한하세요'] };
}

// fetch-tradfi.js 가 Yahoo 로 확인한 바이낸스 미국 주식 목록(reports/backtest/data/tradfi/meta.json) — 1분 캐시.
// ok = 미국 상장 주식·ETF 로 확인됨, banned = 레버리지·인버스·코인·원자재 ETF·해외 상장 등으로 확인됨, 나머지는 모름.
const TRADFI_META = path.join(__dirname, '..', 'reports', 'backtest', 'data', 'tradfi', 'meta.json');
const BANNED_REASON = /레버리지|인버스|코인 ETF|원자재|한국 주식|홍콩|비상장|환율|달러 아님|미국 거래소 아님|주식·ETF 아님/;
let _metaOverride;
let _metaCache = { at: 0, map: null };
function _setTradfiMetaForTest(m) {
  _metaOverride = m;
  _metaCache = { at: 0, map: null };
}
function tradfiStatusMap(now = Date.now()) {
  if (_metaOverride !== undefined) {
    if (!_metaOverride) return null;
    return new Map((_metaOverride.symbols || []).map((x) => [x.binance, x.ok ? 'ok' : BANNED_REASON.test(String(x.reason || '')) ? 'banned' : 'unknown']));
  }
  if (_metaCache.map !== undefined && now - _metaCache.at < 60000 && _metaCache.at) return _metaCache.map;
  let map = null;
  try {
    const m = JSON.parse(fs.readFileSync(TRADFI_META, 'utf8'));
    map = new Map((m.symbols || []).map((x) => [x.binance, x.ok ? 'ok' : BANNED_REASON.test(String(x.reason || '')) ? 'banned' : 'unknown']));
  } catch (_) {
    map = null;
  }
  _metaCache = { at: now, map };
  return map;
}

// 허용 종목: BTC·ETH(어느 결제 통화든) · 바이낸스 미국 주식·ETF(TRADIFI, 원자재·한국·레버리지 등 제외). 종목 정보가 없으면 null(판단 보류).
// Yahoo 확인 목록이 있으면 거기서 '안 됨'으로 확인된 것(레버리지 ETF 등)도 뺀다.
// strict(Claude 선수용): Yahoo 로 미국 주식·ETF 라고 확인된 것만 — 모르는 상품은 사지 않는다.
// 오너는 strict 가 아니다: 확인 못 한 진짜 주식을 위반으로 잡지 않게, '안 됨'으로 확인된 것만 위반.
function isAllowedSymbol(symbol, info, { strict = false } = {}) {
  const s = String(symbol || '').toUpperCase();
  const base = s.replace(/(USDT|USDC)$/, '');
  if (base === 'BTC' || base === 'ETH') return true;
  if (!info || !Array.isArray(info.symbols)) return null;
  const row = info.symbols.find((x) => x && x.symbol === s);
  if (!row || !/TRADIFI/i.test(String(row.contractType || ''))) return false;
  if (EXCLUDE[base]) return false;
  const map = tradfiStatusMap();
  const st = map ? map.get(base) : undefined;
  if (st === 'banned') return false;
  if (strict) return st === 'ok';
  return true;
}

// 규칙 점검. positions = positionRisk 원본, stopOrders = { SYMBOL: [일반 + 조건부 주문] }, equity = 순자산(USDT)
function checkRules({ positions, stopOrders, equity, info, now = Date.now(), graceMin = DEFAULTS.graceMin } = {}) {
  const open = (Array.isArray(positions) ? positions : []).filter((p) => p && Math.abs(Number(p.positionAmt)) > 0);
  const violations = [];
  let notional = 0;
  for (const p of open) {
    const amt = Number(p.positionAmt);
    const n = Math.abs(Number(p.notional)) || Math.abs(amt * Number(p.markPrice));
    if (Number.isFinite(n)) notional += n;
    const side = amt > 0 ? 'LONG' : 'SHORT';
    const ko = side === 'LONG' ? '롱' : '숏';
    if (isAllowedSymbol(p.symbol, info) === false) violations.push({ kind: 'symbol', key: `symbol:${p.symbol}`, symbol: p.symbol, text: `${p.symbol} ${ko} — 허용 종목(BTC·ETH·미국 주식)이 아님` });
    const age = Number(p.updateTime) > 0 ? now - Number(p.updateTime) : Infinity;
    const stop = EX.findExchangeStop((stopOrders && stopOrders[p.symbol]) || [], side);
    if (stop == null && age >= graceMin * 60000) violations.push({ kind: 'stop', key: `stop:${p.symbol}:${side}`, symbol: p.symbol, text: `${p.symbol} ${ko} — 손절 주문이 없음` });
  }
  const exposure = equity > 0 ? notional / equity : null;
  if (exposure != null && exposure > 1.05) {
    violations.push({ kind: 'leverage', key: 'leverage', symbol: null, text: `레버리지 ${Math.round(exposure * 100) / 100}배 — 1배 넘음(포지션 ${Math.round(notional)} / 순자산 ${Math.round(equity)} USDT)` });
  }
  return { violations, exposure: exposure == null ? null : Math.round(exposure * 100) / 100, openCount: open.length };
}

// 손익 기록에서 허용 안 된 종목 거래(점검 사이에 열고 닫아도 잡힌다)
function junkSymbolsFromIncome(records, info) {
  const out = new Set();
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || !r.symbol || !['REALIZED_PNL', 'COMMISSION'].includes(r.incomeType)) continue;
    if (isAllowedSymbol(r.symbol, info) === false) out.add(r.symbol);
  }
  return [...out];
}

// 입금·출금·이체 합(USDT·USDC) — (from, to] 구간
function flowsOf(records, from = -Infinity, to = Infinity) {
  let s = 0;
  for (const r of Array.isArray(records) ? records : []) {
    const t = Number(r && r.time);
    if (!(t > from && t <= to) || !FLOW_TYPES.has(r.incomeType) || (r.asset && !['USDT', 'USDC'].includes(r.asset))) continue;
    const v = Number(r.income);
    if (Number.isFinite(v)) s += v;
  }
  return Math.round(s * 100) / 100;
}

// 입출금에 '구간 안에 머문 비율'을 곱한 합 — 하루 중간에 넣은 돈은 반쯤만 그날 수익의 바탕으로 본다(수정 디에츠)
function weightedFlowsOf(records, from, to) {
  if (!(to > from)) return 0;
  let s = 0;
  for (const r of Array.isArray(records) ? records : []) {
    const t = Number(r && r.time);
    if (!(t > from && t <= to) || !FLOW_TYPES.has(r.incomeType) || (r.asset && !['USDT', 'USDC'].includes(r.asset))) continue;
    const v = Number(r.income);
    if (Number.isFinite(v)) s += v * ((to - t) / (to - from));
  }
  return Math.round(s * 100) / 100;
}

// 기록 [{t, equity, flows, wFlows}] → 입출금을 뺀 누적 수익률·최대 손실(%).
// 구간 수익 = (끝 − 시작 − 입출금) ÷ (시작 + 머문 비율만큼의 입출금). wFlows 가 없거나 입출금이 시작 잔고보다 크면 구간 처음에 있었다고 본다.
// 빈 계좌(1달러)에서 시작해 하루 중간에 큰돈을 넣고 번 돈이 수천 % 로 부풀지 않게 한다.
function chainReturns(snaps, key = 'equity', flowKey = 'flows', wKey = 'wFlows') {
  const list = (Array.isArray(snaps) ? snaps : []).filter((s) => s && Number(s[key]) > 0);
  let idx = 1;
  let peak = 1;
  let mdd = 0;
  for (let i = 1; i < list.length; i++) {
    const e0 = Number(list[i - 1][key]);
    const f = Number(list[i][flowKey]) || 0;
    // 넣은 돈이 원래 잔고보다 크면 그 구간은 '처음에 넣은 것'으로 본다 — 작은 잔고의 몇 분 손익이 큰 % 로 부풀지 않게(보수적)
    const w = Math.abs(f) > e0 || list[i][wKey] == null || !Number.isFinite(Number(list[i][wKey])) ? f : Number(list[i][wKey]);
    const base = e0 + w;
    const r = base > 0 ? (Number(list[i][key]) - e0 - f) / base : 0;
    idx *= 1 + r;
    peak = Math.max(peak, idx);
    mdd = Math.max(mdd, 1 - idx / peak);
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return list.length >= 2 ? { totalPct: r2((idx - 1) * 100), maxDrawdownPct: r2(mdd * 100), points: list.length } : { totalPct: null, maxDrawdownPct: null, points: list.length };
}

// 순자산: USDT + USDC(둘 다 1달러 기준 — 오너가 USDC 로 증거금을 넣어도 잡히게). 둘 다 없으면 null.
function ownerEquity(rows) {
  const a = EX.equityFromBalance(rows, 'USDT');
  const b = EX.equityFromBalance(rows, 'USDC');
  return a == null && b == null ? null : Math.round(((a || 0) + (b || 0)) * 100) / 100;
}

// 키 확인이 실패했을 때 원인 짐작 — 키 값은 절대 출력하지 않는다(길이·형식·데모 키와 같은지만)
function keyDiagnostics({ ownerKey, ownerSecret, demoKey, error } = {}) {
  const hints = [];
  const k = String(ownerKey || '');
  const sec = String(ownerSecret || '');
  const msg = String(error || '');
  if (k && demoKey && k === String(demoKey)) hints.push('이 키는 데모(가짜 돈) 계좌 키와 같습니다 — 실계좌 바이낸스(앱·binance.com)에서 새로 만든 키여야 합니다');
  if (/\s|["']/.test(k) || /\s|["']/.test(sec)) hints.push('키나 시크릿에 공백·따옴표가 섞여 있습니다');
  if (k && k.length !== 64) hints.push(`API 키 길이가 ${k.length}자입니다(보통 64자) — 복사하다 잘렸거나 다른 값일 수 있습니다`);
  if (sec && sec.length !== 64) hints.push(`시크릿 길이가 ${sec.length}자입니다(보통 64자) — 복사하다 잘렸거나 다른 값일 수 있습니다`);
  if (/Invalid Api-Key ID|-2008/i.test(msg)) hints.push('바이낸스가 이 키를 모릅니다 — 데모 키이거나, 오타이거나, 지워진 키입니다');
  if (/-2015|IP|permissions/i.test(msg)) hints.push(`IP 제한에 이 서버 IP 가 빠졌거나 권한이 맞지 않습니다`);
  if (/Signature/i.test(msg)) hints.push("시크릿이 틀렸거나, 키 종류가 '시스템 생성(HMAC)'이 아닙니다(Ed25519·RSA 는 이 서버가 못 씁니다)");
  return hints;
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pct = (v) => (v == null ? '데이터 없음' : `${v > 0 ? '+' : ''}${v}%`);

function buildReport({ title, p, owner, system, qqq, claude, claudeLessons, trades, violations, endDate, ended }) {
  const lines = [`🏁 <b>${esc(title)}</b>${endDate ? ` · ~ ${esc(endDate)}` : ''}`];
  lines.push(`대표님 직접: ${pct(owner.totalPct)} (최대 손실 ${owner.maxDrawdownPct == null ? '-' : `−${owner.maxDrawdownPct}%`}) · 청산 ${trades}번`);
  lines.push(`시스템(데모 추세추종): ${pct(system && system.totalPct)}`);
  lines.push(`나스닥(QQQ): ${pct(qqq)}`);
  if (claude !== undefined) lines.push(`Claude 분석(가상 장부): ${pct(claude)}`);
  if (claudeLessons && claudeLessons.length) lines.push(`Claude 가 요즘 배운 것: ${claudeLessons.slice(0, 2).map(esc).join(' / ')}`);
  lines.push(violations ? `⚠️ 규칙 위반 ${violations}번 — 겨루기 규칙상 무효` : '규칙 위반 0번');
  if (!ended && trades < p.minTrades) lines.push(`판정에는 청산 ${p.minTrades}번 이상이 필요(지금 ${trades}번)`);
  if (ended) lines.push(`끝: ${esc(ended.reason)}`);
  return lines.join('\n');
}

// 서명된 GET 만 보내는 실계좌 읽기 전용 클라이언트 — 주문·취소 함수가 없다
function createReadOnlyClient({ apiKey, apiSecret, fetchImpl, fapi = FAPI, sapi = SAPI } = {}) {
  if (!apiKey || !apiSecret) throw new Error('[owner] OWNER_BINANCE_API_KEY / OWNER_BINANCE_API_SECRET 가 .env 에 없습니다');
  const doFetch = fetchImpl || fetch;
  async function get(base, p, params = {}) {
    const qs = EX.signParams(params, apiSecret, Date.now());
    const res = await doFetch(`${base}${p}?${qs}`, { method: 'GET', headers: { 'X-MBX-APIKEY': apiKey } });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* 본문 없음 */
    }
    if (!res.ok) throw new Error(`[owner] ${p} 실패: ${(data && data.msg) || `HTTP ${res.status}`}`);
    return data;
  }
  return Object.freeze({
    getApiRestrictions: () => get(sapi, '/sapi/v1/account/apiRestrictions'),
    getAccountBalance: () => get(fapi, '/fapi/v2/balance'),
    getPositions: () => get(fapi, '/fapi/v3/positionRisk'),
    getOpenOrders: () => get(fapi, '/fapi/v1/openOrders'),
    getOpenAlgoOrders: (symbol) => get(fapi, '/fapi/v1/openAlgoOrders', symbol ? { symbol } : {}),
    getIncomeHistory: (opts = {}) => get(fapi, '/fapi/v1/income', EX.buildIncomeParams(opts)),
  });
}

let _statePath = STATE_PATH;
function _setStatePathForTest(p) {
  _statePath = p || STATE_PATH;
}
const _writesBlocked = () => !!process.env.NODE_TEST_CONTEXT && _statePath === STATE_PATH;
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(_statePath, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch (_) {
    return {};
  }
}
function saveState(state) {
  if (_writesBlocked()) return;
  fs.mkdirSync(path.dirname(_statePath), { recursive: true });
  const tmp = `${_statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, _statePath);
}

async function fetchPublicJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 한 번 돈다. 상태(state)를 고쳐 돌려준다 — 저장은 호출부. 텔레그램은 notify(text).
// 오너는 돈을 나중에, 여러 번 나눠 넣는다(2026-10-15): 기준점은 선물 지갑에 minEquity 이상이 처음 들어온 순간,
// 기간(days)도 그때부터 센다. 입금·출금이 보이면 그 자리에서 기록을 끊어(구간 나누기) 넣은 돈이 수익으로 섞이지 않게 한다.
async function runOwnerOnce({ cfg, client, systemClient, fetchJson = fetchPublicJson, notify = async () => {}, now = Date.now(), state = {} } = {}) {
  const p = effectiveParams(cfg && cfg.ownerRecord);
  const st = { snapshots: [], openViolations: {}, violationLog: [], ...state };
  if (!p.enabled || !p.startDate) return { state: st, skipped: '꺼짐' };
  const startT = Date.parse(`${p.startDate}T00:00:00+09:00`);
  if (now < startT) return { state: st, skipped: '시작 전' };
  if (st.startDate !== p.startDate) Object.assign(st, { startDate: p.startDate, snapshots: [], openViolations: {}, violationLog: [], ended: null, baseT: null, lastDailyKey: null, lastWeeklyKey: null, keyCheck: null, lastCheckAt: 0, lastIncomeAt: null, trades: 0 });
  if (st.ended) return { state: st, skipped: '끝남' };
  const { dateKey, hhmm } = kstParts(new Date(now));
  const endT = st.baseT ? st.baseT + p.days * DAY : null;
  const endDate = endT ? kstParts(new Date(endT)).dateKey : null;
  const checkDue = !(now - (st.lastCheckAt || 0) < p.checkEveryMin * 60000);
  const dailyDue = !!st.baseT && st.lastDailyKey !== dateKey && hhmm >= p.snapshotAtKst;
  const endDue = !!endT && now >= endT;
  if (!checkDue && !dailyDue && !endDue) return { state: st };

  // ① 키 권한 — 하루 한 번 다시 본다. 읽기 말고 다른 권한이 있으면 아무것도 읽지 않는다.
  if (!st.keyCheck || st.keyCheck.dateKey !== dateKey) {
    let kc;
    try {
      kc = checkKeyRestrictions(await client.getApiRestrictions());
    } catch (e) {
      kc = { ok: false, problems: [`권한 확인 실패: ${e.message}`], warnings: [] };
    }
    const warnedToday = st.keyCheck && st.keyCheck.dateKey === dateKey && st.keyCheck.warned;
    st.keyCheck = { ...kc, dateKey, at: now, warned: warnedToday || !kc.ok };
    if (!kc.ok && !warnedToday) await notify(`🔒 <b>대표님 매매 기록 — 키를 쓰지 않았습니다</b>\n${kc.problems.map(esc).join('\n')}\n바이낸스 API 관리에서 '읽기'만 켠 키로 바꿔 주세요.`);
  }
  if (!st.keyCheck.ok) return { state: st, skipped: '키 권한' };

  const equity = ownerEquity(await client.getAccountBalance());
  const extras = async () => {
    let systemEquity = null;
    if (systemClient) {
      try {
        systemEquity = EX.equityFromBalance(await systemClient.getAccountBalance());
      } catch (_) {
        /* 데모 계좌를 못 읽으면 비교 칸을 비운다 */
      }
    }
    let qqq = null;
    try {
      qqq = Number((await fetchJson(`${FAPI}/fapi/v1/premiumIndex?symbol=QQQUSDT`)).markPrice) || null;
    } catch (_) {
      /* 나스닥 비교 칸을 비운다 */
    }
    return { systemEquity, qqq };
  };

  // ② 기준점 — 선물 지갑에 minEquity 이상 들어오기 전엔 기다린다
  if (!st.baseT) {
    st.lastCheckAt = now;
    if (!(equity >= p.minEquity)) return { state: st, skipped: '입금 기다림' };
    st.baseT = now;
    st.lastDailyKey = dateKey;
    st.lastIncomeAt = now;
    st.snapshots.push({ kind: 'base', dateKey, t: now, equity, flows: 0, wFlows: 0, ...(await extras()) });
    await notify(`🏁 <b>대표님 매매 기록 시작</b> · ${esc(dateKey)} ~ ${esc(kstParts(new Date(now + p.days * DAY)).dateKey)}\n기준 순자산 ${Math.round(equity * 100) / 100} USDT · 앞으로 넣고 빼는 돈은 수익에서 뺍니다\n규칙: 레버리지 없음 · 손절 먼저 · 잡주 금지 · 최대 손실 −${p.maxLossPct}%`);
    return { state: st };
  }

  let info = null;
  try {
    info = await fetchJson(`${FAPI}/fapi/v1/exchangeInfo`);
  } catch (_) {
    /* 종목 정보가 없으면 종목 규칙은 이번엔 보류 */
  }

  // ③ 규칙 점검(checkEveryMin 마다) + 그 사이 손익 기록(잡주 거래·입출금)
  let flowSeen = false;
  if (checkDue) {
    const positions = await client.getPositions();
    const openSyms = [...new Set((positions || []).filter((x) => Math.abs(Number(x.positionAmt)) > 0).map((x) => x.symbol))];
    const stopOrders = {};
    if (openSyms.length) {
      const regular = await client.getOpenOrders();
      for (const sym of openSyms) {
        let algo = [];
        try {
          const a = await client.getOpenAlgoOrders(sym);
          algo = Array.isArray(a) ? a : (a && a.orders) || [];
        } catch (_) {
          /* 조건부 주문 조회 실패 — 일반 주문만으로 본다 */
        }
        stopOrders[sym] = [...(Array.isArray(regular) ? regular.filter((o) => o.symbol === sym) : []), ...algo];
      }
    }
    const rc = checkRules({ positions, stopOrders, equity, info, now, graceMin: p.graceMin });
    const since = st.lastIncomeAt || st.baseT;
    let recent = null;
    try {
      recent = await EX.fetchIncomeSince(client, since, now);
    } catch (_) {
      /* 손익 기록은 다음 점검에서 같은 구간을 다시 본다 */
    }
    if (recent) {
      for (const sym of junkSymbolsFromIncome(recent, info)) rc.violations.push({ kind: 'symbol', key: `symbol:${sym}`, symbol: sym, text: `${sym} 거래 — 허용 종목(BTC·ETH·미국 주식)이 아님` });
      flowSeen = recent.some((r) => r && FLOW_TYPES.has(r.incomeType) && Number(r.time) > since);
      st.lastIncomeAt = now;
    }
    const seen = new Set();
    for (const v of rc.violations) {
      if (seen.has(v.key)) continue;
      seen.add(v.key);
      if (!st.openViolations[v.key]) {
        st.openViolations[v.key] = { since: now, text: v.text };
        st.violationLog.push({ t: now, kind: v.kind, text: v.text });
        await notify(`⚠️ <b>규칙 위반</b> — ${esc(v.text)}\n레버리지 없음 · 손절 먼저 · 잡주 금지 중 하나를 어겼습니다. 겨루기 규칙상 이 기간 성적은 무효로 기록됩니다.`);
      }
    }
    for (const k of Object.keys(st.openViolations)) if (!seen.has(k)) delete st.openViolations[k];
    st.lastCheckAt = now;
    st.lastExposure = rc.exposure;
  }

  // ④ 기록 — 끝 · 입출금이 보인 순간 · 하루 한 번
  const kind = endDue ? 'end' : flowSeen ? 'flow' : dailyDue ? 'daily' : null;
  if (!kind) return { state: st };
  const last = st.snapshots[st.snapshots.length - 1];
  let income;
  try {
    income = await EX.fetchIncomeSince(client, st.baseT, now);
  } catch (_) {
    return { state: st, skipped: '손익 기록 조회 실패 — 다음 틱에 다시' }; // 입출금을 모른 채 기록하면 입금을 수익으로 셀 수 있다
  }
  st.snapshots.push({ kind, dateKey, t: now, equity, flows: flowsOf(income, last.t, now), wFlows: weightedFlowsOf(income, last.t, now), ...(await extras()) });
  if (kind !== 'flow') st.lastDailyKey = dateKey;
  const owner = chainReturns(st.snapshots);
  const system = chainReturns(st.snapshots, 'systemEquity', '_none');
  const first = st.snapshots.find((x) => x.qqq);
  const lastQ = [...st.snapshots].reverse().find((x) => x.qqq);
  const qqqPct = first && lastQ && first !== lastQ ? Math.round((lastQ.qqq / first.qqq - 1) * 10000) / 100 : null;
  st.trades = EX.groupCloseEvents(income).length;
  let claude;
  let claudeLessons;
  try {
    const CT = require('./claude-trader');
    const cs = CT.loadState();
    if (cs && cs.startT) {
      claude = CT.returnSince(cs.snapshots, st.baseT);
      claudeLessons = cs.lessons;
    }
  } catch (_) {
    /* Claude 선수 기록 없음 */
  }
  const view = { p, owner, system, qqq: qqqPct, claude, claudeLessons, trades: st.trades, violations: st.violationLog.length, endDate };
  if (owner.totalPct != null && owner.totalPct <= -p.maxLossPct) {
    st.ended = { t: now, reason: `최대 손실 한도 −${p.maxLossPct}% 도달` };
    await notify(buildReport({ ...view, title: '겨루기 끝 — 손실 한도', ended: st.ended }));
  } else if (kind === 'end') {
    st.ended = { t: now, reason: `기간 ${p.days}일 끝` };
    await notify(buildReport({ ...view, title: '겨루기 끝 — 최종 성적', ended: st.ended }));
  } else if (kind === 'daily' && new Date(now + 9 * 3600000).getUTCDay() === 1 && st.lastWeeklyKey !== dateKey) {
    st.lastWeeklyKey = dateKey;
    await notify(buildReport({ ...view, title: '주간 성적표' }));
  }
  return { state: st };
}

class OwnerRecorder {
  constructor({ loadConfig, exchangeMod = EX, notifyMod, intervalMs = 60000, runFn = runOwnerOnce } = {}) {
    this.loadConfig = loadConfig;
    this.exchangeMod = exchangeMod;
    this.notifyMod = notifyMod;
    this.intervalMs = intervalMs;
    this.runFn = runFn;
    this._timer = null;
    this._running = false;
    this._client = null;
  }
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick().catch((e) => console.error('[owner]', e && e.message ? e.message : e)), this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }
  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
  async _tick(now = Date.now()) {
    if (this._running || typeof this.loadConfig !== 'function') return null;
    const cfg = this.loadConfig();
    if (!effectiveParams(cfg && cfg.ownerRecord).enabled) return null;
    if (!process.env.OWNER_BINANCE_API_KEY || !process.env.OWNER_BINANCE_API_SECRET) return null;
    this._running = true;
    try {
      if (!this._client) this._client = createReadOnlyClient({ apiKey: process.env.OWNER_BINANCE_API_KEY, apiSecret: process.env.OWNER_BINANCE_API_SECRET });
      let systemClient = null;
      if (process.env.BINANCE_API_KEY && /demo/.test(process.env.BINANCE_FUTURES_BASE_URL || '')) {
        systemClient = this.exchangeMod.createClient({ apiKey: process.env.BINANCE_API_KEY, apiSecret: process.env.BINANCE_API_SECRET, baseUrl: process.env.BINANCE_FUTURES_BASE_URL });
      }
      const notify = async (text) => {
        if (this.notifyMod && typeof this.notifyMod.sendMessage === 'function') await this.notifyMod.sendMessage(text, cfg);
      };
      const r = await this.runFn({ cfg, client: this._client, systemClient, notify, now, state: loadState() });
      saveState(r.state);
      return r;
    } finally {
      this._running = false;
    }
  }
}

module.exports = {
  DEFAULTS,
  STATE_PATH,
  FLOW_TYPES,
  effectiveParams,
  checkKeyRestrictions,
  keyDiagnostics,
  isAllowedSymbol,
  tradfiStatusMap,
  _setTradfiMetaForTest,
  checkRules,
  junkSymbolsFromIncome,
  flowsOf,
  weightedFlowsOf,
  ownerEquity,
  chainReturns,
  buildReport,
  createReadOnlyClient,
  loadState,
  saveState,
  _setStatePathForTest,
  runOwnerOnce,
  OwnerRecorder,
};

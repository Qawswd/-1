'use strict';

// owner-signal.js — 대표님 직접 매매 규칙(docs/08-OWNER-RULES.md)의 매일 신호를 숫자로 보낸다(2026-10-23, 오너 "응 만들어줘").
// 차트를 눈으로 보면 '선 바로 위아래'가 애매하다 → 한국 09:05(바이낸스 일봉 마감 뒤) 마감된 일봉 종가와 그 봉의 SMA 50·200 을
// 숫자로 비교해 텔레그램으로 보낸다. 오너는 17:30 에 이 메시지대로 한다. /신호 로 언제든 다시 받을 수 있다.
// 주문은 하지 않는다 — 계산과 알림뿐(오너 계좌는 owner-record.js 가 읽기만 한다).
//   코인: fapi.binance.com 공개 일봉(진행 중인 봉 제외) · 주식(설정 stocks): Yahoo 일봉(배당 반영, 장이 끝난 봉만) — 주식은 롱만.

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'reports', 'owner-signal-state.json');
const FAPI_PUBLIC = 'https://fapi.binance.com';
const DAY = 86400000;

// 규칙(오너 규칙 한 장과 같다 — 바꾸려면 docs/08 과 docs/07 근거부터)
const RULES = Object.freeze({
  fast: 50,
  slow: 200,
  slotPct: 20, // 대표님 결정(2026-11-01): 한 칸 20% · 종목마다 한 칸(BTC·ETH·주식 3개 — 다 들면 100%)
  maxSlots: 5,
  maxStockSlots: 3, // 대표님 결정(2026-10-24): 주식은 3칸까지, 2칸은 BTC·ETH 몫(stock-universe [2b])
  // 코인 칸(2026-11-08 docs/07 '코인 나가는 방식' — 업비트는 손절·익절 동시(OCO)가 확인 안 됨): 손절 −10% 만 걸어 두고 익절 없음
  //   (10년 · 미리 정한 기준: 익절 없음 56.9% vs +30% 익절 47.4% · 2022~ 24.4 vs 23.5 · 최대 손실·최악의 해 같음)
  //   업비트 손절은 예약-지정가: 감시가 = 산 값 × (1 − stopPct) · 주문 가격은 limitPct 만큼 더 낮게(급락에도 팔리게)
  long: Object.freeze({ stopPct: 10, tpPct: null, limitPct: 13 }),
  // 코인만 · 두 선 아래 + 하락 배열(50일선 < 200일선) · 새로 들어가는 건 200일선이 slopeDays 전보다 낮을 때만 · 익절 없이 선 위로 마감하면 정리
  // (2026-10-23 다시 분석: 들어가는 시각 4개 · 두 기간 모두 플러스였던 것 — docs/07. 처음 정한 손절 4%·익절 8% 는 17:30 에서만 플러스였다)
  short: Object.freeze({ stopPct: 4, tpPct: null, slopeDays: 20 }),
  // 주식 칸(2026-11-01 docs/07 '주식 규칙 격자' · 대표님 결정): 두 선 위에서 사고 · 200일선 아래로 마감하면 정리 · 손절 −25%(큰 사고용) · 익절 없음
  // 손절은 종가로 본다(2026-11-08 — 토스 소수점은 시장가만 — 손절 주문을 걸어 둘 수 있는지 확인 안 됨): 산 값 −25% 아래 마감 → 17:30 예약 → 장 시작에 정리
  stock: Object.freeze({ stopPct: 25, tpPct: null }),
});

// shorts: 코인 숏 줄을 낼지 — 숏 결과가 들어가는 시각에 따라 뒤집혀(09:00 연 −4.7% · 17:30 +7.6%, docs/07) 오너가 끌 수 있게
// ledgerFrom: 가상 장부(owner-ledger.js) 시작한 날 — 대표님 쉬는 기간이 끝나는 11/11 부터 '규칙대로 했다면'을 적는다
const DEFAULTS = Object.freeze({ enabled: false, runAtKst: '09:05', symbols: ['BTCUSDT', 'ETHUSDT'], stocks: [], shorts: true, ledger: true, ledgerFrom: '2026-11-11' });
const COINS = Object.freeze(['BTCUSDT', 'ETHUSDT']);

function effectiveParams(c) {
  const o = c && typeof c === 'object' ? c : {};
  const up = (a) => (Array.isArray(a) ? a.map((s) => String(s).toUpperCase().trim()).filter((s, i, x) => s && x.indexOf(s) === i) : null);
  return {
    enabled: o.enabled === true,
    runAtKst: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(o.runAtKst || '')) ? String(o.runAtKst) : DEFAULTS.runAtKst,
    symbols: (up(o.symbols) || [...DEFAULTS.symbols]).filter((s) => COINS.includes(s)),
    stocks: (up(o.stocks) || []).filter((s) => /^[A-Z][A-Z.\-^]{0,9}$/.test(s)).slice(0, 8),
    shorts: o.shorts !== false,
    ledger: o.ledger !== false,
    ledgerFrom: /^\d{4}-\d{2}-\d{2}$/.test(String(o.ledgerFrom || '')) && Number.isFinite(Date.parse(`${o.ledgerFrom}T00:00:00Z`)) ? String(o.ledgerFrom) : DEFAULTS.ledgerFrom,
  };
}

const sma = (closes, n, end = closes.length) => (end >= n ? closes.slice(end - n, end).reduce((a, b) => a + b, 0) / n : null);

// 마감된 종가 목록 → 오늘(마지막 봉)과 어제의 상태. 'long' | 'short' | 'flat' | null(평균을 낼 봉이 모자람)
// stockMode: 주식 칸 규칙 — 두 선 위면 'long'(사도 됨), 200일선 위지만 50일선 아래면 'hold'(들고 있으면 유지 · 새로 사지 않음), 200일선 아래면 'flat'
function judge(closes, { allowShort = true, stockMode = false } = {}) {
  const at = (end) => {
    const c = closes[end - 1];
    const f = sma(closes, RULES.fast, end);
    const s = sma(closes, RULES.slow, end);
    if (!(c > 0) || f == null || s == null) return { c: c ?? null, f, s, state: null };
    let state = 'flat';
    if (c > f && c > s) state = 'long';
    else if (stockMode && c > s) state = 'hold';
    else if (allowShort && c < f && c < s && f < s) state = 'short';
    const s0 = sma(closes, RULES.slow, end - RULES.short.slopeDays); // 200일선 slopeDays 전 값
    return { c, f, s, s0, state, shortNew: state === 'short' && s0 != null && s < s0 };
  };
  const today = at(closes.length);
  const prev = closes.length > 1 ? at(closes.length - 1) : { state: null };
  return { ...today, prevState: prev.state };
}

// 선 바로 위아래를 가르려고 소수점을 남긴다(81,797.6 vs 81,797.0 이 같아 보이지 않게)
function fmt(x) {
  if (x == null || !Number.isFinite(x)) return '-';
  if (x >= 1000) return x.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return x >= 1 ? x.toFixed(2) : Number(x.toPrecision(4)).toString();
}
function pct(a, b) {
  if (!(a > 0 && b > 0)) return '-';
  const d = (a / b - 1) * 100;
  return `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(Math.abs(d) < 0.1 ? 3 : 2)}%`;
}
const ICON = { long: '🟢 롱', short: '🔴 숏', flat: '⚪ 쉼', hold: '🟡 유지만' };

// 종목 한 줄 묶음(HTML). j = judge 결과 + name·stock
function symbolLines(name, j, { stock = false, noShort = false } = {}) {
  if (!j || j.state == null) return [`<b>${name}</b> 데이터 없음 — 오늘은 차트로 직접 확인`];
  const head = `<b>${name}</b> 종가 ${fmt(j.c)} · 50일선 ${fmt(j.f)} (${pct(j.c, j.f)}) · 200일선 ${fmt(j.s)} (${pct(j.c, j.s)})`;
  const changed = j.prevState && j.prevState !== j.state ? ` (어제 ${ICON[j.prevState]} → 바뀜)` : '';
  const L = RULES.long;
  const S = RULES.short;
  const K = RULES.stock;
  let what;
  if (stock) {
    if (j.state === 'long') what = `두 선 위 — 들고 있으면 유지 · 없으면 17:30 토스 예약 주문(장 시작에 시장가 · 손절 −${K.stopPct}%는 종가로 — 산 값 −${K.stopPct}% 아래로 마감하면 17:30 정리, 오늘 종가로 치면 ${fmt(j.c * (1 - K.stopPct / 100))} · 익절 없음 — 200일선 아래로 마감하면 정리)`;
    else if (j.state === 'hold') what = '200일선 위 · 50일선 아래 — 들고 있으면 유지 · 없으면 새로 사지 않음(두 선 위로 마감할 때까지)';
    else what = '200일선 아래 마감 — 들고 있으면 17:30 정리(토스 예약 주문) · 새로 사지 않음';
  } else if (j.state === 'long') {
    const tp = L.tpPct ? ` · 익절 +${L.tpPct}%(${fmt(j.c * (1 + L.tpPct / 100))})` : ' · 익절 없음 — 선 하나라도 아래로 마감하면 정리';
    what = `롱 들고 있으면 유지 · 없으면 17:30 롱(손절 −${L.stopPct}% 걸어 두기 — 업비트 예약-지정가 · 감시가 산 값 × ${(1 - L.stopPct / 100).toFixed(2)} · 주문가 × ${(1 - L.limitPct / 100).toFixed(2)}, 오늘 종가로 치면 ${fmt(j.c * (1 - L.stopPct / 100))}${tp})${stock || noShort ? '' : ' · 숏 들고 있으면 정리'}`;
  } else if (j.state === 'short') {
    const slope = `200일선 ${S.slopeDays}일 전 ${fmt(j.s0)} → 지금 ${fmt(j.s)} (${pct(j.s, j.s0)})`;
    what = j.shortNew
      ? `롱 들고 있으면 17:30 정리 · 숏 들고 있으면 유지 · 없으면 17:30 숏(손절 +${S.stopPct}%, 오늘 종가로 치면 ${fmt(j.c * (1 + S.stopPct / 100))} · 익절 없음 — 선 하나라도 위로 마감하면 정리) · ${slope}`
      : `롱 들고 있으면 17:30 정리 · 숏 들고 있으면 유지 · 새 숏은 안 함(200일선이 ${S.slopeDays}일 전보다 아직 높음) · ${slope}`;
  } else {
    const why = j.c < j.f && j.c < j.s ? (stock ? '두 선 아래(주식은 숏 없음)' : noShort ? '두 선 아래(숏 안 함)' : '두 선 아래지만 하락 배열 아님') : j.c < j.f ? '50일선 아래' : '200일선 아래';
    what = `${why} — ${stock || noShort ? '롱' : '롱·숏'} 들고 있으면 17:30 정리 · 새로 들어가지 않음`;
  }
  return [head, `→ ${ICON[j.state]}${changed}: ${what}`];
}

// 오늘 17:30 할 일 — 대표님이 알려 준 '들고 있는 것'(owner-holdings, 텔레그램 /샀다 · /팔았다)과 오늘 신호를 맞대어 종목마다 하나만(2026-11-13 오너 '진입 · 유지 · 익절 신호 다 알려줘').
// 익절이 따로 없는 규칙이라 '팔기'가 익절도 손절도 된다 — 산 값을 알면 수익이면 (익절) · 손실이면 (손절)로 적는다.
// 코인 산 값은 업비트 원화라 달러 신호와 견줄 수 없다 — 코인은 수익률 대신 '손절 예약이 걸려 있는지'만 일깨운다.
function actionFor(r, h) {
  const j = r.j;
  if (!j || j.state == null) return { kind: 'unknown', text: `❔ <b>${r.name}</b> 데이터 없음 — 차트로 직접 확인` };
  const L = RULES.long;
  const K = RULES.stock;
  const held = !!h;
  const below = j.c < j.f && j.c < j.s ? '두 선 아래' : j.c < j.f ? '50일선 아래' : '200일선 아래';
  if (r.stock) {
    const pnl = held && h.avg > 0 ? (j.c / h.avg - 1) * 100 : null;
    const pnlTxt = pnl == null ? '' : ` · 산 값 대비 ${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(1)}%${pnl >= 0 ? '(익절)' : '(손절)'}`;
    const stop = held ? (h.stop > 0 ? h.stop : h.avg > 0 ? h.avg * (1 - K.stopPct / 100) : null) : null;
    if (held) {
      if (j.c < j.s) return { kind: 'sell', text: `🔔 <b>${r.name} 팔기</b> — 200일선 아래 마감(${pct(j.c, j.s)}) · 17:30 토스 전부 팔기 예약${pnlTxt} · 판 뒤 /팔았다 ${r.name}` };
      if (stop != null && j.c <= stop) return { kind: 'sell', text: `🔔 <b>${r.name} 팔기</b> — 손절선 ${fmt(stop)} 아래 마감 · 17:30 토스 전부 팔기 예약${pnlTxt} · 판 뒤 /팔았다 ${r.name}` };
      return { kind: 'hold', text: `✋ <b>${r.name} 유지</b> — 200일선 ${pct(j.c, j.s)}${stop != null ? ` · 손절선 ${fmt(stop)}` : ''}${pnl == null ? '' : ` · 산 값 대비 ${pnl >= 0 ? '+' : '−'}${Math.abs(pnl).toFixed(1)}%`}` };
    }
    if (j.state === 'long') return { kind: 'buy', text: `🛒 <b>${r.name} 사기</b> — 두 선 위 · 17:30 토스 소수점 한 칸(순자산 × ${RULES.slotPct}%) 예약 → 장 시작에 체결 · 체결되면 /샀다 ${r.name} 평균가($)` };
    if (j.state === 'hold') return { kind: 'rest', text: `😴 ${r.name} 안 삼 — 50일선 아래(${pct(j.c, j.f)}) · 두 선 위로 마감하면 산다` };
    return { kind: 'rest', text: `😴 ${r.name} 쉼 — 200일선 아래(${pct(j.c, j.s)})` };
  }
  if (held) {
    if (j.state !== 'long') return { kind: 'sell', text: `🔔 <b>${r.name} 팔기</b> — ${below} 마감 · 17:30 업비트 손절 예약을 먼저 취소하고 전부 팔기 · 판 뒤 /팔았다 ${r.name}` };
    return { kind: 'hold', text: `✋ <b>${r.name} 유지</b> — 두 선 위 · 업비트 손절 예약이 걸려 있는지만 확인(체결돼 팔렸으면 /팔았다 ${r.name})` };
  }
  if (j.state === 'long') return { kind: 'buy', text: `🛒 <b>${r.name} 사기</b> — 두 선 위 · 17:30 업비트 한 칸(순자산 × ${RULES.slotPct}%) · 바로 손절 예약(감시가 산 값 × ${(1 - L.stopPct / 100).toFixed(2)} · 주문가 × ${(1 - L.limitPct / 100).toFixed(2)} · 수량 전부) · 산 뒤 /샀다 ${r.name} 평균가(원)` };
  return { kind: 'rest', text: `😴 ${r.name} 쉼 — ${below}` };
}

const TODO_ORDER = Object.freeze({ sell: 0, buy: 1, hold: 2, rest: 3, unknown: 4 });

function todoLines(rows, holdings) {
  if (!holdings || !holdings.known) {
    return ["📋 들고 있는 걸 알려 주시면 종목마다 '사기 · 유지 · 팔기'만 딱 집어 드립니다 — 텔레그램에 /샀다 MSFT 543.43 · /팔았다 MSFT · /보유"];
  }
  const items = holdings.items || {};
  const acts = rows.map((r) => actionFor(r, items[r.name] || null)).sort((a, b) => TODO_ORDER[a.kind] - TODO_ORDER[b.kind]);
  const n = (k) => acts.filter((a) => a.kind === k).length;
  const head = n('sell') || n('buy') ? `📋 <b>오늘 17:30 할 일</b> — 팔기 ${n('sell')} · 사기 ${n('buy')} · 유지 ${n('hold')}` : `📋 <b>오늘 17:30 할 일 없음</b> — 유지 ${n('hold')} · 쉼 ${n('rest')}`;
  // 신호 줄에 없는데 들고 있다고 적힌 종목(종목을 바꾼 뒤 남은 기록 등)
  const extra = Object.keys(items).filter((s) => !rows.some((r) => r.name === s));
  return [head, ...acts.map((a) => a.text), ...(extra.length ? [`❔ 신호에 없는 종목을 들고 있다고 적혀 있음: ${extra.join(' · ')} — 정리했으면 /팔았다 ${extra[0]}`] : [])];
}

function buildMessage({ dateLabel, rows, ledger = [], holdings = null }) {
  const lines = [`📏 <b>대표님 규칙 신호</b> — ${dateLabel} 09:00 마감 일봉`, '', ...todoLines(rows, holdings)];
  for (const r of rows) lines.push('', ...symbolLines(r.name, r.j, { stock: r.stock, noShort: r.noShort }));
  if (ledger.length) lines.push('', ...ledger);
  lines.push('', `한 칸 = 순자산 ${RULES.slotPct}% · 현금·현물만(토스·업비트 — 레버리지·외상구매 없음) · 종목마다 한 칸(BTC·ETH·주식 ${RULES.maxStockSlots}개 — 다 들면 ${RULES.slotPct * RULES.maxSlots}%) · 코인은 두 선 · 손절 −${RULES.long.stopPct}%(걸어 둠) · ${RULES.long.tpPct ? `익절 +${RULES.long.tpPct}%` : '익절 없음'} / 주식은 두 선 위에서 사고 200일선 아래면 정리 · 손절 −${RULES.stock.stopPct}% · 익절 없음 · 주식은 17:30 토스 예약 주문(미국 장 시작에 시장가 체결) · 주식 손절은 종가로(산 값 −${RULES.stock.stopPct}% 아래 마감 → 17:30 정리 — 토스 소수점은 시장가만) · 코인은 체결되면 바로 손절 걸기(업비트 예약-지정가 · 감시가 −${RULES.long.stopPct}% · 주문가 −${RULES.long.limitPct}%) · 지금 가격이 달라도 이 신호대로`);
  return lines.join('\n');
}

// --- 데이터 ------------------------------------------------------------------------

async function fetchJson(url, fetchImpl = fetch, headers = {}) {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 바이낸스 kline → 마감된 봉만 {t, o, h, l, c} (가상 장부가 손절·익절 닿았는지 고가·저가를 쓴다)
function closedKlines(klines, now) {
  if (!Array.isArray(klines)) return [];
  return klines
    .map((k) => ({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), ct: Number(k[6]) }))
    .filter((k) => Number.isFinite(k.t) && k.c > 0 && Number.isFinite(k.ct) && k.ct < now)
    .sort((a, b) => a.t - b.t);
}

// Yahoo 일봉 → 장이 끝난 봉만(봉 시각은 개장 시각 — 정규장 6.5시간 + 여유)
function closedYahoo(rows, now) {
  return (rows || []).filter((b) => b.t + 7 * 3600000 <= now);
}

async function collect(p, { now = Date.now(), fetchImpl = fetch } = {}) {
  const rows = [];
  // 가상 장부가 시작한 날 전 200일선까지 만들 수 있게 — 시작한 날이 멀어질수록 더 길게(바이낸스 한 번에 1,500개까지)
  const from = Date.parse(`${p.ledgerFrom || DEFAULTS.ledgerFrom}T00:00:00Z`);
  const limit = Math.min(1500, Math.max(260, Math.ceil((now - from) / DAY) + 260));
  for (const symbol of p.symbols) {
    try {
      const k = closedKlines(await fetchJson(`${FAPI_PUBLIC}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=${limit}`, fetchImpl), now);
      rows.push({ name: symbol.replace('USDT', ''), noShort: !p.shorts, j: judge(k.map((x) => x.c), { allowShort: p.shorts }), lastT: k.length ? k[k.length - 1].t : null, bars: k });
    } catch (e) {
      rows.push({ name: symbol.replace('USDT', ''), j: null, error: e.message });
    }
  }
  for (const sym of p.stocks) {
    try {
      const { parseYahooDaily } = require('./backtest/fetch-stocks');
      const p1 = Math.floor(Math.min(now - 2 * 365 * DAY, from - 450 * DAY) / 1000);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${Math.floor(now / 1000)}&interval=1d&events=div,splits`;
      const bars = closedYahoo(parseYahooDaily(await fetchJson(url, fetchImpl, { 'User-Agent': 'Mozilla/5.0 (compatible; trading-floor)', Accept: 'application/json' })), now);
      rows.push({ name: sym, stock: true, j: judge(bars.map((b) => b.c), { allowShort: false, stockMode: true }), bars });
    } catch (e) {
      rows.push({ name: sym, stock: true, j: null, error: e.message });
    }
  }
  return rows;
}

// --- 상태 파일 --------------------------------------------------------------------

let _statePath = STATE_PATH;
function _setStatePath(p) {
  _statePath = p || STATE_PATH;
}
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(_statePath, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch (_) {
    return {};
  }
}
function saveState(s) {
  if (process.env.NODE_TEST_CONTEXT && _statePath === STATE_PATH) return;
  fs.mkdirSync(path.dirname(_statePath), { recursive: true });
  fs.writeFileSync(`${_statePath}.tmp`, JSON.stringify(s, null, 1));
  fs.renameSync(`${_statePath}.tmp`, _statePath);
}

function kstParts(now) {
  const d = new Date(now + 9 * 3600000);
  const p2 = (x) => String(x).padStart(2, '0');
  return { dateKey: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`, label: `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}`, hhmm: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` };
}

// 지금 신호 메시지 만들기(보내지는 않음) — /신호 와 ops 확인용
async function currentMessage(cfg, opts = {}) {
  const p = effectiveParams(cfg && cfg.ownerSignal);
  const now = opts.now || Date.now();
  const rows = await collect(p, { ...opts, now });
  // 날짜는 마지막으로 마감된 코인 일봉 기준(한국 09:00 전에 물으면 어제 09:00 봉이다)
  const lastT = Math.max(...rows.map((r) => (r.lastT != null ? r.lastT : -Infinity)));
  // 가상 장부 — 실패해도 신호는 보낸다
  let ledger = [];
  if (p.ledger) {
    try {
      ledger = require('./owner-ledger').ledgerLines(rows, { from: Date.parse(`${p.ledgerFrom}T00:00:00Z`), now, slotPct: RULES.slotPct });
    } catch (e) {
      ledger = [`📒 가상 장부 — 계산 실패(${e.message})`];
    }
  }
  // 들고 있는 것(텔레그램 /샀다 · /팔았다) — 못 읽어도 신호는 보낸다
  let holdings = opts.holdings || null;
  if (!holdings) {
    try {
      holdings = require('./owner-holdings').load();
    } catch {
      holdings = null;
    }
  }
  return { text: buildMessage({ dateLabel: kstParts(Number.isFinite(lastT) ? lastT + DAY : now).label, rows, ledger, holdings }), rows, ledger, holdings };
}

class OwnerSignalScheduler {
  constructor({ loadConfig, notifyMod, intervalMs = 60000, fetchImpl } = {}) {
    Object.assign(this, { loadConfig, notifyMod, intervalMs });
    this.fetchImpl = fetchImpl || fetch;
    this._timer = null;
    this._running = false;
    this._attempts = { dateKey: null, n: 0, lastAt: 0 };
  }
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick().catch((e) => console.error('[owner-signal]', e && e.message)), this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }
  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
  async _tick(now = Date.now()) {
    if (this._running || typeof this.loadConfig !== 'function') return null;
    const cfg = this.loadConfig() || {};
    const p = effectiveParams(cfg.ownerSignal);
    if (!p.enabled) return null;
    const { dateKey, hhmm } = kstParts(now);
    if (hhmm < p.runAtKst) return null;
    const st = loadState();
    if (st.lastSent === dateKey) return null;
    if (this._attempts.dateKey !== dateKey) this._attempts = { dateKey, n: 0, lastAt: 0 };
    if (this._attempts.n >= 6 || now - this._attempts.lastAt < 30 * 60000) return null;
    this._attempts.n += 1;
    this._attempts.lastAt = now;
    this._running = true;
    try {
      const { text, rows } = await currentMessage(cfg, { now, fetchImpl: this.fetchImpl });
      // 코인 일봉이 오늘 09:00 마감 봉까지 안 왔으면(거래소 지연) 30분 뒤 다시
      const expect = Math.floor(now / DAY) * DAY - DAY;
      if (rows.some((r) => !r.stock && r.lastT != null && r.lastT < expect) && this._attempts.n < 6) return { ok: false, retry: true };
      const r = this.notifyMod && typeof this.notifyMod.sendMessage === 'function' ? await this.notifyMod.sendMessage(text, cfg) : { ok: false, error: 'notify 없음' };
      if (r && r.ok) saveState({ ...st, lastSent: dateKey, states: Object.fromEntries(rows.map((x) => [x.name, x.j ? x.j.state : null])) });
      return { ok: !!(r && r.ok), text };
    } finally {
      this._running = false;
    }
  }
}

module.exports = { RULES, DEFAULTS, STATE_PATH, effectiveParams, judge, symbolLines, actionFor, todoLines, buildMessage, closedKlines, closedYahoo, collect, currentMessage, kstParts, loadState, saveState, _setStatePath, OwnerSignalScheduler };

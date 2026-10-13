'use strict';

// trend-follow.js — 일봉 추세추종(롱만) 실전 실행기. 2026-10-13 오너 승인("전적으로 믿어볼게 하고싶은거 다 해").
// 규칙은 백테스트 server/backtest/trend.js 의 simulatePortfolio 와 같다(6.7년: 연 39% · 최대 낙폭 47.7%):
//   매일 UTC 00:00 직후(한국 09:05) 어제까지 끝난 일봉 종가로 20·50·100·150·200일 평균선 중 몇 개 위인지(k) 센다.
//   종목별 목표 노출 = 순자산 × allocPct% × (1/종목 수) × k/5. k 가 바뀌었거나 목표에서 (최대 노출 × bandPct%)
//   넘게 벗어났을 때만 시장가로 맞춘다. 롱만 한다(코인 숏은 6.7년 데이터에서 근거가 없었다).
//   보호 손절: 종목마다 하나, 평균 진입가 × (1 − stopPct%) — 당기기만 한다(재난용. 촘촘한 손절은 재진입 반복으로
//   오히려 낙폭을 키웠다). 정지 장치: 거래소 순자산이 고점 대비 breakerPct% 빠지면 전량 청산하고 멈춘다.
// 시세는 실제 시장 공개 데이터(fapi.binance.com, 읽기 전용), 주문은 BINANCE_FUTURES_BASE_URL(지금은 데모) 계좌.
// AI 단기 매매용 일·주·월 손실 한도와 1회 1% 철칙은 이 전략에 쓰지 않는다(docs/00-CEO-PLAN.md 2026-10-13).

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'reports', 'trend-state.json');
const FAPI_PUBLIC = 'https://fapi.binance.com';
const DAY = 86400000;

// 코드 잠금 — 설정(config.json 은 HTTP POST 로 바뀔 수 있다)으로는 이보다 느슨하게 못 한다.
const HARD = Object.freeze({
  symbols: Object.freeze(['BTCUSDT', 'ETHUSDT']),
  maxAllocPct: 100, // 레버리지 1배 — 순자산보다 많이 들지 않는다
  maxStopPct: 25, // 보호 손절은 평균 진입가 −25% 보다 멀 수 없다(손절 필수)
  maxBreakerPct: 60, // 고점 대비 −60% 면 무조건 정지
});

const DEFAULTS = Object.freeze({
  enabled: false,
  symbols: ['BTCUSDT', 'ETHUSDT'],
  smaLengths: [20, 50, 100, 150, 200],
  allocPct: 95, // 수수료·가격 변동 여유로 5% 는 비워 둔다
  stopPct: 25,
  bandPct: 20,
  breakerPct: 60,
  runAtKst: '09:05',
  maxNotionalUsdPerSymbol: 3000, // 절대 금액 상한(마지막 방어선). 실계좌 전환 때 같이 낮춘다
});

function effectiveParams(cfgTrend) {
  const c = cfgTrend && typeof cfgTrend === 'object' ? cfgTrend : {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const symbols = (Array.isArray(c.symbols) ? c.symbols : DEFAULTS.symbols)
    .map((s) => String(s).toUpperCase())
    .filter((s, i, a) => HARD.symbols.includes(s) && a.indexOf(s) === i);
  const lens = (Array.isArray(c.smaLengths) ? c.smaLengths : DEFAULTS.smaLengths)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 2 && n <= 400);
  const pos = (v, d) => (num(v) > 0 ? num(v) : d);
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(c.runAtKst || '')) ? String(c.runAtKst) : DEFAULTS.runAtKst;
  return {
    enabled: c.enabled === true,
    symbols: symbols.length ? symbols : [...HARD.symbols],
    smaLengths: lens.length ? lens : [...DEFAULTS.smaLengths],
    allocPct: Math.min(HARD.maxAllocPct, pos(c.allocPct, DEFAULTS.allocPct)),
    stopPct: Math.min(HARD.maxStopPct, Math.max(1, pos(c.stopPct, DEFAULTS.stopPct))),
    bandPct: Math.min(100, Math.max(1, pos(c.bandPct, DEFAULTS.bandPct))),
    breakerPct: Math.min(HARD.maxBreakerPct, Math.max(5, pos(c.breakerPct, DEFAULTS.breakerPct))),
    runAtKst: hhmm,
    maxNotionalUsdPerSymbol: num(c.maxNotionalUsdPerSymbol) >= 0 && c.maxNotionalUsdPerSymbol != null ? num(c.maxNotionalUsdPerSymbol) : DEFAULTS.maxNotionalUsdPerSymbol,
  };
}

// --- 순수 함수 -------------------------------------------------------------------

// 바이낸스 kline 배열 → 이미 끝난 봉의 종가 목록(시간순). 진행 중인 오늘 봉은 뺀다(미래를 보지 않는다).
function completedCloses(klines, now = Date.now()) {
  if (!Array.isArray(klines)) return [];
  return klines
    .map((k) => ({ t: Number(k[0]), c: Number(k[4]), ct: Number(k[6]) }))
    .filter((k) => Number.isFinite(k.t) && Number.isFinite(k.c) && k.c > 0 && Number.isFinite(k.ct) && k.ct < now)
    .sort((a, b) => a.t - b.t)
    .map((k) => k.c);
}

// 마지막 종가가 위에 있는 평균선 개수. 평균을 낼 만큼 봉이 없으면 그 평균선은 '아래'로 센다.
function countAbove(closes, lengths) {
  if (!Array.isArray(closes) || !closes.length) return 0;
  const last = closes[closes.length - 1];
  return lengths.filter((n) => {
    if (closes.length < n) return false;
    let s = 0;
    for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
    return last > s / n;
  }).length;
}

function floorStep(v, step) {
  const s = Number(step);
  if (!(s > 0)) return v;
  const decimals = Math.max(0, Math.min(12, Math.ceil(-Math.log10(s) - 1e-9)));
  return Number((Math.floor(v / s + 1e-9) * s).toFixed(decimals));
}

// 한 종목의 할 일. 반환 { action: 'none'|'open'|'add'|'reduce'|'close', qty, targetQty, targetUsd, fullUsd, reason }
function planSymbol({ k, n, equity, allocPct, weight, markPrice, currentQty, lastK, bandPct, filters, maxNotionalUsd }) {
  const f = filters || {};
  const mark = Number(markPrice);
  const cur = Number(currentQty) || 0;
  // 순자산을 모르면 목표를 계산할 수 없다 — 평균선이 전부 꺾였을 때의 전량 청산만 한다
  if (!(Number(equity) > 0)) {
    if (k === 0 && cur > 0) return { fullUsd: null, targetUsd: 0, targetQty: 0, action: 'close', qty: cur, reason: `평균선 위 0/${n} — 전량 청산(순자산 모름)` };
    return { fullUsd: null, targetUsd: null, targetQty: null, action: 'none', qty: 0, reason: '순자산을 못 읽어 맞추지 않음' };
  }
  let full = Number(equity) * (allocPct / 100) * weight;
  if (Number(maxNotionalUsd) > 0) full = Math.min(full, Number(maxNotionalUsd));
  const targetUsd = full * (k / n);
  const base = { fullUsd: round2(full), targetUsd: round2(targetUsd), targetQty: 0, qty: 0 };
  if (!(mark > 0) || !(full >= 0)) return { ...base, action: 'none', reason: '가격·순자산 없음' };
  const targetQty = floorStep(targetUsd / mark, f.qtyStep);
  base.targetQty = targetQty;
  const curUsd = cur * mark;
  const kChanged = lastK == null || Number(lastK) !== k;
  const drift = Math.abs(targetUsd - curUsd) > full * (bandPct / 100);
  if (targetQty <= 0 && cur > 0) return { ...base, action: 'close', qty: cur, reason: `평균선 위 ${k}/${n} — 전량 청산` };
  if (!kChanged && !drift) {
    const gap = full > 0 ? Math.round((Math.abs(targetUsd - curUsd) / full) * 1000) / 10 : 0;
    return { ...base, action: 'none', reason: `평균선 위 ${k}/${n} · 목표와 차이 ${gap}% (기준 ${bandPct}%)` };
  }
  const delta = floorStep(Math.abs(targetQty - cur), f.qtyStep) * Math.sign(targetQty - cur);
  if (!delta) return { ...base, action: 'none', reason: `평균선 위 ${k}/${n} — 맞출 수량 없음` };
  const tooSmall = (Number(f.minQty) > 0 && Math.abs(delta) < f.minQty) || (Number(f.minNotional) > 0 && Math.abs(delta) * mark < f.minNotional);
  if (tooSmall) return { ...base, action: 'none', reason: `최소 주문 미만(${round2(Math.abs(delta) * mark)} USDT) — 그대로 둠` };
  if (delta > 0) return { ...base, action: cur > 0 ? 'add' : 'open', qty: delta, reason: `평균선 위 ${k}/${n} — ${cur > 0 ? '추가 매수' : '신규 매수'}` };
  return { ...base, action: 'reduce', qty: -delta, reason: `평균선 위 ${k}/${n} — 줄임` };
}

function protectiveStop(avgEntry, stopPct) {
  const e = Number(avgEntry);
  return e > 0 ? e * (1 - stopPct / 100) : null;
}

function breakerCheck({ equity, peak, breakerPct }) {
  const e = Number(equity);
  const p = Number(peak);
  if (!(e > 0) || !(p > 0)) return { tripped: false, ddPct: null };
  const dd = (1 - e / p) * 100;
  return { tripped: dd >= breakerPct, ddPct: Math.round(dd * 10) / 10 };
}

function kstParts(now = new Date()) {
  const d = new Date((now instanceof Date ? now.getTime() : Number(now)) + 9 * 3600000);
  const p2 = (x) => String(x).padStart(2, '0');
  return { dateKey: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`, hhmm: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` };
}

function round2(x) {
  return Math.round(Number(x) * 100) / 100;
}

// 서버 재시작 점검(startup-audit)이 손절 없는 추세추종 포지션을 만났을 때 쓸 손절가 — 장부에 없는 포지션이라
// 이게 없으면 점검이 '원래 손절가를 몰라' 청산해 버린다.
function protectiveStopFor(pos, cfg) {
  const p = effectiveParams(cfg && cfg.trend);
  if (!p.enabled || !pos || String(pos.side).toUpperCase() !== 'LONG' || !p.symbols.includes(pos.symbol)) return null;
  return protectiveStop(pos.entry, p.stopPct);
}

function isTrendManaged(pos, cfg) {
  const p = effectiveParams(cfg && cfg.trend);
  return !!(p.enabled && pos && p.symbols.includes(pos.symbol) && String(pos.side).toUpperCase() === 'LONG');
}

// --- 상태 파일 --------------------------------------------------------------------

let _statePath = STATE_PATH;
function _setStatePath(p) {
  _statePath = p || STATE_PATH;
}
function _writesBlocked() {
  return !!process.env.NODE_TEST_CONTEXT && _statePath === STATE_PATH;
}
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

// --- 실행 -------------------------------------------------------------------------

async function fetchPublicJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 남아 있는 롱 포지션에 보호 손절이 있는지 확인하고, 없으면 걸고, 더 촘촘하게 당길 수 있으면 당긴다.
async function ensureStop({ ex, client, symbol, p, log }) {
  const pos = ex.summarizeOpenPosition(await client.getPosition(symbol));
  if (!pos || pos.side !== 'LONG') return { ok: true, none: true };
  const filters = await client.getSymbolFilters(symbol);
  const want = ex.roundStopToTick('LONG', protectiveStop(pos.entry, p.stopPct), filters && filters.priceStep);
  const algo = await client.getOpenAlgoOrders(symbol);
  const cur = ex.findExchangeStop(algo, 'LONG');
  if (cur == null) {
    const mark = (await client.getMarkPrice(symbol)).markPrice;
    if (ex.stopWouldTriggerNow('LONG', want, mark)) {
      // 이미 손절선 밑 — 손절을 걸 수 없으니(즉시 체결 거부) 바로 정리한다
      const r = await ex.closeExistingPosition({ symbol, side: 'LONG', quantity: pos.quantity }, client);
      log(`${symbol} 손절선(${want}) 밑이라 청산: ${r.ok ? '완료' : r.error}`);
      return { ok: r.ok, closed: true, error: r.error };
    }
    await client.placeStopLoss(symbol, 'SELL', want);
    log(`${symbol} 보호 손절 새로 걸음 @${want}`);
    return { ok: true, placed: want };
  }
  if (want > cur * 1.002) { // 0.2% 넘게 촘촘해질 때만(체결가 차이 같은 잔떨림에 손절을 다시 걸지 않는다)
    const r = await ex.updateStopLoss({ symbol, side: 'LONG', newStopPrice: want, previousStopPrice: cur, quantity: pos.quantity }, client);
    log(`${symbol} 보호 손절 ${cur} → ${want}: ${r.ok ? '완료' : r.kept ? '기존 유지' : r.error}`);
    return { ok: r.ok || !!r.kept, tightened: r.ok ? want : null, error: r.ok || r.kept ? null : r.error };
  }
  return { ok: true, kept: cur };
}

// 하루 한 번 실행. deps 는 테스트에서 가짜로 바꿔 끼운다.
// attempt: 그날 몇 번째 시도인지(스케줄러가 넘긴다). 오류 알림은 첫 시도와 마지막(6번째)에만 — 30분마다 같은 오류로 도배하지 않는다.
async function runTrendOnce({ cfg, exchangeMod, notifyMod, client, fetchJson = fetchPublicJson, now = Date.now(), state = loadState(), persist = saveState, attempt = null } = {}) {
  const p = effectiveParams(cfg && cfg.trend);
  const report = { ok: true, at: new Date(now).toISOString(), dateKey: kstParts(new Date(now)).dateKey, equity: null, peak: null, ddPct: null, symbols: [], errors: [], halted: null, logs: [] };
  const log = (s) => report.logs.push(s);
  if (!p.enabled) return { ...report, skipped: '추세추종 꺼짐' };
  const ex = exchangeMod;
  let c = client;
  if (!c) {
    try {
      c = ex.createClient({ apiKey: process.env.BINANCE_API_KEY, apiSecret: process.env.BINANCE_API_SECRET, baseUrl: process.env.BINANCE_FUTURES_BASE_URL });
    } catch (e) {
      return { ...report, ok: false, errors: [e.message] };
    }
  }

  // 순자산 — 못 읽으면 줄이거나 정리하는 것만 하고 늘리지는 않는다
  try {
    report.equity = ex.equityFromBalance(await c.getAccountBalance());
  } catch (e) {
    report.errors.push(`순자산 조회 실패: ${e.message}`);
  }
  const st = { ...state, lastK: { ...(state.lastK || {}) } };
  if (report.equity > 0) st.peak = Math.max(Number(st.peak) || 0, report.equity);
  report.peak = st.peak || null;
  const br = breakerCheck({ equity: report.equity, peak: st.peak, breakerPct: p.breakerPct });
  report.ddPct = br.ddPct;

  if (st.halted || br.tripped) {
    if (!st.halted) st.halted = { at: report.at, equity: report.equity, peak: st.peak, ddPct: br.ddPct };
    report.halted = st.halted;
    for (const symbol of p.symbols) {
      try {
        const pos = ex.summarizeOpenPosition(await c.getPosition(symbol));
        if (pos && pos.side === 'LONG') {
          const r = await ex.closeExistingPosition({ symbol, side: 'LONG', quantity: pos.quantity }, c);
          report.symbols.push({ symbol, action: 'close', qty: pos.quantity, ok: r.ok, reason: '정지 장치 — 전량 청산', error: r.error || null });
          if (!r.ok) report.errors.push(`${symbol} 정지 청산 실패: ${r.error}`);
        }
      } catch (e) {
        report.errors.push(`${symbol} 정지 청산 중 오류: ${e.message}`);
      }
    }
    report.ok = report.errors.length === 0;
    st.lastRun = { dateKey: report.dateKey, at: report.at, ok: report.ok, halted: true };
    persist(st);
    if (!state.halted || report.symbols.length || report.errors.length) await notify(notifyMod, report, cfg, p, true);
    return report;
  }

  const weight = 1 / p.symbols.length;
  for (const symbol of p.symbols) {
    const row = { symbol, k: null, n: p.smaLengths.length, action: 'none', qty: 0, ok: true, reason: '', error: null };
    report.symbols.push(row);
    try {
      const pos = ex.summarizeOpenPosition(await c.getPosition(symbol));
      if (pos && pos.side === 'SHORT') {
        row.reason = '숏 포지션이 있어 건드리지 않음(추세추종은 롱만)';
        row.foreign = !(state.foreign && state.foreign[symbol]); // 처음 봤을 때만 알린다
        st.foreign = { ...(st.foreign || {}), [symbol]: report.dateKey };
        continue;
      }
      if (st.foreign && st.foreign[symbol]) {
        const { [symbol]: _gone, ...rest } = st.foreign;
        st.foreign = rest;
      }
      const closes = completedCloses(await fetchJson(`${FAPI_PUBLIC}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=260`), now);
      if (closes.length < Math.max(...p.smaLengths)) throw new Error(`일봉 부족(${closes.length}개)`);
      row.k = countAbove(closes, p.smaLengths);
      row.lastClose = closes[closes.length - 1];
      const mark = (await c.getMarkPrice(symbol)).markPrice;
      const filters = await c.getSymbolFilters(symbol);
      const plan = planSymbol({
        k: row.k, n: row.n, equity: report.equity, allocPct: p.allocPct, weight, markPrice: mark,
        currentQty: pos ? pos.quantity : 0, lastK: st.lastK[symbol], bandPct: p.bandPct, filters, maxNotionalUsd: p.maxNotionalUsdPerSymbol,
      });
      Object.assign(row, { action: plan.action, qty: plan.qty, targetUsd: plan.targetUsd, fullUsd: plan.fullUsd, reason: plan.reason, mark });
      if (!(report.equity > 0) && (plan.action === 'open' || plan.action === 'add')) {
        row.action = 'none';
        row.reason = '순자산을 못 읽어 늘리지 않음';
      }
      if (row.action === 'open') {
        const stopPrice = ex.roundStopToTick('LONG', protectiveStop(mark, p.stopPct), filters && filters.priceStep);
        const r = await ex.openPositionWithStop({ symbol, action: 'BUY', quantity: plan.qty, stopPrice }, c);
        if (!r.ok) throw new Error(r.error || '진입 실패');
        log(`${symbol} 신규 매수 ${plan.qty} · 손절 @${stopPrice}`);
      } else if (row.action === 'add') {
        await c.setLeverage(symbol); // 1배 고정 확인 — 실패하면 늘리지 않는다
        await c.placeMarketOrder(symbol, 'BUY', plan.qty, ex.makeClientOrderId('ptt'));
        log(`${symbol} 추가 매수 ${plan.qty}`);
      } else if (row.action === 'reduce') {
        await c.flattenPosition(symbol, 'SELL', plan.qty); // reduceOnly
        log(`${symbol} 줄임 ${plan.qty}`);
      } else if (row.action === 'close') {
        const r = await ex.closeExistingPosition({ symbol, side: 'LONG', quantity: plan.qty }, c);
        if (!r.ok) throw new Error(r.error || '청산 실패');
        log(`${symbol} 전량 청산 ${plan.qty}`);
      }
      // 남은 포지션의 보호 손절 확인(매일 — 거래가 없어도)
      const s = await ensureStop({ ex, client: c, symbol, p, log });
      if (!s.ok) throw new Error(s.error || '보호 손절 확인 실패');
      if (s.placed || s.tightened) row.stop = s.placed || s.tightened;
      else if (s.kept) row.stop = s.kept;
      st.lastK[symbol] = row.k; // 성공했을 때만 — 실패하면 다음 시도에서 다시 맞춘다
    } catch (e) {
      row.ok = false;
      row.error = e && e.message ? e.message : String(e);
      report.errors.push(`${symbol}: ${row.error}`);
    }
  }
  report.ok = report.errors.length === 0;
  st.lastRun = { dateKey: report.dateKey, at: report.at, ok: report.ok, equity: report.equity };
  st.history = [...(Array.isArray(st.history) ? st.history : []), { at: report.at, equity: report.equity, k: Object.fromEntries(report.symbols.map((r) => [r.symbol, r.k])), actions: report.symbols.filter((r) => r.action !== 'none').map((r) => `${r.symbol}:${r.action}`) }].slice(-90);
  persist(st);
  const errorWorthTelling = report.errors.length > 0 && (attempt == null || attempt === 1 || attempt >= 6);
  const changed = report.symbols.some((r) => r.action !== 'none' || r.foreign) || errorWorthTelling || !state.lastRun;
  if (changed) await notify(notifyMod, report, cfg, p, false);
  return report;
}

async function notify(notifyMod, report, cfg, p, halted) {
  if (!notifyMod || typeof notifyMod.sendExecutionEvent !== 'function') return;
  try {
    await notifyMod.sendExecutionEvent({ ok: report.ok, trendRun: { ...report, params: { allocPct: p.allocPct, stopPct: p.stopPct, breakerPct: p.breakerPct }, halted: halted ? report.halted : null } }, cfg);
  } catch (_) {
    /* 알림 실패는 거래와 무관 */
  }
}

// 하루 한 번(한국 runAtKst 이후) 실행. 실패하면 30분 뒤 다시(하루 6번까지).
class TrendScheduler {
  constructor({ loadConfig, exchangeMod, notifyMod, intervalMs = 60000, runFn = runTrendOnce } = {}) {
    this.loadConfig = loadConfig;
    this.exchangeMod = exchangeMod;
    this.notifyMod = notifyMod;
    this.intervalMs = intervalMs;
    this.runFn = runFn;
    this._timer = null;
    this._running = false;
    this._attempts = { dateKey: null, n: 0, lastAt: 0 };
  }
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick().catch((e) => console.error('[trend]', e && e.message ? e.message : e)), this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }
  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
  async _tick(now = new Date()) {
    if (this._running || typeof this.loadConfig !== 'function') return null;
    const cfg = this.loadConfig();
    const p = effectiveParams(cfg && cfg.trend);
    if (!p.enabled) return null;
    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET || !process.env.BINANCE_FUTURES_BASE_URL) return null;
    const { dateKey, hhmm } = kstParts(now);
    if (hhmm < p.runAtKst) return null;
    const st = loadState();
    if (st.lastRun && st.lastRun.dateKey === dateKey && st.lastRun.ok) return null;
    if (this._attempts.dateKey !== dateKey) this._attempts = { dateKey, n: 0, lastAt: 0 };
    if (this._attempts.n >= 6 || now.getTime() - this._attempts.lastAt < 30 * 60000) return null;
    this._attempts.n += 1;
    this._attempts.lastAt = now.getTime();
    this._running = true;
    try {
      const r = await this.runFn({ cfg, exchangeMod: this.exchangeMod, notifyMod: this.notifyMod, now: now.getTime(), state: st, attempt: this._attempts.n });
      console.log(`[trend] ${dateKey} ${r.ok ? '완료' : '오류'}: ${r.symbols.map((s) => `${s.symbol} ${s.k ?? '-'}/${s.n} ${s.action}`).join(' · ')}${r.errors.length ? ' · ' + r.errors.join(' / ') : ''}`);
      return r;
    } finally {
      this._running = false;
    }
  }
}

module.exports = {
  HARD,
  DEFAULTS,
  STATE_PATH,
  effectiveParams,
  completedCloses,
  countAbove,
  floorStep,
  planSymbol,
  protectiveStop,
  protectiveStopFor,
  isTrendManaged,
  breakerCheck,
  kstParts,
  loadState,
  saveState,
  _setStatePath,
  ensureStop,
  runTrendOnce,
  TrendScheduler,
};

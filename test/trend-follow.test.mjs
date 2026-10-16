import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const TF = require('../server/trend-follow.js');
const EX = require('../server/exchange.js');

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 14, 0, 6); // 한국 09:06

// 이미 끝난 일봉 n 개 + 진행 중인 오늘 봉 하나. dir 'up' 이면 꾸준히 오르고 'down' 이면 내린다.
function klines(n, dir, last = 100, today = Date.UTC(2026, 9, 14)) {
  const out = [];
  for (let i = n; i >= 1; i--) {
    const t = today - i * DAY;
    const c = dir === 'up' ? last * (1 - i * 0.002) : last * (1 + i * 0.002);
    out.push([t, c, c, c, c, 1, t + DAY - 1]);
  }
  out.push([today, last, last, last, last * 0.5, 1, today + DAY - 1]); // 오늘 봉(진행 중) — 종가가 이상해도 무시돼야 한다
  return out;
}

function fakeClient({ equity = 5000, marks = { BTCUSDT: 100000, ETHUSDT: 4000 }, positions = {}, stops = {}, balanceFails = false } = {}) {
  const st = { positions: JSON.parse(JSON.stringify(positions)), stops: { ...stops }, orders: [] };
  const fill = (symbol, signedQty) => {
    const p = st.positions[symbol] || { amt: 0, entry: 0 };
    const mark = marks[symbol];
    const newAmt = Math.round((p.amt + signedQty) * 1e8) / 1e8;
    if (signedQty > 0 && p.amt >= 0) p.entry = (p.entry * p.amt + mark * signedQty) / newAmt;
    p.amt = newAmt;
    if (Math.abs(p.amt) < 1e-9) delete st.positions[symbol];
    else st.positions[symbol] = p;
  };
  return {
    st,
    getAccountBalance: async () => {
      if (balanceFails) throw new Error('잔고 조회 실패');
      return [{ asset: 'USDT', balance: String(equity), crossUnPnl: '0' }];
    },
    getPosition: async (symbol) => {
      const p = st.positions[symbol];
      return [{ symbol, positionAmt: String(p ? p.amt : 0), entryPrice: String(p ? p.entry : 0), markPrice: String(marks[symbol]), unRealizedProfit: '0' }];
    },
    getMarkPrice: async (symbol) => ({ markPrice: marks[symbol] }),
    getSymbolFilters: async (symbol) => ({ symbol, qtyStep: 0.001, priceStep: 0.1, minQty: 0.001, minNotional: 100 }),
    setLeverage: async () => ({ leverage: 1 }),
    placeMarketOrder: async (symbol, side, qty) => {
      st.orders.push({ symbol, side, qty, kind: 'market' });
      fill(symbol, side === 'BUY' ? qty : -qty);
      return { executedQty: String(qty) };
    },
    flattenPosition: async (symbol, side, qty) => {
      st.orders.push({ symbol, side, qty, kind: 'reduce' });
      fill(symbol, side === 'BUY' ? qty : -qty);
      return { executedQty: String(qty) };
    },
    placeStopLoss: async (symbol, side, trigger) => {
      st.stops[symbol] = Number(trigger);
      return { algoId: 1 };
    },
    getOpenAlgoOrders: async (symbol) =>
      st.stops[symbol] ? [{ symbol, orderType: 'STOP_MARKET', side: 'SELL', triggerPrice: String(st.stops[symbol]), algoStatus: 'NEW' }] : [],
    cancelAllAlgoOrders: async (symbol) => {
      delete st.stops[symbol];
      return {};
    },
  };
}

const cfgOn = { trend: { enabled: true } };
const up = async () => klines(240, 'up');
const upNextDay = async () => klines(240, 'up', 100, Date.UTC(2026, 9, 15));
const down = async () => klines(240, 'down');

// --- 설정 잠금 ------------------------------------------------------------------

test('effectiveParams: 코드 상한보다 느슨하게 못 한다(비중 100 · 손절 25 · 정지 60), 종목은 BTC·ETH 만', () => {
  const p = TF.effectiveParams({ enabled: true, allocPct: 300, stopPct: 80, breakerPct: 95, symbols: ['BTCUSDT', 'SOLUSDT', 'btcusdt'] });
  assert.equal(p.allocPct, 100);
  assert.equal(p.stopPct, 25);
  assert.equal(p.breakerPct, 60);
  assert.deepEqual(p.symbols, ['BTCUSDT']);
  const d = TF.effectiveParams({});
  assert.equal(d.enabled, false, 'true 로 명시해야만 켜진다');
  assert.equal(d.allocPct, 95);
  assert.deepEqual(d.smaLengths, [20, 50, 100, 150, 200]);
  assert.equal(TF.effectiveParams({ enabled: 'yes' }).enabled, false);
  assert.equal(TF.effectiveParams({ runAtKst: '25:00' }).runAtKst, '09:05');
  assert.ok(Object.isFrozen(TF.HARD));
});

// --- 순수 함수 --------------------------------------------------------------------

test('completedCloses: 진행 중인 오늘 봉은 뺀다', () => {
  const k = klines(3, 'up');
  const c = TF.completedCloses(k, NOW);
  assert.equal(c.length, 3);
  assert.ok(c.every((x) => x > 90 && x < 101), '오늘 봉의 이상한 종가(50)는 안 들어간다');
});

test('countAbove: 마지막 종가가 위에 있는 평균선 개수, 봉이 모자란 평균선은 아래로 센다', () => {
  assert.equal(TF.countAbove([1, 2, 3, 4, 5], [2, 3, 10]), 2);
  assert.equal(TF.countAbove([5, 4, 3, 2, 1], [2, 3]), 0);
  assert.equal(TF.countAbove([], [2]), 0);
});

test('planSymbol: 신규·추가·줄임·청산·그대로, 최소 주문 미만은 그대로', () => {
  const base = { n: 5, equity: 10000, allocPct: 100, weight: 0.5, markPrice: 100, bandPct: 20, filters: { qtyStep: 0.01, minQty: 0.01, minNotional: 100 }, maxNotionalUsd: 0 };
  const open = TF.planSymbol({ ...base, k: 2, currentQty: 0, lastK: null });
  assert.equal(open.action, 'open');
  assert.equal(open.qty, 20); // 10000 × 0.5 × 2/5 / 100
  const add = TF.planSymbol({ ...base, k: 4, currentQty: 20, lastK: 2 });
  assert.equal(add.action, 'add');
  assert.equal(add.qty, 20);
  const red = TF.planSymbol({ ...base, k: 1, currentQty: 40, lastK: 4 });
  assert.equal(red.action, 'reduce');
  assert.equal(red.qty, 30);
  const close = TF.planSymbol({ ...base, k: 0, currentQty: 10, lastK: 1 });
  assert.equal(close.action, 'close');
  assert.equal(close.qty, 10);
  const same = TF.planSymbol({ ...base, k: 2, currentQty: 19, lastK: 2 });
  assert.equal(same.action, 'none', 'k 그대로 · 차이 2% < 20%');
  const drift = TF.planSymbol({ ...base, k: 2, currentQty: 5, lastK: 2 });
  assert.equal(drift.action, 'add', '목표에서 30% 벗어나면 맞춘다');
  const tiny = TF.planSymbol({ ...base, equity: 300, k: 1, currentQty: 0, lastK: 0 });
  assert.equal(tiny.action, 'none');
  assert.match(tiny.reason, /최소 주문 미만/);
});

test('planSymbol: 순자산을 모르면 늘리지 않고, 평균선이 다 꺾였을 때 청산만 한다', () => {
  const base = { n: 5, equity: null, allocPct: 100, weight: 0.5, markPrice: 100, bandPct: 20, filters: { qtyStep: 0.01 }, currentQty: 10 };
  assert.equal(TF.planSymbol({ ...base, k: 3, lastK: 1 }).action, 'none');
  assert.equal(TF.planSymbol({ ...base, k: 0, lastK: 1 }).action, 'close');
});

test('planSymbol: 종목당 절대 금액 상한', () => {
  const p = TF.planSymbol({ k: 5, n: 5, equity: 100000, allocPct: 100, weight: 0.5, markPrice: 100, currentQty: 0, lastK: null, bandPct: 20, filters: { qtyStep: 1 }, maxNotionalUsd: 3000 });
  assert.equal(p.qty, 30);
});

test('breakerCheck · protectiveStop · kstParts', () => {
  assert.deepEqual(TF.breakerCheck({ equity: 40, peak: 100, breakerPct: 60 }), { tripped: true, ddPct: 60 });
  assert.equal(TF.breakerCheck({ equity: 41, peak: 100, breakerPct: 60 }).tripped, false);
  assert.equal(TF.breakerCheck({ equity: null, peak: 100, breakerPct: 60 }).tripped, false);
  assert.equal(TF.protectiveStop(100, 25), 75);
  assert.deepEqual(TF.kstParts(new Date(NOW)), { dateKey: '2026-10-14', hhmm: '09:06' });
});

test('protectiveStopFor · isTrendManaged: 켜져 있고 BTC·ETH 롱일 때만', () => {
  const pos = { symbol: 'BTCUSDT', side: 'LONG', entry: 80000 };
  assert.equal(TF.protectiveStopFor(pos, cfgOn), 60000);
  assert.equal(TF.protectiveStopFor(pos, { trend: { enabled: false } }), null);
  assert.equal(TF.protectiveStopFor({ ...pos, side: 'SHORT' }, cfgOn), null);
  assert.equal(TF.protectiveStopFor({ ...pos, symbol: 'SOLUSDT' }, cfgOn), null);
  assert.equal(TF.isTrendManaged(pos, cfgOn), true);
  assert.equal(TF.isTrendManaged(pos, {}), false);
});

// --- 실행(가짜 거래소 + 실제 exchange.js 오케스트레이션) ------------------------------------

test('runTrendOnce: 오르는 장, 첫 실행 — 두 종목 다 순자산 × 95% × 1/2 만큼 사고 −25% 재난 손절을 건다', async () => {
  const c = fakeClient();
  const sent = [];
  let saved = null;
  const r = await TF.runTrendOnce({ cfg: cfgOn, exchangeMod: EX, client: c, fetchJson: up, now: NOW, state: {}, persist: (s) => (saved = s), notifyMod: { sendExecutionEvent: async (e) => sent.push(e) } });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(c.st.positions.BTCUSDT.amt, 0.023); // 5000 × 0.95 × 0.5 / 100000 = 0.02375 → 0.023
  assert.equal(c.st.positions.ETHUSDT.amt, 0.593);
  assert.equal(c.st.stops.BTCUSDT, 75000);
  assert.equal(c.st.stops.ETHUSDT, 3000);
  assert.deepEqual(saved.lastK, { BTCUSDT: 5, ETHUSDT: 5 });
  assert.equal(saved.peak, 5000);
  assert.equal(saved.lastRun.ok, true);
  assert.equal(sent.length, 1, '첫 실행은 알린다');
  const html = require('../server/notify.js').buildExecutionHtml(sent[0]);
  assert.match(html, /추세추종 오늘 점검/);
  assert.match(html, /BTC 평균선 위 5\/5 → 신규 매수 0\.023/);
});

test('runTrendOnce: 다음 날 그대로면 주문도 알림도 없다', async () => {
  const c = fakeClient({ positions: { BTCUSDT: { amt: 0.023, entry: 100000 }, ETHUSDT: { amt: 0.593, entry: 4000 } }, stops: { BTCUSDT: 75000, ETHUSDT: 3000 } });
  const sent = [];
  const state = { lastK: { BTCUSDT: 5, ETHUSDT: 5 }, peak: 5000, lastRun: { dateKey: '2026-10-13', ok: true } };
  const r = await TF.runTrendOnce({ cfg: cfgOn, exchangeMod: EX, client: c, fetchJson: up, now: NOW, state, persist: () => {}, notifyMod: { sendExecutionEvent: async (e) => sent.push(e) } });
  assert.equal(r.ok, true);
  assert.equal(c.st.orders.length, 0);
  assert.equal(sent.length, 0);
});

test('runTrendOnce: 평균선이 다 꺾이면 전량 청산하고 손절도 지운다', async () => {
  const c = fakeClient({ positions: { BTCUSDT: { amt: 0.023, entry: 100000 }, ETHUSDT: { amt: 0.593, entry: 4000 } }, stops: { BTCUSDT: 75000, ETHUSDT: 3000 } });
  let saved = null;
  const r = await TF.runTrendOnce({ cfg: cfgOn, exchangeMod: EX, client: c, fetchJson: down, now: NOW, state: { lastK: { BTCUSDT: 5, ETHUSDT: 5 }, peak: 5000, lastRun: {} }, persist: (s) => (saved = s) });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(c.st.positions.BTCUSDT, undefined);
  assert.equal(c.st.positions.ETHUSDT, undefined);
  assert.equal(c.st.stops.BTCUSDT, undefined);
  assert.deepEqual(saved.lastK, { BTCUSDT: 0, ETHUSDT: 0 });
});

test('runTrendOnce: 순자산이 고점 대비 −60% 면 전량 청산·정지, 다음 날엔 사지 않고 조용하다', async () => {
  const c = fakeClient({ equity: 1900, positions: { BTCUSDT: { amt: 0.01, entry: 100000 } }, stops: { BTCUSDT: 75000 } });
  const sent = [];
  let saved = null;
  const r = await TF.runTrendOnce({ cfg: cfgOn, exchangeMod: EX, client: c, fetchJson: up, now: NOW, state: { peak: 5000, lastRun: {} }, persist: (s) => (saved = s), notifyMod: { sendExecutionEvent: async (e) => sent.push(e) } });
  assert.ok(r.halted);
  assert.equal(r.halted.ddPct, 62);
  assert.equal(c.st.positions.BTCUSDT, undefined);
  assert.equal(sent.length, 1);
  assert.match(require('../server/notify.js').buildExecutionHtml(sent[0]), /정지 장치 작동/);
  // 다음 날: 오르는 장이어도 사지 않는다
  const c2 = fakeClient({ equity: 1900 });
  const sent2 = [];
  await TF.runTrendOnce({ cfg: cfgOn, exchangeMod: EX, client: c2, fetchJson: upNextDay, now: NOW + DAY, state: saved, persist: () => {}, notifyMod: { sendExecutionEvent: async (e) => sent2.push(e) } });
  assert.equal(c2.st.orders.length, 0);
  assert.equal(sent2.length, 0);
});

test('runTrendOnce: 숏 포지션(예전 AI 것)이 있는 종목은 건드리지 않고 처음 한 번만 알린다', async () => {
  const c = fakeClient({ positions: { BTCUSDT: { amt: -0.012, entry: 83000 } } });
  const sent = [];
  let saved = null;
  await TF.runTrendOnce({ cfg: cfgOn, exchangeMod: EX, client: c, fetchJson: up, now: NOW, state: { lastRun: {} }, persist: (s) => (saved = s), notifyMod: { sendExecutionEvent: async (e) => sent.push(e) } });
  assert.equal(c.st.positions.BTCUSDT.amt, -0.012);
  assert.ok(c.st.positions.ETHUSDT, 'ETH 는 정상 진행');
  assert.equal(sent.length, 1);
  const sent2 = [];
  await TF.runTrendOnce({ cfg: cfgOn, exchangeMod: EX, client: c, fetchJson: upNextDay, now: NOW + DAY, state: saved, persist: () => {}, notifyMod: { sendExecutionEvent: async (e) => sent2.push(e) } });
  assert.equal(sent2.length, 0, '같은 숏이면 다시 안 알린다');
});

test('runTrendOnce: 잔고를 못 읽으면 새로 사지 않는다', async () => {
  const c = fakeClient({ balanceFails: true });
  const r = await TF.runTrendOnce({ cfg: cfgOn, exchangeMod: EX, client: c, fetchJson: up, now: NOW, state: {}, persist: () => {} });
  assert.equal(c.st.orders.length, 0);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /순자산 조회 실패/);
});

test('runTrendOnce: 손절이 빠진 포지션은 평균 진입가 −25% 로 다시 건다', async () => {
  const c = fakeClient({ positions: { BTCUSDT: { amt: 0.023, entry: 96000 }, ETHUSDT: { amt: 0.593, entry: 4000 } }, stops: { ETHUSDT: 3000 } });
  const r = await TF.runTrendOnce({ cfg: cfgOn, exchangeMod: EX, client: c, fetchJson: up, now: NOW, state: { lastK: { BTCUSDT: 5, ETHUSDT: 5 }, peak: 5000, lastRun: {} }, persist: () => {} });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(c.st.stops.BTCUSDT, 72000);
});

test('runTrendOnce: 꺼져 있으면 아무것도 안 한다', async () => {
  const c = fakeClient();
  const r = await TF.runTrendOnce({ cfg: { trend: { enabled: false } }, exchangeMod: EX, client: c, fetchJson: up, now: NOW, state: {}, persist: () => {} });
  assert.equal(r.skipped, '추세추종 꺼짐');
  assert.equal(c.st.orders.length, 0);
});

// --- 스케줄러 ---------------------------------------------------------------------

test('TrendScheduler: 한국 09:05 이후 하루 한 번, 실패하면 30분 뒤 다시(하루 6번까지)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trend-'));
  TF._setStatePath(path.join(dir, 'state.json'));
  const env = { ...process.env };
  process.env.BINANCE_API_KEY = 'k';
  process.env.BINANCE_API_SECRET = 's';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  try {
    let calls = 0;
    let fail = true;
    const runFn = async ({ now }) => {
      calls += 1;
      const ok = !fail;
      TF.saveState({ lastRun: { dateKey: TF.kstParts(new Date(now)).dateKey, ok } });
      return { ok, symbols: [], errors: ok ? [] : ['x'] };
    };
    const s = new TF.TrendScheduler({ loadConfig: () => cfgOn, runFn });
    assert.equal(await s._tick(new Date(Date.UTC(2026, 9, 14, 0, 0))), null, '한국 09:00 — 아직');
    await s._tick(new Date(Date.UTC(2026, 9, 14, 0, 6)));
    assert.equal(calls, 1);
    await s._tick(new Date(Date.UTC(2026, 9, 14, 0, 20)));
    assert.equal(calls, 1, '30분 안에는 다시 안 한다');
    fail = false;
    await s._tick(new Date(Date.UTC(2026, 9, 14, 0, 37)));
    assert.equal(calls, 2);
    await s._tick(new Date(Date.UTC(2026, 9, 14, 3, 0)));
    assert.equal(calls, 2, '성공한 날은 끝');
    await s._tick(new Date(Date.UTC(2026, 9, 15, 0, 6)));
    assert.equal(calls, 3, '다음 날 다시');
  } finally {
    TF._setStatePath(null);
    for (const k of ['BINANCE_API_KEY', 'BINANCE_API_SECRET', 'BINANCE_FUTURES_BASE_URL']) {
      if (env[k] == null) delete process.env[k];
      else process.env[k] = env[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveState: 테스트 중엔 실제 reports/trend-state.json 에 쓰지 않는다', () => {
  TF._setStatePath(null);
  const before = fs.existsSync(TF.STATE_PATH) ? fs.readFileSync(TF.STATE_PATH, 'utf8') : null;
  TF.saveState({ x: 1 });
  const after = fs.existsSync(TF.STATE_PATH) ? fs.readFileSync(TF.STATE_PATH, 'utf8') : null;
  assert.equal(after, before);
});

test('runTrendOnce: 같은 날 다시 시도할 때 오류 알림은 첫 시도와 마지막(6번째)에만', async () => {
  const sentBy = {};
  for (const attempt of [1, 2, 5, 6]) {
    const sent = [];
    const c = fakeClient({ balanceFails: true });
    await TF.runTrendOnce({ cfg: cfgOn, exchangeMod: EX, client: c, fetchJson: up, now: NOW, state: { lastRun: {} }, persist: () => {}, attempt, notifyMod: { sendExecutionEvent: async (e) => sent.push(e) } });
    sentBy[attempt] = sent.length;
  }
  assert.deepEqual(sentBy, { 1: 1, 2: 0, 5: 0, 6: 1 });
});

test('runTrendOnce 입출금 반영: 출금은 손실이 아니다 — 고점을 출금만큼 내려 정지 장치가 오작동하지 않는다', async () => {
  const NOWX = NOW;
  const c = fakeClient({ equity: 1900, positions: { BTCUSDT: { amt: 0.01, entry: 100000 } }, stops: { BTCUSDT: 75000 } });
  c.getIncomeHistory = async () => [{ time: NOWX - 3600000, incomeType: 'TRANSFER', income: '-3000', asset: 'USDT' }];
  let saved = null;
  const r = await TF.runTrendOnce({ cfg: cfgOn, exchangeMod: EX, client: c, fetchJson: up, now: NOWX, state: { peak: 5000, flowCheckedAt: NOWX - DAY, lastRun: {} }, persist: (s) => (saved = s), notifyMod: { sendExecutionEvent: async () => {} } });
  assert.equal(r.halted, null, '3000 을 뺐을 뿐 — 5000 → 2000 고점에서 1900 은 −5%');
  assert.equal(r.flow, -3000);
  assert.equal(saved.peak, 2000);
  assert.equal(saved.flowCheckedAt, NOWX);
  assert.ok(c.st.positions.BTCUSDT, '청산하지 않는다');
});

test('runTrendOnce 입출금 반영: 입출금을 못 읽은 날 정지할 만큼 빠졌으면 판단을 미루고 늘리지 않는다(오류로 남겨 다시)', async () => {
  const c = fakeClient({ equity: 1900, positions: { BTCUSDT: { amt: 0.01, entry: 100000 } }, stops: { BTCUSDT: 75000 } });
  c.getIncomeHistory = async () => { throw new Error('timeout'); };
  const r = await TF.runTrendOnce({ cfg: cfgOn, exchangeMod: EX, client: c, fetchJson: up, now: NOW, state: { peak: 5000, flowCheckedAt: NOW - DAY, lastRun: {} }, persist: () => {}, notifyMod: { sendExecutionEvent: async () => {} } });
  assert.equal(r.halted, null);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /정지 판단을 미룸/.test(e)));
  assert.ok(c.st.orders.every((o) => o.side !== 'BUY'), '늘리지 않는다');
});

test('netTransfers: 입금 +, 출금 −, 구간 (from, to], USDT 만', () => {
  const recs = [
    { time: 10, incomeType: 'TRANSFER', income: '100', asset: 'USDT' },
    { time: 20, incomeType: 'REALIZED_PNL', income: '50', asset: 'USDT' },
    { time: 30, incomeType: 'TRANSFER', income: '-40', asset: 'USDT' },
    { time: 40, incomeType: 'TRANSFER', income: '-5', asset: 'BNB' },
  ];
  assert.equal(EX.netTransfers(recs), 60);
  assert.equal(EX.netTransfers(recs, 10, 40), -40);
});

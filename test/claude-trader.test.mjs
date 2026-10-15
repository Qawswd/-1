import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CT = require('../server/claude-trader.js');

const MIN = 60000;
const P = CT.effectiveParams({ enabled: true });
const fresh = () => ({ startT: 0, cash: 10000, positions: [], closed: [], decisions: [], rejections: 0, failures: 0, snapshots: [], runKeys: {}, lastMonitorAt: 0, ended: null });

test('validateActions: 손절 없는 진입·반대편 손절·1배 초과·잡주는 막고, 청산으로 생긴 여유는 쓴다', () => {
  const st = fresh();
  const marks = { BTCUSDT: 100000, ETHUSDT: 2500, NVDAUSDT: 180 };
  const r = CT.validateActions([
    { type: 'OPEN', symbol: 'BTCUSDT', side: 'LONG', sizePct: 60, stop: 95000, target: 110000, reason: 'a' },
    { type: 'OPEN', symbol: 'ETHUSDT', side: 'SHORT', sizePct: 50, stop: 2600 },
    { type: 'OPEN', symbol: 'NVDAUSDT', side: 'LONG', sizePct: 10 },
    { type: 'OPEN', symbol: 'DOGEUSDT', side: 'LONG', sizePct: 10, stop: 0.09 },
    { type: 'OPEN', symbol: 'NVDAUSDT', side: 'LONG', sizePct: 10, stop: 190 },
  ], { st, marks, p: P });
  assert.deepEqual(r.accepted.map((a) => a.symbol), ['BTCUSDT']);
  assert.deepEqual(r.rejected.map((x) => x.why), ['1배 넘음(이미 60% + 50%)', '손절 필수 — 현재가 반대편 0.3~25%', '허용 종목 아님', '손절 필수 — 현재가 반대편 0.3~25%']);
  // 열린 BTC 60% 를 닫고 같은 판단에서 ETH 숏 90% — 청산이 먼저라 된다
  CT.openPos(st, r.accepted[0], 100000, P, 1);
  const r2 = CT.validateActions([{ type: 'OPEN', symbol: 'ETHUSDT', side: 'SHORT', sizePct: 90, stop: 2700 }, { type: 'CLOSE', symbol: 'BTCUSDT' }], { st, marks, p: P });
  assert.deepEqual(r2.accepted.map((a) => a.type), ['CLOSE', 'OPEN']);
  const r3 = CT.validateActions([{ type: 'MOVE_STOP', symbol: 'BTCUSDT', stop: 90000 }, { type: 'MOVE_STOP', symbol: 'BTCUSDT', stop: 98000 }], { st, marks, p: P });
  assert.deepEqual(r3.accepted.map((a) => a.stop), [98000], '손절은 당기기만');
});

test('checkExit: 진입 전 봉은 보지 않고, 한 봉에 손절·익절이 다 있으면 손절 먼저, 갭이면 시가', () => {
  const pos = { side: 'LONG', stop: 95, target: 110, openedAt: 10 * MIN };
  const bar = (i, o, h, l, c) => ({ t: i * MIN, o, h, l, c });
  assert.equal(CT.checkExit(pos, [bar(9, 100, 100, 90, 95)]), null, '진입 전 봉');
  assert.deepEqual(CT.checkExit(pos, [bar(11, 100, 112, 94, 100)]), { why: '손절', price: 95, t: 11 * MIN });
  assert.deepEqual(CT.checkExit(pos, [bar(12, 93, 94, 92, 93)]), { why: '손절', price: 93, t: 12 * MIN });
  assert.deepEqual(CT.checkExit(pos, [bar(13, 100, 111, 99, 110)]), { why: '익절', price: 110, t: 13 * MIN });
  const short = { side: 'SHORT', stop: 105, target: 90, openedAt: 0 };
  assert.equal(CT.checkExit(short, [bar(1, 100, 104, 91, 100)]), null);
  assert.equal(CT.checkExit(short, [bar(2, 100, 106, 95, 100)]).why, '손절');
});

test('features · equityOf · returnSince', () => {
  const daily = Array.from({ length: 60 }, (_, i) => ({ t: i, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i }));
  const hourly = Array.from({ length: 48 }, (_, i) => ({ t: i, o: 150 + i * 0.1, h: 151, l: 149, c: 150 }));
  const f = CT.features(daily, hourly, 160);
  assert.equal(f.price, 160);
  assert.equal(f.days, 59);
  assert.ok(f.vsSma20 > 0 && f.vsSma200 === null);
  assert.equal(f.rsi14, 100);
  const st = fresh();
  st.positions.push({ symbol: 'BTCUSDT', side: 'SHORT', qty: 0.1, entry: 100000, lastMark: 100000 });
  assert.equal(CT.equityOf(st, { BTCUSDT: 90000 }), 11000);
  assert.equal(CT.returnSince([{ t: 1, equity: 100 }, { t: 5, equity: 110 }, { t: 9, equity: 121 }], 4), 10);
  assert.equal(CT.returnSince([{ t: 1, equity: 100 }], 0), null);
});

test('buildPrompt: 규칙·종목·출력 형식이 들어간다', () => {
  const txt = CT.buildPrompt({ now: Date.parse('2026-10-16T00:30:00Z'), feats: { BTCUSDT: { price: 1, days: 200 } }, funding: {}, st: fresh(), marks: {}, p: P });
  for (const k of ['1배', '손절(stop) 필수', 'BTCUSDT', '"actions"', 'WebSearch', '−15%']) assert.ok(txt.includes(k), k);
});

// 가짜 바이낸스: 마크가 · 펀딩 · 봉
function fakeMarket(box) {
  return async (url) => {
    const sym = (/symbol=([A-Z]+)/.exec(url) || [])[1];
    if (/premiumIndex/.test(url)) return { markPrice: String(box.mark[sym] || 100), lastFundingRate: '0.0001', nextFundingTime: box.nextFunding || 0 };
    if (/interval=1d/.test(url)) return Array.from({ length: 30 }, (_, i) => [i * 86400000, '100', '101', '99', String(100 + i)]);
    if (/interval=1h/.test(url)) return Array.from({ length: 48 }, (_, i) => [i * 3600000, '100', '101', '99', '100']);
    if (/interval=(1m|15m)/.test(url)) return box.candles || [];
    return {};
  };
}
const cli = (obj) => ({ stdout: JSON.stringify({ type: 'result', result: JSON.stringify(obj), total_cost_usd: 0.2 }), stderr: '', code: 0 });

test('runTraderOnce: 첫 틱에 판단해 진입 → 손절에 닿으면 실제 봉으로 청산 · 알림', async () => {
  const msgs = [];
  const box = { mark: { BTCUSDT: 100000 } };
  const T0 = Date.parse('2026-10-16T01:00:00Z'); // 한국 10:00
  const spawnFn = async () => cli({ view: '강세', actions: [{ type: 'OPEN', symbol: 'BTCUSDT', side: 'LONG', sizePct: 50, stop: 95000, target: null, reason: '추세' }] });
  const cfg = { claudeTrader: { enabled: true } };
  let r = await CT.runTraderOnce({ cfg, now: T0, fetchJson: fakeMarket(box), spawnFn, notify: async (m) => msgs.push(m) });
  assert.equal(r.state.positions.length, 1);
  assert.match(msgs[0], /Claude 진입/);
  assert.equal(r.state.snapshots.length, 1);
  // 같은 날 다시 불러도 판단은 한 번
  let calls = 0;
  r = await CT.runTraderOnce({ cfg, now: T0 + 6 * MIN, state: r.state, fetchJson: fakeMarket(box), spawnFn: async () => { calls++; return cli({ actions: [] }); } });
  assert.equal(calls, 0);
  // 1분봉 저가가 손절에 닿았다
  box.candles = [[T0 + 8 * MIN, '99000', '99500', '94000', '94500']];
  box.mark.BTCUSDT = 94500;
  r = await CT.runTraderOnce({ cfg, now: T0 + 12 * MIN, state: r.state, fetchJson: fakeMarket(box), spawnFn, notify: async (m) => msgs.push(m) });
  assert.equal(r.state.positions.length, 0);
  assert.equal(r.state.closed[0].why, '손절');
  assert.equal(r.state.closed[0].exit, 95000);
  assert.ok(r.state.cash < 10000 && r.state.cash > 9700, `5% 손실 × 50% + 비용 → ${r.state.cash}`);
  assert.match(msgs[msgs.length - 1], /Claude 손절/);
});

test('runTraderOnce: 판단 실패(한도)는 기록·알림만, 꺼져 있으면 아무것도 안 한다, −15% 면 경기 끝', async () => {
  const box = { mark: {} };
  const T0 = Date.parse('2026-10-16T01:00:00Z');
  const msgs = [];
  const limit = async () => ({ stdout: JSON.stringify({ type: 'result', is_error: true, api_error_status: 429, result: "You've hit your session limit" }), stderr: '', code: 0 });
  let r = await CT.runTraderOnce({ cfg: { claudeTrader: { enabled: true } }, now: T0, fetchJson: fakeMarket(box), spawnFn: limit, notify: async (m) => msgs.push(m) });
  assert.equal(r.state.failures, 1);
  assert.match(msgs[0], /사용량 한도/);
  assert.equal((await CT.runTraderOnce({ cfg: { claudeTrader: { enabled: false } }, now: T0 })).skipped, '꺼짐');
  const st = { ...r.state, cash: 8400 };
  r = await CT.runTraderOnce({ cfg: { claudeTrader: { enabled: true } }, now: T0 + 10 * MIN, state: st, fetchJson: fakeMarket(box), spawnFn: limit });
  assert.ok(r.state.ended && /손실 한도/.test(r.state.ended.reason));
});

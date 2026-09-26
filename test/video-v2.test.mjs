import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const V = require('../server/backtest/video-v2.js');
const BAR = 900000;
// 임펄스 16봉(+5%) → 수축 16봉(폭 좁고 거래량 낮음) → 돌파 봉(거래량 큼)
function scenario(breakUp = true) {
  const bars = [];
  let price = 100;
  for (let i = 0; i < 3; i++) bars.push({ t: i * BAR, o: price, h: price + 1, l: price - 1, c: price, v: 100 });
  for (let i = 0; i < 16; i++) { price += 0.33; bars.push({ t: bars.length * BAR, o: price, h: price + 0.5, l: price - 0.5, c: price, v: 100 }); }
  const top = price;
  for (let i = 0; i < 16; i++) bars.push({ t: bars.length * BAR, o: top, h: top + 0.3, l: top - 0.3, c: top, v: 40 });
  const c = breakUp ? top + 1 : top - 1;
  bars.push({ t: bars.length * BAR, o: top, h: Math.max(top, c) + 0.1, l: Math.min(top, c) - 0.1, c, v: 200 });
  for (let i = 0; i < 30; i++) bars.push({ t: bars.length * BAR, o: c, h: c + 0.2, l: c - 0.2, c, v: 50 });
  return bars;
}
test('signalAt: 임펄스 → 수축 → 거래량 실린 돌파에서만 신호, 방향·수축 고저 포함', () => {
  const bars = scenario(true);
  const i = 3 + 16 + 16;
  const s = V.signalAt(bars, i, V.DEFAULTS);
  assert.ok(s && s.side === 'LONG' && s.impulseDir === 'LONG');
  assert.ok(s.hi > s.lo);
  assert.equal(V.signalAt(bars, i - 1, V.DEFAULTS), null, '돌파 전에는 신호 없음');
  assert.equal(V.signalAt(bars, i, { ...V.DEFAULTS, breakVol: 5 }), null, '거래량 조건 미달이면 없음');
  assert.equal(V.signalAt(scenario(false), i, { ...V.DEFAULTS, mode: 'with-impulse' }), null, '임펄스 반대 돌파는 페넌트 모드에서 제외');
  assert.equal(V.signalAt(scenario(false), i, V.DEFAULTS).side, 'SHORT');
});
test('simulate: 손절은 수축 반대편(최소 minStopPct), 목표 rr 배, 시간 만료 종가', () => {
  const bars = scenario(true);
  const i = 35;
  const s = V.signalAt(bars, i, V.DEFAULTS);
  const tr = V.simulate(bars, i, s, { ...V.DEFAULTS, maxHoldBars: 5 });
  assert.equal(tr.reason, 'time');
  assert.ok(tr.stop < tr.entry && tr.target > tr.entry);
  assert.ok(Math.abs((tr.target - tr.entry) - 2 * (tr.entry - tr.stop)) < 1e-9);
});
test('runV2: 시나리오에서 거래 1건, 포지션 중 재신호 무시', () => {
  const r = V.runV2(scenario(true));
  assert.equal(r.trades.length, 1);
  assert.equal(r.signals, 1);
});

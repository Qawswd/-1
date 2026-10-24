import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const H = require('../server/hypotheses.js');

function bars(n, price = 100, range = 1) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ t: i * 900000, o: price, h: price + range / 2, l: price - range / 2, c: price, v: 1 });
  return out;
}

test('atr15m: 15분봉 15개 이상이면 최근 14봉 TR 평균, 부족하면 null', () => {
  assert.equal(H.atr15m(bars(10)), null);
  assert.ok(Math.abs(H.atr15m(bars(30, 100, 2)) - 2) < 1e-9);
  assert.equal(H.atr15m(null), null);
});

test('baseSymbol: BTCUSDT·btc-usdt·BTC 모두 BTC', () => {
  assert.equal(H.baseSymbol('BTCUSDT'), 'BTC');
  assert.equal(H.baseSymbol('btc-usdt'), 'BTC');
  assert.equal(H.baseSymbol('BTC'), 'BTC');
});

test('H1: BTC 2% 이상 급락 + 역추세 필터 통과 → 롱, 손절 1.5ATR 아래, 목표 2.5R 위, 24시간', () => {
  const r = H.evaluateHypotheses({ symbol: 'BTC', direction: 'down', movePct: -2.3, price: 84000, filters: { trend: true, reversal: true }, atr: 400 });
  const h1 = r.find((x) => x.id === 'H1');
  assert.equal(h1.applies, true);
  assert.equal(h1.side, 'LONG');
  assert.equal(h1.entry, 84000);
  assert.equal(h1.stop, 84000 - 600);
  assert.equal(h1.target, 84000 + 600 * 2.5);
  assert.equal(h1.maxHoldBars, 96);
  assert.equal(h1.reason, null);
});

test('H1: 급등·1.5% 미만·역추세 불통과·ETH 는 각각 다른 사유로 미적용', () => {
  const base = { symbol: 'BTC', direction: 'down', movePct: -2.3, price: 84000, filters: { trend: true, reversal: true }, atr: 400 };
  const pick = (inp) => H.evaluateHypotheses(inp).find((x) => x.id === 'H1');
  assert.match(pick({ ...base, direction: 'up', movePct: 2.3 }).reason, /방향 불일치/);
  assert.match(pick({ ...base, movePct: -1.6 }).reason, /변동 -1.60% < 2/);
  assert.match(pick({ ...base, filters: { trend: true, reversal: false } }).reason, /reversal 필터 불통과/);
  assert.match(pick({ ...base, symbol: 'ETH' }).reason, /대상 종목 아님/);
  assert.match(pick({ ...base, atr: null }).reason, /ATR 없음/);
  for (const x of H.evaluateHypotheses({ ...base, movePct: -1.6 })) if (!x.applies) assert.equal(x.side, null);
});

test('H2: ETH 2% 급변동 + 추세 동의 → 움직인 방향, 손절 2ATR, 목표 1.8R', () => {
  const up = H.evaluateHypotheses({ symbol: 'ETHUSDT', direction: 'up', movePct: 2.1, price: 2700, filters: { trend: true, reversal: false }, atr: 20 }).find((x) => x.id === 'H2');
  assert.equal(up.applies, true);
  assert.equal(up.side, 'LONG');
  assert.equal(up.stop, 2700 - 40);
  assert.equal(up.target, 2700 + 40 * 1.8);
  const down = H.evaluateHypotheses({ symbol: 'ETH', direction: 'down', movePct: -2.1, price: 2700, filters: { trend: true, reversal: false }, atr: 20 }).find((x) => x.id === 'H2');
  assert.equal(down.side, 'SHORT');
  assert.equal(down.stop, 2740);
});

test('M0: 전 종목 · 1.5% · 추세 또는 역추세 어느 쪽이든 통과 시 움직인 방향', () => {
  const r = H.evaluateHypotheses({ symbol: 'BTC', direction: 'up', movePct: 1.6, price: 100, filters: { trend: false, reversal: true }, atr: 1 }).find((x) => x.id === 'M0');
  assert.equal(r.applies, true);
  assert.equal(r.side, 'LONG');
  assert.equal(r.stop, 98.5);
  assert.equal(r.target, 100 + 1.5 * 1.8);
  assert.equal(r.maxHoldBars, 48);
  const none = H.evaluateHypotheses({ symbol: 'BTC', direction: 'up', movePct: 1.6, price: 100, filters: { trend: false, reversal: false }, atr: 1 }).find((x) => x.id === 'M0');
  assert.equal(none.applies, false);
});

test('evaluateHypotheses: 입력이 비어도 throw 하지 않고 전부 미적용', () => {
  const r = H.evaluateHypotheses({});
  assert.equal(r.length, H.HYPOTHESES.length);
  for (const x of r) assert.equal(x.applies, false);
  assert.doesNotThrow(() => H.evaluateHypotheses(null));
});

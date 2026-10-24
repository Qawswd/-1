import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const G = require('../server/backtest/ma-grid.js');

test('maSeries: SMA · EMA · SMMA(와일더) — 모자란 앞부분은 null', () => {
  const c = [1, 2, 3, 4, 5];
  assert.deepEqual(G.maSeries(c, 3, 'sma'), [null, null, 2, 3, 4]);
  const e = G.maSeries(c, 3, 'ema');
  assert.equal(e[2], 2);
  assert.equal(e[3], 3); // 2 + 0.5 × (4 − 2)
  const s = G.maSeries(c, 3, 'smma');
  assert.ok(Math.abs(s[3] - (2 + (4 - 2) / 3)) < 1e-12);
});

test('simulateLights: 두 선 모두 위면 다음 날 롱, 모두 아래면 숏(롱만이면 쉼), 비중이 바뀐 만큼 비용', () => {
  const up = Array.from({ length: 12 }, (_, i) => ({ t: i * 86400000, c: 100 + i }));
  const r = G.simulateLights(up, 2, 3, { cost: 0 });
  assert.ok(r.days.slice(3).every((d) => d.inMarket && d.ret > 0));
  const down = Array.from({ length: 12 }, (_, i) => ({ t: i * 86400000, c: 100 - i }));
  assert.ok(G.simulateLights(down, 2, 3, { cost: 0 }).days.slice(3).every((d) => d.ret > 0), '내리면 숏으로 번다');
  assert.ok(G.simulateLights(down, 2, 3, { cost: 0, longOnly: true }).days.every((d) => d.ret === 0), '롱만이면 쉰다');
  const withCost = G.simulateLights(up, 2, 3, { cost: 0.001 });
  assert.ok(Math.abs(withCost.days[1].ret - -0.001) < 1e-12, '처음 롱을 잡는 날 비용 0.1%');
});

test('simulateHold: 매일 가격만큼 · 첫날만 비용 · 코인은 펀딩을 낸다', () => {
  const bars = [{ t: 0, c: 100 }, { t: 86400000, c: 110 }, { t: 2 * 86400000, c: 99 }];
  const d = G.simulateHold(bars, { cost: 0.001, fundDay: new Map([[2 * 86400000, 0.0003]]) });
  assert.ok(Math.abs(d[0].ret - (0.1 - 0.001)) < 1e-12);
  assert.ok(Math.abs(d[1].ret - (-0.1 - 0.0003)) < 1e-12);
});

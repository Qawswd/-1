import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../server/backtest/round2.js');
const { pickTradfi, priceMatches } = require('../server/backtest/fetch-tradfi.js');

const DAY = 86400000;
const Q = 15 * 60000;
const T0 = Date.UTC(2024, 0, 1);
const bar = (i, o, h, l, c, step = Q) => ({ t: T0 + i * step, o, h, l, c, v: 1 });

test('underwater: 고점에서 다시 그 고점까지 가장 긴 날 수 · 끝까지 못 찾으면 지금까지', () => {
  const days = [{ t: T0, ret: 0 }, { t: T0 + DAY, ret: 0.1 }, { t: T0 + 2 * DAY, ret: -0.5 }, { t: T0 + 12 * DAY, ret: 1.2 }, { t: T0 + 13 * DAY, ret: -0.1 }, { t: T0 + 20 * DAY, ret: 0 }];
  const u = R.underwater(days);
  assert.equal(u.maxDays, 11, '1일 고점 → 12일 회복');
  assert.equal(u.nowDays, 8, '12일 고점 뒤 20일까지 아직 물림');
});

test('simulateDca: 떨어질 때마다 한 몫씩 사고 평균가 + tp 에서 전부 판다, 같은 칸에서 사고팔지 않는다', () => {
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 89, 90), bar(2, 90, 100, 90, 99), bar(3, 99, 99, 99, 99)];
  const r = R.simulateDca(bars, new Map(), { stepPct: 10, tpPct: 5, n: 2, taker: 0, maker: 0 });
  // 0.5 @100 + 0.5 @90 → 평균 94.74, 익절가 99.47 에 3번째 칸 고가 100 이 닿아 전부 판다 → 들인 돈 1 × 1.05
  const eq = [...r.eqByDay.values()].pop();
  assert.ok(Math.abs(eq - 1.05) < 1e-9, `순자산 ${eq}`);
  assert.equal(r.cycles, 2, '판 다음 칸에서 새 바퀴를 시작한다');
  const same = R.simulateDca([bar(0, 100, 120, 100, 110)], new Map(), { stepPct: 10, tpPct: 5, n: 2, taker: 0, maker: 0 });
  assert.equal(same.cycles, 1);
  const e = [...same.eqByDay.values()][0];
  assert.ok(Math.abs(e - (1 + 0.5 * 0.1)) < 1e-9, '산 칸에서는 익절하지 않는다(종가로 평가)');
});

test('simulateDca 두 배씩: 몫이 1·2·4… 로 커지고 다 써도 노출은 순자산 이하(1배)', () => {
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 100, 40, 40)];
  const r = R.simulateDca(bars, new Map(), { stepPct: 10, tpPct: 5, n: 3, doubling: true, taker: 0, maker: 0 });
  const eq = [...r.eqByDay.values()].pop();
  // 1/7 @100, 2/7 @90, 4/7 @81 → 40 에서 가치
  const want = (1 / 7) * 0.4 + (2 / 7) * (40 / 90) + (4 / 7) * (40 / 81);
  assert.ok(Math.abs(eq - want) < 1e-9, `${eq} vs ${want}`);
});

test('simulateGrid: 오르내리면 칸마다 차익, 손절 없이 들고 있다가 되돌아오면 판다', () => {
  const bars = [bar(0, 100, 100, 100, 100)];
  for (let i = 1; i <= 6; i++) bars.push(i % 2 ? bar(i, 100, 100, 97.9, 98) : bar(i, 98, 100.1, 98, 100));
  const r = R.simulateGrid(bars, new Map(), { spacingPct: 2, levels: 5, maker: 0 });
  assert.equal(r.fills, 3, '98 에서 세 번 산다');
  const eq = [...r.eqByDay.values()].pop();
  assert.ok(eq > 1 && eq < 1.02, `세 번 판 차익 ≈ 3 × 0.2 × 2.04% → ${eq}`);
});

test('simulateLongShort: 하락 추세면 숏으로 벌고, 숏은 펀딩을 받는다', () => {
  const daily = Array.from({ length: 30 }, (_, i) => { const p = 100 - i; return bar(i, p, p, p, p, DAY); });
  const days = R.simulateLongShort(daily, new Map(), { smaGrid: [3], cost: 0 });
  assert.ok(days.slice(5).every((d) => d.ret >= 0), '떨어지는 동안 숏 수익');
  const fund = new Map(daily.map((b) => [b.t, 0.001]));
  const withF = R.simulateLongShort(daily, fund, { smaGrid: [3], cost: 0 });
  assert.ok(withF[10].ret > days[10].ret, '숏은 양수 펀딩을 받는다');
});

test('pickTradfi · priceMatches: 미국 주식·ETF 만, 원자재·한국 주식·레버리지·모르는 것은 이유와 함께 뺀다', () => {
  const info = { symbols: [
    { symbol: 'TSLAUSDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING' },
    { symbol: 'XAUUSDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING' },
    { symbol: 'SOXLUSDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING' },
    { symbol: 'QNTXUSDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING' },
    { symbol: 'PAYPUSDT', contractType: 'TRADIFI_PERPETUAL', status: 'TRADING' },
    { symbol: 'BTCUSDT', contractType: 'PERPETUAL', status: 'TRADING' },
  ] };
  const r = pickTradfi(info);
  assert.deepEqual(r.map((x) => [x.base, x.yahoo]), [['TSLA', 'TSLA'], ['XAU', null], ['SOXL', null], ['QNTX', null], ['PAYP', 'PYPL']]);
  assert.equal(r[1].reason, '원자재');
  assert.equal(r[2].reason, '레버리지 ETF');
  assert.ok(priceMatches(100, 110));
  assert.ok(!priceMatches(100, 130));
  assert.ok(!priceMatches(0, 100));
});

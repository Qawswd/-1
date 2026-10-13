import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const T = require('../server/backtest/trend.js');

const DAY = 86400000;
const T0 = Date.UTC(2024, 0, 1);
const mk = (closes, opens) => closes.map((c, i) => ({ t: T0 + i * DAY, o: opens ? opens[i] : c, h: c, l: c, c, v: 1 }));
const close = (a, b) => Math.abs(a - b) < 1e-9;

test('simulateTrend: 종가가 평균 위로 마감한 다음 날 시가에 사고, 아래로 마감한 다음 날 시가에 판다', () => {
  // 평균 2일. d1 종가 11 > (10+11)/2 → d2 시가 진입. d3 종가 9 < (12+9)/2 → d4 시가 청산
  const daily = mk([10, 11, 12, 9, 9], [10, 11, 11.5, 12, 8.8]);
  const sim = T.simulateTrend(daily, [], { sma: 2, feePct: 0, slipPct: 0 });
  assert.equal(sim.days[0].ret, 0);
  assert.equal(sim.days[1].ret, 0, '신호가 난 날은 아직 안 들고 있다');
  assert.ok(close(sim.days[2].ret, 12 / 11.5 - 1), '진입일 = 시가→종가');
  assert.ok(close(sim.days[3].ret, 9 / 12 - 1), '보유일 = 전날 종가→종가');
  assert.ok(close(sim.days[4].ret, 8.8 / 9 - 1), '청산일 = 전날 종가→시가');
  assert.equal(sim.trades.length, 1);
  assert.equal(sim.trades[0].pct, Math.round(((12 / 11.5) * (9 / 12) * (8.8 / 9) - 1) * 10000) / 100);
});

test('simulateTrend: 수수료는 진입·청산 때, 펀딩은 들고 있을 때만(롱이 양수 펀딩을 낸다)', () => {
  const daily = mk([10, 11, 12, 13, 9, 9]); // d1 신호 → d2 진입, d3 보유
  const funding = [
    { t: T0 + 0 * DAY + 8 * 3600000, rate: 0.01 }, // 안 들고 있을 때 — 무시
    { t: T0 + 3 * DAY + 8 * 3600000, rate: 0.001 }, // 보유 중 — 낸다
  ];
  const sim = T.simulateTrend(daily, funding, { sma: 2, feePct: 0.05, slipPct: 0.02 });
  const side = 0.0007;
  assert.ok(close(sim.days[2].ret, (12 / 12) * (1 - side) - 1), '진입일 수수료');
  assert.ok(close(sim.days[3].ret, 13 / 12 - 1 - 0.001), '보유일 펀딩');
});

test('simulateTrend: 평균을 낼 만큼 봉이 쌓이기 전에는 들어가지 않는다', () => {
  const sim = T.simulateTrend(mk([1, 2, 3, 4]), [], { sma: 10 });
  assert.ok(sim.days.every((d) => d.ret === 0));
  assert.equal(sim.exposurePct, 0);
});

test('summarizeTrend: 복리 누적, 고점 대비 최대 낙폭, 비중을 줄이면 낙폭도 준다', () => {
  const days = [0.1, -0.2, 0.05].map((ret, i) => ({ t: T0 + i * DAY, ret }));
  const full = T.summarizeTrend(days);
  assert.equal(full.totalPct, Math.round((1.1 * 0.8 * 1.05 - 1) * 10000) / 100);
  assert.equal(full.maxDrawdownPct, 20);
  const half = T.summarizeTrend(days, { alloc: 0.5 });
  assert.equal(half.maxDrawdownPct, 10);
});

test('allocForDrawdown: 낙폭이 기준 이하가 되는 가장 큰 비중(5% 단위)', () => {
  const days = [0, -0.4, 0].map((ret, i) => ({ t: T0 + i * DAY, ret }));
  const fit = T.allocForDrawdown(days, 15);
  assert.equal(fit.alloc, 35);
  assert.ok(fit.maxDrawdownPct <= 15);
});

test('blendDays: 같은 날짜끼리 평균, 한쪽에만 있는 날은 뺀다', () => {
  const a = [{ t: 1, ret: 0.02 }, { t: 2, ret: 0 }];
  const b = [{ t: 1, ret: 0 }, { t: 3, ret: 0.5 }];
  assert.deepEqual(T.blendDays([a, b]), [{ t: 1, ret: 0.01 }]);
});

test('tradeStats: 거래 수·승률·PF', () => {
  assert.deepEqual(T.tradeStats([{ pct: 10 }, { pct: -5 }, { pct: -5 }]), { n: 3, winRate: 33.3, pf: 1 });
});

test('simulateTrend 손절: 보유 중 저가가 진입가 −X% 에 닿으면 그 가격에, 시가부터 밑이면(갭) 시가에 나간다', () => {
  // 평균 2일. d1 신호 → d2 시가 100 진입. d3 저가 94 → 5% 손절가 95 에 청산
  const daily = [
    { t: T0, o: 90, h: 90, l: 90, c: 90 },
    { t: T0 + DAY, o: 95, h: 100, l: 95, c: 100 },
    { t: T0 + 2 * DAY, o: 100, h: 102, l: 99, c: 101 },
    { t: T0 + 3 * DAY, o: 100, h: 100, l: 94, c: 96 },
  ];
  const sim = T.simulateTrend(daily, [], { sma: 2, feePct: 0, slipPct: 0, hardStopPct: 5 });
  assert.ok(close(sim.days[3].ret, 95 / 101 - 1));
  assert.equal(sim.trades.length, 1);
  assert.equal(sim.trades[0].stop, true);
  assert.equal(sim.trades[0].pct, -5);
  const gap = daily.map((b, i) => (i === 3 ? { ...b, o: 92, l: 90 } : b));
  const g = T.simulateTrend(gap, [], { sma: 2, feePct: 0, slipPct: 0, hardStopPct: 5 });
  assert.ok(close(g.days[3].ret, 92 / 101 - 1), '갭 하락이면 시가');
});

test('simulateTrend 손절: 진입한 날 바로 손절가에 닿으면 그날 수수료 두 번 내고 끝', () => {
  const daily = [
    { t: T0, o: 90, h: 90, l: 90, c: 90 },
    { t: T0 + DAY, o: 95, h: 100, l: 95, c: 100 },
    { t: T0 + 2 * DAY, o: 100, h: 100, l: 90, c: 99 },
  ];
  const sim = T.simulateTrend(daily, [], { sma: 2, feePct: 0.05, slipPct: 0.02, hardStopPct: 5 });
  assert.ok(close(sim.days[2].ret, 0.95 * 0.9993 * 0.9993 - 1));
  assert.equal(sim.trades[0].stop, true);
});

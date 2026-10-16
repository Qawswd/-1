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

// --- simulatePortfolio: 실제 운용 규칙(trend-follow.js 와 같은 정의) -------------------------
const bar = (i, o, h, l, c) => ({ t: T0 + i * DAY, o, h, l, c, v: 1 });
const line = (n, from, step) => Array.from({ length: n }, (_, i) => { const p = from + i * step; return bar(i, p, p, p, p); });

test('simulatePortfolio: 두 종목이 꾸준히 오르면 평균선 위 개수만큼 늘려 결국 순자산의 allocPct 까지 든다', () => {
  const A = { X: { daily: line(30, 100, 1) }, Y: { daily: line(30, 50, 0.5) } };
  const r = T.simulatePortfolio(A, { smaGrid: [2, 3], allocPct: 90, stopPct: 50, feePct: 0, slipPct: 0, breakerPct: 99 });
  assert.ok(r.maxGrossPct >= 89 && r.maxGrossPct <= 100, `노출 ${r.maxGrossPct}(사이 오른 만큼 조금 넘을 수 있다)`);
  assert.ok(r.days[r.days.length - 1].ret > 0);
  assert.equal(r.halted, null);
});

test('simulatePortfolio: 저가가 평균 진입가 −stopPct 에 닿으면 그 종목 전량 손절(갭이면 시가)', () => {
  const d = line(6, 100, 1); // 100..105 상승 → 진입
  d.push(bar(6, 104, 104, 80, 82)); // 장중 −20% 이상 급락
  const r = T.simulatePortfolio({ X: { daily: d } }, { smaGrid: [2], allocPct: 100, stopPct: 10, feePct: 0, slipPct: 0, breakerPct: 99 });
  assert.equal(r.stops, 1);
  // 손절가 = 평균 진입가(103, 3일째 시가) × 0.9 = 92.7 → 그날 손실은 92.7 기준
  const last = r.days[r.days.length - 1];
  assert.ok(Math.abs(last.ret - (92.7 / 104 - 1) * (104 / 104)) < 0.02, `ret ${last.ret}`);
});

test('simulatePortfolio: 순자산이 고점 대비 breakerPct 빠지면 전량 청산하고 그 뒤로 멈춘다', () => {
  const d = line(6, 100, 1); // 100..105 → 진입
  d.push(bar(6, 60, 60, 60, 60)); // 하루 만에 −43%
  for (let i = 7; i < 12; i++) d.push(bar(i, 60 + i, 60 + i, 60 + i, 60 + i)); // 다시 올라도
  const r = T.simulatePortfolio({ X: { daily: d } }, { smaGrid: [2], allocPct: 100, stopPct: 99, feePct: 0, slipPct: 0, breakerPct: 30, bandPct: 100 });
  assert.ok(r.halted, '정지해야 한다');
  assert.ok(r.halted.ddPct >= 30);
  const after = r.days.filter((x) => x.t > r.halted.t);
  assert.ok(after.length > 0 && after.every((x) => x.ret === 0), '정지 뒤엔 다시 사지 않는다');
});

test('simulatePortfolio: 손절은 당기기만 — 더 낮은 값에 추가 매수해 평균가가 내려가도 손절은 그대로', () => {
  // 평균선 3일, 비중 50%, 오차 1% 넘으면 맞춤. 110 에 진입(손절 99) → 106 에 조금 더 산다(평균 ≈109.9 → 그대로면 98.9)
  // 다음 날 저가 98.97: 손절이 99 로 남아 있으면 걸리고, 느슨해졌다면(98.9) 안 걸린다
  const d = [
    bar(0, 100, 100, 100, 100), bar(1, 100, 100, 100, 100), bar(2, 100, 100, 100, 100), bar(3, 110, 110, 110, 110),
    bar(4, 110, 110, 106, 106), bar(5, 106, 106, 98.97, 104),
  ];
  const r = T.simulatePortfolio({ X: { daily: d } }, { smaGrid: [3], allocPct: 50, stopPct: 10, feePct: 0, slipPct: 0, breakerPct: 99, bandPct: 1 });
  assert.equal(r.stops, 1);
});

// 변동성이 큰 상승(하루 +11.6% / −5% 번갈아, 연 약 160%)과 잔잔한 상승(하루 +1%)
const zig = (n) => Array.from({ length: n }, (_, i) => { const p = 100 * Math.pow(1.03, i) * (1 + 0.04 * (i % 2 ? -1 : 1)); return bar(i, p, p, p, p); });
const calm = (n) => Array.from({ length: n }, (_, i) => { const p = 100 * Math.pow(1.01, i) * (1 + 0.002 * (i % 2 ? -1 : 1)); return bar(i, p, p, p, p); });
const RESEARCH = { smaGrid: [10], allocPct: 100, stopPct: 99, feePct: 0, slipPct: 0, breakerPct: 99, bandPct: 100, volWin: 5 };

test('simulatePortfolio: 연구용 선택지를 안 주면 실제 운용 규칙과 똑같다(기본값 = 꺼짐)', () => {
  const A = { X: { daily: zig(30) }, Y: { daily: calm(30) } };
  const a = T.simulatePortfolio(A, RESEARCH);
  const b = T.simulatePortfolio(A, { ...RESEARCH, volTarget: null, weighting: 'equal' });
  assert.deepEqual(a.days, b.days);
  assert.ok(a.days.every((d) => d.expo >= 0 && d.expo <= 1.2), '날마다 종가 노출 비율(expo)을 남긴다');
});

test('simulatePortfolio volTarget: 변동성이 목표보다 크면 그 비율만큼 덜 든다(늘리지는 않는다)', () => {
  const A = { X: { daily: zig(30) } };
  const base = T.simulatePortfolio(A, RESEARCH);
  const vt = T.simulatePortfolio(A, { ...RESEARCH, volTarget: 0.3 });
  assert.ok(base.maxGrossPct > 90, `기본 노출 ${base.maxGrossPct}`);
  assert.ok(vt.maxGrossPct > 5 && vt.maxGrossPct < 40, `변동성 맞춤 노출 ${vt.maxGrossPct}`);
  const big = T.simulatePortfolio(A, { ...RESEARCH, volTarget: 100 });
  assert.equal(big.maxGrossPct, base.maxGrossPct, '목표가 실제보다 크면 1배 그대로');
});

test('simulatePortfolio weighting invVol: 변동성 낮은 종목에 더 큰 몫 — 변동성 큰 종목이 폭락해도 덜 잃는다', () => {
  const X = zig(25);
  const crash = X[24].c * 0.6;
  X.push(bar(25, crash, crash, crash, crash));
  const A = { X: { daily: X }, Y: { daily: calm(26) } };
  const eq = T.simulatePortfolio(A, RESEARCH);
  const iv = T.simulatePortfolio(A, { ...RESEARCH, weighting: 'invVol' });
  const lastEq = eq.days[eq.days.length - 1].ret;
  const lastIv = iv.days[iv.days.length - 1].ret;
  assert.ok(lastEq < -0.15, `같은 몫이면 약 절반이 −40% → ${lastEq}`);
  assert.ok(lastIv > -0.05, `위험 균등이면 X 몫이 작다 → ${lastIv}`);
});

test('simulatePortfolio: 쉬는 날(stale) 종목은 사고팔지 않고, 평균선 계산에도 넣지 않는다', () => {
  // X 는 매일, Y 는 이틀에 한 번만 거래(나머지는 쉬는 날 — 직전 종가로 채움)
  const X = line(12, 100, 1);
  const Y = [];
  let last = 50;
  for (let i = 0; i < 12; i++) {
    if (i % 2 === 0) { last = 50 + i; Y.push(bar(i, last, last, last, last)); }
    else Y.push({ ...bar(i, last, last, last, last), stale: true });
  }
  const r = T.simulatePortfolio({ X: { daily: X }, Y: { daily: Y } }, { smaGrid: [2], allocPct: 100, stopPct: 99, feePct: 0, slipPct: 0, breakerPct: 99, bandPct: 100 });
  // 쉬는 날을 평균선에 넣었다면 Y 의 종가가 평균과 같아져(직전 값 반복) 신호가 꺼졌다 켜졌다 하며 거래가 늘어난다
  assert.ok(r.trades <= 3, `거래 ${r.trades}`);
  const restDays = r.days.filter((d, i) => i % 2 === 1 && i > 3);
  assert.ok(restDays.length > 0);
});

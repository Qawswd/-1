import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../server/backtest/carry.js');

const H8 = 8 * 3600 * 1000;
const T0 = Date.UTC(2024, 0, 1);
const series = (rates, start = T0) => rates.map((rate, i) => ({ t: start + i * H8, rate }));

test('parseFundingCsv: 헤더·깨진 줄 건너뛰고 시간순·중복 제거', () => {
  const rows = C.parseFundingCsv('t,rate\n200,0.0002\nx,y\n100,0.0001\n200,0.0003\n');
  assert.deepEqual(rows, [{ t: 100, rate: 0.0001 }, { t: 200, rate: 0.0002 }]);
});

test('simulateCarry 항상 보유: 숏은 양수 펀딩을 받고, 자본은 명목의 2배라 수익은 절반', () => {
  const sim = C.simulateCarry(series([0.0001, 0.0001, -0.0001, 0.0002]), { mode: 'always' });
  // 첫 펀딩 직후 진입 → 그다음 3번 받음: (0.01 − 0.01 + 0.02)% / 2 = 0.01%
  const funding = sim.events.filter((e) => e.kind === 'funding').reduce((s, e) => s + e.pct, 0);
  assert.ok(Math.abs(funding - 0.01) < 1e-9);
  // 진입·끝 청산 비용: (0.10 + 0.05 + 0.04)% / 2 씩 두 번
  const cost = sim.events.filter((e) => e.kind === 'cost').reduce((s, e) => s + e.pct, 0);
  assert.ok(Math.abs(cost + 0.19) < 1e-9);
  assert.equal(sim.entries, 1);
});

test('simulateCarry 켜고끄기: 직전 평균만 보고(미래 안 봄) 들어가고, 평균이 떨어지면 나온다', () => {
  const rates = [0.0003, 0.0003, 0.0003, -0.0005, -0.0005, -0.0005, 0.0001, 0.0001, 0.0001];
  const sim = C.simulateCarry(series(rates), { mode: 'switch', lookbackEvents: 3, enterAvgPct: 0.02, exitAvgPct: 0 });
  // 3번째 펀딩 직후 직전 3회 평균 0.03% ≥ 0.02% → 진입, 4번째부터 받는다
  const firstFunding = sim.events.find((e) => e.kind === 'funding');
  assert.equal(firstFunding.t, T0 + 3 * H8);
  // 직전 3회 평균이 0 이하가 되는 첫 시점(5번째 펀딩 직후: 0.03, −0.05, −0.05 → 음수)에 청산
  const exits = sim.events.filter((e) => e.kind === 'cost');
  assert.equal(exits.length, 2);
  assert.equal(exits[1].t, T0 + 4 * H8);
  assert.equal(sim.entries, 1, '평균 0.01% 로는 다시 안 들어간다');
});

test('summarizeCarry: 포지션 없던 달도 0% 로 넣어 월평균을 부풀리지 않는다', () => {
  const jan = Date.UTC(2024, 0, 10);
  const apr = Date.UTC(2024, 3, 10);
  const s = C.summarizeCarry([
    { t: jan, kind: 'funding', pct: 1 },
    { t: apr, kind: 'funding', pct: 1 },
  ]);
  assert.equal(s.months, 4);
  assert.equal(s.monthlyAvgPct, 0.5);
  assert.equal(s.positiveMonthsPct, 50);
});

test('summarizeCarry: 최대 낙폭은 누적 곡선 고점 대비, 월PF 는 플러스 달 합 ÷ 마이너스 달 합', () => {
  const m = (mo, d) => Date.UTC(2024, mo, d);
  const s = C.summarizeCarry([
    { t: m(0, 1), kind: 'funding', pct: 2 },
    { t: m(1, 1), kind: 'funding', pct: -0.5 },
    { t: m(1, 2), kind: 'funding', pct: -0.5 },
    { t: m(2, 1), kind: 'funding', pct: 1 },
  ]);
  assert.equal(s.maxDrawdownPct, 1);
  assert.equal(s.monthlyPF, 3);
  assert.equal(s.worstMonthPct, -1);
  assert.equal(s.byYear['2024'], 2);
});

test('maxRiseWithin: 종가 기준(마크가격 근사) — 순간 꼬리는 세지 않는다', () => {
  const D = 86400000;
  const daily = [
    { t: 0, o: 100, h: 100, l: 100, c: 100 },
    { t: D, o: 100, h: 300, l: 99, c: 110 }, // 꼬리 300 — 청산은 마크가격이라 무시
    { t: 2 * D, o: 110, h: 121, l: 110, c: 120 },
  ];
  assert.equal(C.maxRiseWithin(daily, 1), 10);
  assert.equal(C.maxRiseWithin(daily, 7), 20);
});

test('fundingStats: 평균(8시간당 %)과 음수 비율', () => {
  const st = C.fundingStats(series([0.0001, -0.0001, 0.0003, 0.0001]));
  assert.equal(st.avgPct, 0.01);
  assert.equal(st.negativePct, 25);
});

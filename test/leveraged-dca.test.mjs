import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../server/backtest/leveraged-dca.js');
const D = 86400000;

test('synthLeveraged: 하루 수익 × 3 − 비용, 하루 −34% 면 0 아래로 가지 않는다', () => {
  const bars = [{ t: 0, c: 100 }, { t: D, c: 110 }, { t: 2 * D, c: 99 }];
  const s = L.synthLeveraged(bars, { costAnnual: 0 });
  assert.ok(Math.abs(s[1].c - 1.3) < 1e-12, '+10% → +30%');
  assert.ok(Math.abs(s[2].c - 1.3 * (1 - 0.3)) < 1e-12, '−10% → −30%');
  const crash = L.synthLeveraged([{ t: 0, c: 100 }, { t: D, c: 60 }], { costAnnual: 0 });
  assert.equal(crash[1].c, 0, '−40% × 3 = −120% → 0(끝)');
  const cost = L.synthLeveraged([{ t: 0, c: 100 }, { t: D, c: 100 }], { costAnnual: 0.0504 });
  assert.ok(Math.abs(cost[1].c - (1 - 0.0002)) < 1e-12, '비용은 하루 1/252');
});

test('dca: 매달 첫 거래일에 사고, 하락장(200일선 아래) 달은 두 배 · 넣은 돈 대비 가장 나빴던 때', () => {
  // 1월 1일 100 · 1월 15일 50 · 2월 1일 50 · 2월 15일 100
  const prices = [{ t: Date.UTC(2020, 0, 1), c: 100 }, { t: Date.UTC(2020, 0, 15), c: 50 }, { t: Date.UTC(2020, 1, 3), c: 50 }, { t: Date.UTC(2020, 1, 14), c: 100 }];
  const plain = L.dca(prices, { from: 0, monthly: 100 });
  assert.equal(plain.invested, 200);
  assert.equal(plain.value, (1 + 2) * 100, '1주 + 2주 → 300');
  assert.equal(plain.multiple, 1.5);
  assert.equal(plain.worstRatio, 0.5, '1월 15일: 100 넣고 50');
  const dip = L.dca(prices, { from: 0, monthly: 100, dip: 2, below: [false, false, true, false] });
  assert.equal(dip.invested, 300, '2월은 하락장이라 200');
  assert.equal(dip.value, (1 + 4) * 100);
  assert.ok(Math.abs(dip.maxDd - 0.5) < 1e-12);
  assert.equal(L.dca(prices, { from: Date.UTC(2020, 1, 1), monthly: 100 }).invested, 100, '시작 전 달은 빼고');
});

test('cagr · maxDrawdown', () => {
  const ps = [{ t: 0, c: 100 }, { t: 365.25 * D, c: 50 }, { t: 2 * 365.25 * D, c: 200 }];
  assert.ok(Math.abs(L.cagr(ps, 0, Infinity) - 41.421356) < 1e-4);
  assert.equal(L.maxDrawdown(ps, 0, Infinity), 50);
});

test('run: 네 가지 · 정해 둔 구간 · 시작한 달마다 10년(합성 데이터)', () => {
  const qqq = [];
  let c = 50;
  for (let k = 0, t = Date.parse('1999-03-10'); k < 7000; t += D) {
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    c *= 1 + Math.sin(k / 50) * 0.01 + 0.0004;
    qqq.push({ t, o: c, h: c, l: c, c });
    k++;
  }
  const lines = [];
  const out = L.run({ qqq, log: (s) => lines.push(s) });
  const text = lines.join('\n');
  assert.match(text, /가짜 TQQQ = QQQ 하루 × 3 − 연 5% 비용/);
  assert.match(text, /\[2000-01 시작\(닷컴 붕괴 직전\) → /);
  assert.match(text, /A TQQQ 적립: 넣은 돈 [\d,]+만 → 지금 [\d,]+만\([\d.]+배\) · 넣은 돈 대비 가장 나빴던 때 -?[\d.]+%/);
  assert.match(text, /\[시작한 달마다 10년 — \d+가지/);
  assert.match(text, /D QQQ 적립 \+ 하락장 두 배: 끝에 넣은 돈의 최악 [\d.]+배/);
  assert.equal(Object.keys(out).length, 4);
  assert.doesNotMatch(text, /NaN|undefined/);
});

test('incomePlan: 같은 월급 — 꾸준히는 매달 전부, 아껴 두기는 평소 절반 · 하락장 달에 모은 현금까지 전부', () => {
  const t = (m, d) => Date.UTC(2020, m, d);
  const prices = [{ t: t(0, 2), c: 100 }, { t: t(1, 3), c: 100 }, { t: t(2, 2), c: 50 }, { t: t(2, 20), c: 100 }];
  const steady = L.incomePlan(prices, null, { from: 0, income: 100, mode: 'steady' });
  assert.equal(steady.paid, 300);
  assert.equal(steady.wealth, (1 + 1 + 2) * 100);
  const res = L.incomePlan(prices, [false, false, true, false], { from: 0, income: 100, mode: 'reserve' });
  // 1월 50 사고 50 현금 · 2월 50 사고 50 현금(모두 100) · 3월(하락장) 100 + 100 = 200 을 50 에 → 4주
  assert.equal(res.dips, 1);
  assert.equal(res.cash, 0);
  assert.equal(res.wealth, (0.5 + 0.5 + 4) * 100);
  assert.ok(res.multiple > steady.multiple, '바닥에서 몰아 산 만큼');
  const noDip = L.incomePlan(prices, [false, false, false, false], { from: 0, income: 100, mode: 'reserve' });
  assert.equal(noDip.cash, 150, '하락장이 안 오면 현금이 쌓인다');
});

test('incomeCompare: 넷 · 정해 둔 구간 · 판정 줄(합성 데이터)', () => {
  const qqq = [];
  let c = 50;
  for (let k = 0, t = Date.parse('1999-03-10'); k < 7000; t += D) {
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    c *= 1 + Math.sin(k / 60) * 0.012 + 0.0004;
    qqq.push({ t, o: c, h: c, l: c, c });
    k++;
  }
  const lines = [];
  L.incomeCompare({ qqq, log: (s) => lines.push(s) });
  const text = lines.join('\n');
  assert.match(text, /같은 월급\(매달 25만 원\)으로/);
  assert.match(text, /아껴 두기 · 하락장 = 200일선 아래 — TQQQ: 받은 월급 [\d,]+만 → 지금 [\d,]+만/);
  assert.match(text, /아껴 두기 · 하락장 = 고점 −20% — TQQQ: 끝 최악 [\d.]+배/);
  assert.match(text, /판정\(docs\/07 .*→ /);
  assert.doesNotMatch(text, /NaN|undefined/);
  const b = [];
  L.boostCompare({ qqq, log: (x) => b.push(x) });
  const bt = b.join('\n');
  assert.match(bt, /하락장엔 더 넣기 — TQQQ 적립 · 평소 25만 · 하락장 달 40만/);
  assert.match(bt, /QQQ 가 고점 −40% 아래인 달 40만: 넣은 돈 [\d,]+만 → /);
  assert.match(bt, /10년 안에 저축에서 더 가져온 돈 최대 [\d,]+만 · 하락장 달 최장 \d+달 연속/);
  assert.match(bt, /판정\(docs\/07 — 넣은 돈 대비 10년 중간 · 10% 둘 다/);
  assert.doesNotMatch(bt, /NaN|undefined/);
});

test('boostPlan · belowPeak: 고점 −40% 아래인 달만 더 넣고, 밖에서 더 가져온 돈 · 가장 길게 이어진 달 수', () => {
  const t = (m) => Date.UTC(2020, m, 2);
  const prices = [100, 50, 50, 70, 100].map((c, m) => ({ t: t(m), c }));
  const deep = L.belowPeak(prices, 0.4);
  assert.deepEqual(deep, [false, true, true, false, false], '50 ≤ 60, 70 > 60');
  const r = L.boostPlan(prices, deep, { from: 0, base: 100, boost: 160 });
  assert.equal(r.invested, 100 + 160 + 160 + 100 + 100);
  assert.equal(r.extra, 120);
  assert.equal(r.maxRun, 2);
  assert.equal(r.boosted, 2);
  const flat = L.boostPlan(prices, null, { from: 0, base: 100, boost: 160 });
  assert.ok(r.multiple > flat.multiple, '바닥에서 더 산 만큼 넣은 돈 대비도 낫다');
});

test('boostPlan ddSince: 산 뒤의 최고가로 잰다 — 시작 전 고점(가짜 TQQQ 2000 년)에 끌려가지 않는다', () => {
  const t = (y, m) => Date.UTC(y, m, 2);
  // 시작 전 고점 1000 → 시작 뒤 100 · 50(−50%) · 100
  const prices = [{ t: t(2000, 0), c: 1000 }, { t: t(2010, 0), c: 100 }, { t: t(2010, 1), c: 50 }, { t: t(2010, 2), c: 100 }];
  const r = L.boostPlan(prices, null, { from: t(2010, 0), base: 100, boost: 160, ddSince: 0.4 });
  assert.equal(r.boosted, 1, '2월만(50 ≤ 100 × 0.6)');
  assert.equal(r.invested, 100 + 160 + 100);
  const allTime = L.boostPlan(prices, L.belowPeak(prices, 0.4), { from: t(2010, 0), base: 100, boost: 160 });
  assert.equal(allTime.boosted, 3, '처음부터 쌓은 최고가(1000)로 재면 늘 하락장 — 고친 이유');
});

test('thresholdCompare: 기준 여섯 줄 · 꾸준히 줄 · 판정(이웃까지 봄)', () => {
  const qqq = [];
  let c = 50;
  for (let k = 0, t = Date.parse('1999-03-10'); k < 7000; t += D) {
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    c *= 1 + Math.sin(k / 70) * 0.015 + 0.0004;
    qqq.push({ t, o: c, h: c, l: c, c });
    k++;
  }
  const lines = [];
  const r = L.thresholdCompare({ qqq, log: (s) => lines.push(s) });
  const text = lines.join('\n');
  assert.equal(r.rows.length, 6);
  assert.match(text, /꾸준히\(더 넣기 없음\): 중간 [\d.]+배/);
  for (const dd of [20, 30, 40, 50, 60, 70]) assert.match(text, new RegExp(`−${dd}%: 중간 [\\d.]+배 · 10% [\\d.]+배`));
  assert.match(text, /시작 지금까지 배수 2000 [\d.]+ · 2010 [\d.]+ · 2021-11 [\d.]+/);
  assert.match(text, /판정\(docs\/07 — 꾸준히 이상 · 이웃도 .*→ /);
  if (r.pick) assert.ok(r.pick.mid >= r.steady.mid);
  assert.doesNotMatch(text, /NaN|undefined/);
});

test('dcaOnDay · buyDayCompare: 그달 D 일(쉬면 그 뒤 첫 거래일)에 한 번 · 날짜별 줄', () => {
  const ps = [3, 9, 12, 28].map((d, k) => ({ t: Date.UTC(2020, 0, d), c: [100, 50, 80, 100][k] })).concat([{ t: Date.UTC(2020, 1, 4), c: 100 }]);
  const r1 = L.dcaOnDay(ps, { from: 0, monthly: 100, day: 1 });
  assert.equal(r1.invested, 200, '1월 3일 · 2월 4일');
  const r10 = L.dcaOnDay(ps, { from: 0, monthly: 100, day: 10 });
  assert.equal(r10.invested, 100, '1월 12일(10일 뒤 첫 거래일)만 — 2월엔 10일 뒤 거래일이 없다');
  assert.ok(Math.abs(r10.value - 100 / 80 * 100) < 1e-9);
  const qqq = [];
  let c = 50;
  for (let k = 0, t = Date.parse('1999-03-10'); k < 7000; t += D) {
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    c *= 1 + Math.sin(k / 40) * 0.01 + 0.0004;
    qqq.push({ t, o: c, h: c, l: c, c });
    k++;
  }
  const lines = [];
  const out = L.buyDayCompare({ qqq, log: (x) => lines.push(x) });
  assert.equal(out.length, 7);
  assert.match(lines.join('\n'), /11일: 중간 [\d.]+배 · 10% [\d.]+배/);
  assert.match(lines.join('\n'), /가장 높은 날과 낮은 날 차이: 중간 [\d.]+배/);
});

test('irregularPlan · irregularCompare: 금액 순서를 되풀이 · 달마다 5만 원 두 번 · 같은 총액 똑같이와 견줌', () => {
  const ps = [];
  for (let m = 0; m < 3; m++) for (const d of [5, 12, 25]) ps.push({ t: Date.UTC(2020, m, d), c: 100 });
  const r = L.irregularPlan(ps, { from: 0, schedule: [100, 300], extra: 10, extrasPerMonth: 1, seed: 1, day: 11 });
  assert.equal(r.months, 3);
  assert.equal(r.invested, 100 + 300 + 100 + 3 * 10, '11일 뒤 첫 거래일에 순서대로 · 달마다 5만 원(여기선 10) 한 번');
  assert.equal(r.multiple, 1, '값이 그대로면 1배');
  const qqq = [];
  let c = 50;
  for (let k = 0, t = Date.parse('1999-03-10'); k < 7000; t += 86400000) {
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    c *= 1 + Math.sin(k / 45) * 0.012 + 0.0004;
    qqq.push({ t, o: c, h: c, l: c, c });
    k++;
  }
  const lines = [];
  const out = L.irregularCompare({ qqq, log: (x) => lines.push(x) });
  const text = lines.join('\n');
  assert.match(text, /매달 11일 40 · 50 · 20 · 70 · 10 · 25만 원 되풀이 \+ 달마다 아무 날 2번 5만 원/);
  assert.match(text, /들쭉날쭉이 더 나았던 경우 \d+\/\d+ · 차이\(넣은 돈 대비\) 중간 -?[\d.]+%/);
  assert.ok(out.rs.length > 100);
  assert.doesNotMatch(text, /NaN|undefined/);
  // 대표님 '같은 총액이 아니더라도 여윳돈 있으면 넣는다' — 기본 25만만과 견준다
  assert.match(text, /■ 여윳돈 더 넣기 vs 25만 원만/);
  assert.match(text, /더 넣은 돈의 배수 중간 [\d.]+배 · 10% [\d.]+배 · 최악 [\d.]+배 \/ 기본 돈의 배수 중간/);
  assert.match(text, /도중 가장 빠졌을 때\(평가액 − 넣은 돈\) — 여윳돈 넣기 중간 -?[\d,]+만/);
  assert.ok(out.ts.every((x) => x.addIn > 0 && x.ir.invested > x.b.invested), '계획이 기본보다 많이 넣는다');
});

test('dcaOnDay · irregularPlan: 도중 가장 빠졌을 때(원 · %)', () => {
  const ps = [100, 50, 80].map((c, i) => ({ t: Date.UTC(2020, i, 15), c }));
  const r = L.dcaOnDay(ps, { from: 0, monthly: 100, day: 1 });
  // 1월 100원 1주 → 2월 값 50: 평가 50 + 새로 100(2주) = 150, 넣은 돈 200 → −50(−25%) · 3월 3주 × 80 + 100 = 340 vs 300
  assert.equal(r.worst, -50);
  assert.equal(r.worstPct, -0.25);
  const ir = L.irregularPlan(ps, { from: 0, schedule: [100], extra: 0, extrasPerMonth: 0, day: 1 });
  assert.equal(ir.worst, -50);
});

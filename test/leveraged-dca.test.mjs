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

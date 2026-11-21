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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../server/retro.js');

const M15 = 15 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 29, 0, 15);
const bars = (n, start, lo, hi) => Array.from({ length: n }, (_, i) => ({ t: start + i * M15, o: 0, h: hi, l: lo, c: (lo + hi) / 2 }));
const buy = { ts: new Date(T0).toISOString(), action: 'BUY', confidence: 55, entryNum: 83491, stopNum: 82581, targetNum: 87396 };

test('진행 중인 매매는 등락이 있어도 "아직 결과 아님" — 손실로 전하지 않는다(9/29 BTC 실제 사례)', () => {
  const c15 = bars(150, T0 - 10 * M15, 83000, 84500);
  const s = R.describePastDecision(buy, { candles15m: c15, nowPrice: 83350, now: T0 + 2 * 86400000 });
  assert.match(s, /진행 중 2일째, 현재 -0\.17% — 손절·익절 모두 미도달, 아직 결과 아님/);
  assert.doesNotMatch(s, /손실|실패/);
});

test('익절·손절 도달은 성공·실패로, 같은 봉이면 손절(보수적)', () => {
  const up = bars(10, T0, 83000, 84000);
  up[5].h = 87500;
  assert.match(R.describePastDecision(buy, { candles15m: [{ t: T0 - M15, h: 1, l: 1, c: 1 }, ...up] }), /익절 도달 \(\+4\.68%\) — 성공/);
  const both = bars(10, T0, 83000, 84000);
  both[3].h = 88000;
  both[3].l = 82000;
  assert.match(R.describePastDecision(buy, { candles15m: [{ t: T0 - M15, h: 1, l: 1, c: 1 }, ...both] }), /손절 도달 \(-1\.09%\) — 실패/);
});

test('숏도 방향을 반대로 판정 · 15분봉이 판정 시각을 못 덮으면 다음 일봉부터', () => {
  const sell = { ts: new Date(T0).toISOString(), action: 'SELL', entryNum: 100, stopNum: 102, targetNum: 96 };
  const daily = [
    { t: T0 - 3600000, h: 200, l: 1, c: 100 }, // 판정 당일 봉 — 진입 전 움직임이라 보지 않는다
    { t: T0 + 86400000, h: 101, l: 95.5, c: 97 },
  ];
  assert.match(R.describePastDecision(sell, { candles15m: [], daily }), /익절 도달 \(\+4\.00%\) — 성공/);
});

test('관망·레벨 없음은 결과를 지어내지 않는다', () => {
  assert.match(R.describePastDecision({ ts: buy.ts, action: 'HOLD', confidence: 40 }, {}), /관망\(매매 없음\)/);
  assert.match(R.describePastDecision({ ts: buy.ts, action: 'BUY' }, {}), /결과 판정 불가/);
  assert.match(R.describePastDecision({ ...buy, targetNum: 80000 }, {}), /결과 판정 불가/, '레벨이 방향과 모순');
  assert.match(R.RETRO_NOTE, /진행 중.*결과가 아니/);
});

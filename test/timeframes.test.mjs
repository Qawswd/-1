import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TF = require('../server/backtest/timeframes.js');

test('resample: 15분봉 4개 → 1시간봉(시가·고가·저가·종가·거래량) · toDaily: 봉 수익을 하루로 곱한다', () => {
  const M = 900000;
  const m15 = [[10, 12, 9, 11], [11, 13, 10, 12], [12, 12, 8, 9], [9, 10, 9, 10], [10, 11, 10, 11]].map(([o, h, l, c], i) => ({ t: i * M, o, h, l, c, v: 1 }));
  const h1 = TF.resample(m15, 4);
  assert.equal(h1.length, 2);
  assert.deepEqual(h1[0], { t: 0, o: 10, h: 13, l: 8, c: 10, v: 4 });
  assert.equal(TF.resample(m15, 1), m15);
  const d = TF.toDaily([{ t: 0, ret: 0.1 }, { t: 3600000, ret: 0.1 }, { t: 86400000, ret: -0.05 }]);
  assert.equal(d.length, 2);
  assert.ok(Math.abs(d[0].ret - 0.21) < 1e-12);
});

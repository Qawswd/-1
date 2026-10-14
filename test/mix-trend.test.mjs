import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const M = require('../server/backtest/mix-trend.js');

const DAY = 86400000;
const T0 = Date.UTC(2024, 0, 1);

test('alignToCalendar: 코인 달력(UTC 하루)에 맞추고, 쉬는 날은 직전 종가로 채워 stale, 첫 거래 전은 null', () => {
  const cal = [0, 1, 2, 3, 4].map((i) => T0 + i * DAY);
  const bars = [
    { t: T0 + 1 * DAY + 14.5 * 3600000, o: 10, h: 11, l: 9, c: 10.5, v: 1 }, // 미국 장 시각(UTC 14:30)
    { t: T0 + 3 * DAY + 14.5 * 3600000, o: 11, h: 12, l: 10, c: 11.5, v: 1 },
  ];
  const a = M.alignToCalendar(cal, bars);
  assert.equal(a[0], null);
  assert.deepEqual(a[1], { t: T0 + DAY, o: 10, h: 11, l: 9, c: 10.5, v: 1 });
  assert.equal(a[2].stale, true);
  assert.equal(a[2].c, 10.5);
  assert.equal(a[3].c, 11.5);
  assert.equal(a[4].stale, true);
});

test('buildAssets: 모든 종목이 존재하는 날부터 자른다', () => {
  const r = M.buildAssets([], { A: { daily: [null, null, { t: 2 }, { t: 3 }] }, B: { daily: [{ t: 0 }, { t: 1 }, { t: 2 }, { t: 3 }], funding: [1] } });
  assert.deepEqual(r.A.daily.map((b) => b.t), [2, 3]);
  assert.deepEqual(r.B.daily.map((b) => b.t), [2, 3]);
  assert.deepEqual(r.B.funding, [1]);
});

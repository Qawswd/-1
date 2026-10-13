import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseYahooDaily } = require('../server/backtest/fetch-stocks.js');
const { simulateLongShort } = require('../server/backtest/stock-trend.js');

const DAY = 86400000;
const T0 = Date.UTC(2024, 0, 1);

test('parseYahooDaily: 값 없는 날은 빼고, adjclose 비율로 시가·고가·저가까지 맞춘다', () => {
  const d = { chart: { result: [{
    timestamp: [100, 200, 300],
    indicators: {
      quote: [{ open: [10, null, 12], high: [11, 11, 13], low: [9, 9, 11], close: [10, null, 12], volume: [1, 2, 3] }],
      adjclose: [{ adjclose: [5, null, 12] }],
    },
  }] } };
  const rows = parseYahooDaily(d);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { t: 100000, o: 5, h: 5.5, l: 4.5, c: 5, v: 1 });
  assert.equal(rows[1].c, 12);
  assert.deepEqual(parseYahooDaily({}), []);
});

test('simulateLongShort: 다 위면 +100%, 다 아래면 −100% — 밤사이 갭은 어제 비중, 시가→종가는 새 비중, 비중을 바꾸면 비용', () => {
  const mk = (i, o, c) => ({ t: T0 + i * DAY, o, h: Math.max(o, c), l: Math.min(o, c), c, v: 1 });
  const daily = [mk(0, 100, 100), mk(1, 100, 110), mk(2, 111, 121), mk(3, 120, 100), mk(4, 98, 90)];
  const days = simulateLongShort(daily, { smaGrid: [2], costPct: 0 });
  assert.equal(days[0].f, 0);
  assert.equal(days[1].f, 0, '평균을 낼 봉이 1개뿐 — 0');
  assert.equal(days[2].f, 1, '어제 110 > 평균 105 → 롱');
  assert.ok(Math.abs(days[2].ret - (121 / 111 - 1)) < 1e-12, '시가에 들어가 시가→종가');
  assert.equal(days[4].f, -1, '어제 100 < 평균 110.5 → 숏');
  // 4일째: 밤사이 갭(100→98)은 어제 비중(+1 → 3일째 결정은 121 > 115.5 → +1), 시가→종가는 −1
  assert.ok(Math.abs(days[4].ret - (1 * (98 / 100 - 1) + -1 * (90 / 98 - 1))) < 1e-12);
  const withCost = simulateLongShort(daily, { smaGrid: [2], costPct: 0.1 });
  assert.ok(Math.abs(withCost[4].ret - days[4].ret + 2 * 0.001) < 1e-12, '+1 → −1 은 비중 2 만큼 비용');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../server/backtest/rotation.js');
const { pickEarlyPerps } = require('../server/backtest/fetch-alts.js');

const DAY = 86400000;
const T0 = Date.UTC(2024, 0, 1);
const coin = (sym, step, n = 40, startIdx = 0) => ({
  sym,
  d: Array.from({ length: n }, (_, i) => (i < startIdx ? null : { t: T0 + i * DAY, o: 100 + i * step, h: 100 + i * step, l: 100 + i * step, c: 100 + i * step })),
  fd: new Map(),
});

test('simulateRotation: 최근 가장 많이 오른 코인만 산다, 떨어진 코인은 상위여도 안 산다', () => {
  const up = coin('UP', 2);
  const flat = coin('FLAT', 0.1);
  const down = coin('DOWN', -1);
  const days = R.simulateRotation([up, flat, down], { lookback: 5, topK: 1, rebalanceDays: 5, useTrend: false, cost: 0, alloc: 1 });
  // 5일째 종가에 UP 을 사서 6일째부터 UP 의 수익만 들어온다
  const d6 = days.find((x) => x.t === T0 + 6 * DAY);
  assert.ok(Math.abs(d6.ret - (112 / 110 - 1)) < 1e-12);
  const onlyDown = R.simulateRotation([down], { lookback: 5, topK: 1, rebalanceDays: 5, useTrend: false, cost: 0 });
  assert.ok(onlyDown.every((x) => x.ret === 0), '최근에 떨어진 코인은 사지 않는다');
});

test('simulateRotation: 바꾼 비중만큼 비용, 상장 전(null) 코인은 고르지 않는다', () => {
  const late = coin('LATE', 5, 40, 20); // 20일째 상장
  const early = coin('EARLY', 1);
  const days = R.simulateRotation([early, late], { lookback: 5, topK: 1, rebalanceDays: 5, useTrend: false, cost: 0.001, alloc: 1 });
  const d5 = days.find((x) => x.t === T0 + 5 * DAY);
  assert.ok(Math.abs(d5.ret - -0.001) < 1e-12, '첫 매수 비용 1 × 0.1%');
  const d10 = days.find((x) => x.t === T0 + 10 * DAY);
  assert.ok(d10.ret > 0 && d10.ret < 0.02, 'LATE 가 아직 없어 EARLY 를 유지(비용 없음)');
});

test('pickEarlyPerps: 기준일 전에 상장한 USDT 무기한만, 지금 거래 중인 것만, BTC·ETH 제외, 상장 순서대로', () => {
  const info = { symbols: [
    { symbol: 'XRPUSDT', contractType: 'PERPETUAL', quoteAsset: 'USDT', status: 'TRADING', onboardDate: Date.UTC(2020, 0, 6) },
    { symbol: 'LTCUSDT', contractType: 'PERPETUAL', quoteAsset: 'USDT', status: 'TRADING', onboardDate: Date.UTC(2020, 0, 1) },
    { symbol: 'SOLUSDT', contractType: 'PERPETUAL', quoteAsset: 'USDT', status: 'TRADING', onboardDate: Date.UTC(2020, 8, 14) },
    { symbol: 'BTCUSDT', contractType: 'PERPETUAL', quoteAsset: 'USDT', status: 'TRADING', onboardDate: Date.UTC(2019, 8, 1) },
    { symbol: 'EOSUSDT', contractType: 'PERPETUAL', quoteAsset: 'USDT', status: 'SETTLING', onboardDate: Date.UTC(2020, 0, 2) },
    { symbol: 'TSLAUSDT', contractType: 'TRADIFI_PERPETUAL', quoteAsset: 'USDT', status: 'TRADING', onboardDate: Date.UTC(2020, 0, 2) },
  ] };
  assert.deepEqual(pickEarlyPerps(info).map((x) => x.symbol), ['LTCUSDT', 'XRPUSDT']);
});

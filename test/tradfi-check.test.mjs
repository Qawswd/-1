import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fundingSummary, weekendShape } = require('../ops/tradfi-check.js');

const H8 = 8 * 3600000;
const T0 = Date.UTC(2026, 0, 5); // 월요일

test('fundingSummary: 8시간당 평균·연 환산 롱 비용·음수 비율·정산 간격', () => {
  const rows = Array.from({ length: 4 }, (_, i) => ({ fundingTime: T0 + i * H8, fundingRate: i === 3 ? '-0.0001' : '0.0001' }));
  const s = fundingSummary(rows);
  assert.equal(s.n, 4);
  assert.equal(s.avgPer8hPct, 0.005);
  assert.equal(s.negativePct, 25);
  assert.equal(s.intervalHours, 8);
  // 합 0.0002(=0.02%)가 1일(3회 간격 24시간)에 → 연 7.3%
  assert.equal(s.annualLongCostPct, 7.3);
  assert.equal(fundingSummary([]), null);
});

test('weekendShape: 주말 봉 수와 주말/평일 거래대금 비율', () => {
  const k = (i, q) => [T0 + i * 86400000, 0, 0, 0, 0, 0, 0, String(q)];
  const r = weekendShape([k(0, 100), k(1, 100), k(5, 10), k(6, 30)]); // 월·화 · 토·일
  assert.deepEqual(r, { days: 4, weekendDays: 2, weekendVolumeRatio: 0.2 });
});

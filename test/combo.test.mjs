import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../server/backtest/combo.js');

const DAY = 86400000;
const T0 = Date.UTC(2024, 0, 1);

test('addIdleCarry: 지난 7일 평균 펀딩이 기준을 넘을 때만 켠다 — 켤 때 비용 한 번, 그 뒤 쉬는 돈 × 펀딩 ÷ 2', () => {
  const days = Array.from({ length: 12 }, (_, i) => ({ t: T0 + i * DAY, ret: 0, expo: 0 }));
  const hi = new Map(days.map((d) => [d.t, 0.0009])); // 8시간당 0.03%
  const r = C.addIdleCarry(days, hi);
  assert.ok(r.slice(0, 7).every((d) => d.ret === 0), '7일 기록이 모이기 전엔 끈다');
  assert.ok(Math.abs(r[7].ret - (-0.001 + 0.00045)) < 1e-12, '켜는 날: 비용 0.1% + 그날 펀딩 절반');
  assert.ok(Math.abs(r[8].ret - 0.00045) < 1e-12);
  const lo = new Map(days.map((d) => [d.t, 0.0001])); // 8시간당 0.0033% — 기준 0.01% 아래
  assert.ok(C.addIdleCarry(days, lo).every((d) => d.ret === 0));
  const busy = days.map((d) => ({ ...d, expo: 1 })); // 쉬는 돈 없음
  assert.ok(C.addIdleCarry(busy, hi).every((d) => d.ret === 0));
});

test('atDrawdown: 비중을 줄여 최대 손실을 맞춘다 — 이미 그 아래면 1배 그대로(키우지 않는다)', () => {
  const days = [{ t: T0, ret: 0 }, { t: T0 + DAY, ret: 0.1 }, { t: T0 + 2 * DAY, ret: -0.4 }, { t: T0 + 400 * DAY, ret: 0.5 }];
  const r = C.atDrawdown(days, 20);
  assert.ok(r.alloc >= 49 && r.alloc <= 51, `비중 ${r.alloc}`);
  assert.ok(r.dd <= 20 && r.dd > 19.9);
  const small = [{ t: T0, ret: 0 }, { t: T0 + DAY, ret: -0.05 }, { t: T0 + 400 * DAY, ret: 0.1 }];
  assert.equal(C.atDrawdown(small, 20).alloc, 100);
});

test('drawdownForMonthly · monthlyOf: 월 3% = 연 42.6% — 1배로도 못 내면 null', () => {
  assert.equal(C.monthlyOf(42.58), 3);
  const year = (gain) => [{ t: T0, ret: 0 }, { t: T0 + 100 * DAY, ret: -0.2 }, { t: T0 + 365.25 * DAY, ret: (1 + gain) / 0.8 - 1 }];
  assert.equal(C.drawdownForMonthly(year(0.3), 3), null, '연 30% 로는 월 3% 불가');
  const r = C.drawdownForMonthly(year(1.0), 3);
  assert.ok(r && r.alloc < 100 && r.dd < 20, JSON.stringify(r));
});

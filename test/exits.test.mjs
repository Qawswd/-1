import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const X = require('../server/backtest/exits.js');

const DAY = 86400000;
// 0~5일 오름(종가 100~105) → 2일 종가에 초록 → 3일 시가 103 에 롱, 손절 5% = 97.85, 1R 익절 = 108.15
const up = Array.from({ length: 6 }, (_, i) => ({ t: i * DAY, o: 100 + i, h: 100.5 + i, l: 99.5 + i, c: 100 + i }));
const base = { mode: 'long', stop: { k: 'pct', v: 5 }, tp: 0, trail: 'none', signalExit: false, holdDays: 0, cost: 0, fast: 2, slow: 3 };

test('simulateExits: 손절에 닿으면 손절가에, 시가가 손절을 건너뛰면 시가에 나간다', () => {
  const hit = X.simulateExits([...up, { t: 6 * DAY, o: 104, h: 104.5, l: 97, c: 98 }], base);
  assert.equal(hit.trades.length, 1);
  assert.equal(hit.trades[0].reason, 'stop');
  assert.ok(Math.abs(hit.trades[0].pct - -5) < 1e-9);
  assert.ok(Math.abs(hit.trades[0].r - -1) < 1e-9);
  const gap = X.simulateExits([...up, { t: 6 * DAY, o: 95, h: 96, l: 94, c: 95 }], base);
  assert.ok(Math.abs(gap.trades[0].pct - (95 / 103 - 1) * 100) < 1e-9, '갭은 시가 95 에');
});

test('simulateExits: 같은 날 손절·익절 둘 다면 15분봉 순서 — 없으면 손절로 본다', () => {
  const day6 = { t: 6 * DAY, o: 104, h: 109, l: 97, c: 100 };
  const o = { ...base, tp: 1 };
  assert.equal(X.simulateExits([...up, day6], o).trades[0].reason, 'stop');
  const minutes = new Map([[6 * DAY, [{ t: 6 * DAY, h: 109, l: 103.5 }, { t: 6 * DAY + 900000, h: 104, l: 97 }]]]);
  const t = X.simulateExits([...up, day6], { ...o, minutes }).trades[0];
  assert.equal(t.reason, 'target');
  assert.ok(Math.abs(t.pct - 5) < 1e-9);
  assert.equal(X.firstHit([{ h: 109, l: 97 }], 1, 97.85, 108.15), 'stop', '한 봉에서 둘 다면 손절');
});

test('simulateExits: 신호 청산은 다음 날 시가 · 7일 기간 · 롱만이면 숏 없음', () => {
  const down = [...up, { t: 6 * DAY, o: 104, h: 104.5, l: 101, c: 101 }, { t: 7 * DAY, o: 100, h: 100.5, l: 99, c: 99 }];
  const sig = X.simulateExits(down, { ...base, signalExit: true }).trades[0];
  assert.equal(sig.reason, 'signal');
  assert.ok(Math.abs(sig.pct - (100 / 103 - 1) * 100) < 1e-9);
  const long = Array.from({ length: 14 }, (_, i) => ({ t: i * DAY, o: 100 + i, h: 100.5 + i, l: 99.5 + i, c: 100 + i }));
  const timed = X.simulateExits(long, { ...base, holdDays: 7 }).trades[0];
  assert.equal(timed.reason, 'time');
  assert.equal(timed.days, 7);
  assert.ok(X.simulateExits(down, { ...base, signalExit: true }).trades.every((x) => x.dir === 1));
  assert.equal(X.simulateExits(up, { ...base, mode: 'shortOnly' }).trades.length, 0, '숏 칸만 잴 때는 롱이 없다');
  const two = X.simulateExits([...down, { t: 8 * DAY, o: 98, h: 98.5, l: 97.9, c: 98 }], { ...base, signalExit: true, exitDays: 2 }).trades[0];
  assert.equal(two.reason, 'signal');
  assert.ok(Math.abs(two.pct - (98 / 103 - 1) * 100) < 1e-9, '이틀 연속 아래 마감 뒤 시가 98');
});

test('combine: 날짜 합집합 · 칸 크기만큼 · worstStreak: 가장 긴 연속 손실', () => {
  const c = X.combine([[{ t: 1, ret: 0.1 }, { t: 2, ret: 0.1 }], [{ t: 1, ret: -0.1 }]], 0.2);
  assert.deepEqual(c.map((d) => d.t), [1, 2]);
  assert.ok(Math.abs(c[0].ret) < 1e-12);
  assert.ok(Math.abs(c[1].ret - 0.02) < 1e-12, '주식이 쉬는 날은 그 종목 0');
  const s = X.worstStreak([{ pct: -1 }, { pct: 2 }, { pct: -1 }, { pct: -2 }, { pct: 0 }, { pct: 3 }]);
  assert.equal(s.length, 3);
});

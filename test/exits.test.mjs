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

test('stopOn close: 손절 주문을 못 걸면 장중 꼬리는 무시하고, 손절선 아래로 마감하면 다음 날 시가에 나간다', () => {
  const o = { ...base, stopOn: 'close' };
  // 장중 97 까지 내려갔지만 종가 98 > 손절선 97.85 → 들고 있다(걸어 둔 손절이면 97.85 에 나갔다)
  const wick = X.simulateExits([...up, { t: 6 * DAY, o: 104, h: 104.5, l: 97, c: 98 }], o);
  assert.equal(wick.trades.length, 0);
  assert.ok(wick.open);
  // 종가 97 < 97.85 → 다음 날 시가 96 에 '손절'
  const shut = X.simulateExits([...up, { t: 6 * DAY, o: 104, h: 104.5, l: 96.5, c: 97 }, { t: 7 * DAY, o: 96, h: 99, l: 95, c: 98 }], o);
  assert.equal(shut.trades.length, 1);
  assert.equal(shut.trades[0].reason, 'stop');
  assert.ok(Math.abs(shut.trades[0].pct - (96 / 103 - 1) * 100) < 1e-9, '다음 날 시가 96');
  assert.equal(shut.trades[0].exitT, 7 * DAY);
  // 시가가 손절선 밑으로 열려도 그날 종가를 보고 그다음 날에(걸어 둔 손절은 시가에)
  const gap = X.simulateExits([...up, { t: 6 * DAY, o: 95, h: 96, l: 94, c: 95 }], o);
  assert.equal(gap.trades.length, 0);
  assert.ok(gap.open, '정리는 다음 날 시가');
});

test('tpOn close: 익절을 걸어 둘 수 없으면 장중 고가는 무시하고, 익절선 위로 마감하면 다음 날 시가에 나간다', () => {
  const o = { ...base, tp: 1, tpOn: 'close' }; // 진입 103 · 손절 97.85 · 익절 108.15
  const wick = X.simulateExits([...up, { t: 6 * DAY, o: 104, h: 109, l: 103.5, c: 105 }], o);
  assert.equal(wick.trades.length, 0, '장중 109 를 찍었지만 종가 105 — 들고 있다');
  assert.equal(X.simulateExits([...up, { t: 6 * DAY, o: 104, h: 109, l: 103.5, c: 105 }], { ...base, tp: 1 }).trades[0].reason, 'target', '걸어 둔 익절이면 108.15 에');
  const shut = X.simulateExits([...up, { t: 6 * DAY, o: 104, h: 110, l: 103.5, c: 109 }, { t: 7 * DAY, o: 111, h: 112, l: 108, c: 110 }], o);
  assert.equal(shut.trades[0].reason, 'target');
  assert.ok(Math.abs(shut.trades[0].pct - (111 / 103 - 1) * 100) < 1e-9, '다음 날 시가 111');
  // 손절은 그대로 장중에 걸려 있다
  assert.equal(X.simulateExits([...up, { t: 6 * DAY, o: 104, h: 104.5, l: 97, c: 98 }], o).trades[0].reason, 'stop');
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
  const fall = Array.from({ length: 12 }, (_, i) => ({ t: i * DAY, o: 100 - i, h: 100.5 - i, l: 99.5 - i, c: 100 - i }));
  assert.ok(X.simulateExits(fall, { ...base, mode: 'both', signalExit: true }).open, '내려가면 숏을 든다');
  assert.equal(X.simulateExits(fall, { ...base, mode: 'both', signalExit: true, shortGate: () => false }).open, null, '문(shortGate)이 닫혀 있으면 숏을 새로 들지 않는다');
  const longRun = Array.from({ length: 12 }, (_, i) => ({ t: i * DAY, o: 100 + i, h: 100.5 + i, l: 99.5 + i, c: 100 + i }));
  const any = X.simulateExits(longRun, { ...base, signalExit: true });
  assert.ok(any.open && any.open.entryT === 3 * DAY, '2일 종가(50일선 = 101.5 보다 0.49% 위)에 신호 → 3일 진입');
  assert.equal(X.simulateExits(longRun, { ...base, signalExit: true, maxExt: 0.001 }).open, null, '50일선에서 0.1% 넘게 멀면 기다린다');
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

test('capCombine: 한 번에 cap 개까지 — 칸이 차 있으면 그 거래는 통째로 건너뛰고, 아직 들고 있는 것도 센다', () => {
  const D = 86400000;
  const days = (rets) => rets.map((ret, k) => ({ t: k * D, ret }));
  const a = { days: days([0.1, 0.1, 0.1, 0.1]), trades: [{ entryT: 0, exitT: 2 * D }], open: null };
  const b = { days: days([0.2, 0.2, 0.2, 0.2]), trades: [], open: { dir: 1, entryT: 1 * D } }; // 끝까지 들고 있음
  const c = { days: days([0.4, 0.4, 0.4, 0.4]), trades: [{ entryT: 1 * D, exitT: 3 * D }], open: null }; // a·b 로 칸이 차서 건너뜀
  const out = X.capCombine([a, b, c], 0.5, 2);
  assert.deepEqual(out.map((d) => Math.round(d.ret * 100) / 100), [0.05, 0.15, 0.15, 0.1]);
  const capped = X.capCombine([{ ...a, cls: 'stock' }, { ...b, cls: 'stock' }, { ...c, cls: 'coin' }], 0.5, 3, { stock: 1 });
  assert.ok(Math.abs(capped[1].ret - (0.05 + 0.2)) < 1e-12, '주식은 1칸까지 — 두 번째 주식(b)은 건너뛰고 코인(c)은 받는다');
  const all = X.capCombine([a, b, c], 0.5, 3);
  assert.ok(Math.abs(all[1].ret - (0.05 + 0.1 + 0.2)) < 1e-12, '칸이 남으면 다 받는다');
});

test('longGate · exitGate: 시장 신호등이 닫히면 새로 사지 않고, exitGate 면 다음 날 시가에 정리', async () => {
  const { createRequire } = await import('node:module');
  const X = createRequire(import.meta.url)('../server/backtest/exits.js');
  const D = 86400000;
  const bars = Array.from({ length: 260 }, (_, i) => { const c = 100 + i; return { t: i * D, o: c, h: c, l: c, c, v: 1 }; });
  const opt = { mode: 'long', stop: { k: 'pct', v: 10 }, tp: 0, trail: 'none', signalExit: true, holdDays: 0, cost: 0 };
  const free = X.simulateExits(bars, opt);
  assert.equal(free.trades.length + (free.open ? 1 : 0), 1);
  const shut = X.simulateExits(bars, { ...opt, longGate: () => false });
  assert.equal(shut.trades.length, 0);
  assert.equal(shut.open, null, '신호등이 닫혀 있으면 들어가지 않는다');
  const late = X.simulateExits(bars, { ...opt, longGate: (t) => t >= 230 * D });
  assert.equal(late.open.entryT, 231 * D, '열린 다음 날 시가에 든다');
  const out = X.simulateExits(bars, { ...opt, exitGate: (t) => t === 240 * D });
  assert.equal(out.trades[0].exitT, 241 * D);
  assert.equal(out.trades[0].reason, 'signal');
  assert.equal(out.open.entryT, 242 * D, '신호등 정리 뒤 종목이 여전히 두 선 위면 다음 날 다시');
});

test('exitOn: 롱 정리를 선 하나(기본) · 200일선 · 두 선 모두 아래로 고를 수 있다', async () => {
  const { createRequire } = await import('node:module');
  const X = createRequire(import.meta.url)('../server/backtest/exits.js');
  const D = 86400000;
  // 300일 오르다(두 선 위) 50일선 아래로만 살짝 내려가는 구간 → 'either' 는 정리, 'slow'·'both' 는 유지
  const cl = [];
  for (let i = 0; i < 300; i++) cl.push(100 + i);
  for (let i = 0; i < 15; i++) cl.push(399 - i * 4);
  const bars = cl.map((c, i) => ({ t: i * D, o: c, h: c, l: c, c, v: 1 }));
  const opt = { mode: 'long', stop: { k: 'pct', v: 50 }, tp: 0, trail: 'none', signalExit: true, holdDays: 0, cost: 0 };
  const either = X.simulateExits(bars, opt);
  const slow = X.simulateExits(bars, { ...opt, exitOn: 'slow' });
  const both = X.simulateExits(bars, { ...opt, exitOn: 'both' });
  assert.equal(either.trades.length, 1, '50일선 아래 마감 → 정리');
  assert.equal(slow.trades.length, 0);
  assert.ok(slow.open, '200일선 위라 계속 들고 있다');
  assert.ok(both.open);
});

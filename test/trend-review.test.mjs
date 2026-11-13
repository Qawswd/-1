import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../ops/trend-review.js');

// 한국 09:05 = UTC 00:05
const at = (d, hh = 0, mm = 5) => `${d}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`;

test('trend-review: 한국 날짜로 묶고 · 빠진 날 · 다시 시도 · 평균선이 바뀌었는데 주문이 없던 날을 적는다', () => {
  const state = {
    peak: 5200,
    halted: null,
    lastRun: { dateKey: '2026-10-17', ok: true },
    history: [
      { at: at('2026-10-14'), equity: 5114.39, k: { BTCUSDT: 4, ETHUSDT: 3 }, actions: ['BTCUSDT:open', 'ETHUSDT:open'] },
      { at: at('2026-10-15'), equity: 5150, k: { BTCUSDT: 4, ETHUSDT: 3 }, actions: [] },
      // 10/16 빠짐
      { at: at('2026-10-17'), equity: 5100, k: { BTCUSDT: 3, ETHUSDT: 3 }, actions: [] }, // 첫 시도(오류였다고 치자)
      { at: at('2026-10-17', 0, 35), equity: 5100, k: { BTCUSDT: 3, ETHUSDT: 2 }, actions: ['ETHUSDT:reduce'] },
    ],
  };
  const r = R.review(state, { now: Date.parse('2026-10-17T03:00:00Z') });
  assert.deepEqual(r.missing, ['2026-10-16']);
  assert.equal(r.days.length, 3);
  assert.equal(r.days[2].runs, 2);
  assert.match(r.lines[0], /10\/14 ~ 10\/17 · 돈 날 3일 · 빠진 날 1일\(10\/16\)/);
  assert.match(r.lines[1], /순자산 5,114 → 5,100 USDT · 고점 5,200 · 정지 안 됨 · 마지막 실행 2026-10-17 정상/);
  assert.match(r.lines.join('\n'), /10\/14 순자산 5,114 · BTC 4\/5 ETH 3\/5 · 주문 BTC:open ETH:open/);
  assert.match(r.lines.join('\n'), /10\/17 순자산 5,100 · BTC 3\/5 ETH 2\/5 · 주문 ETH:reduce · 2번 돌림/);
  assert.equal(r.mismatches.length, 1, 'BTC 4 → 3 인데 BTC 주문 없음(ETH 는 줄임이 있었다)');
  assert.match(r.mismatches[0], /10\/17 BTC 평균선 위 4 → 3 인데 주문 없음/);
});

test('trend-review: 오늘 09:35 전이면 오늘은 빠진 날이 아니다 · 기록 없으면 한 줄', () => {
  const state = { history: [{ at: at('2026-11-10'), equity: 1, k: {}, actions: [] }] };
  assert.deepEqual(R.review(state, { now: Date.parse('2026-11-11T00:10:00Z') }).missing, []);
  assert.deepEqual(R.review(state, { now: Date.parse('2026-11-11T02:00:00Z') }).missing, ['2026-11-11']);
  assert.match(R.review({}, {}).lines[0], /기록\(history\) 없음/);
});

test('trendErrors: journalctl 을 못 읽으면 null, 읽으면 [trend] 오류 줄만', () => {
  assert.equal(R.trendErrors('2026-10-14', () => ({ status: 1, stdout: '' })), null);
  const out = ['[trend] 2026-10-20 완료: x', '[trend] 2026-10-21 오류: BTCUSDT: timeout', '[watcher] 오류'].join('\n');
  assert.deepEqual(R.trendErrors('2026-10-14', () => ({ status: 0, stdout: out })), ['[trend] 2026-10-21 오류: BTCUSDT: timeout']);
});

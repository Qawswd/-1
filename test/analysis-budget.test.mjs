import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const budget = require('../server/analysis-budget.js');

function tmpPath() {
  return path.join(os.tmpdir(), `budget-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

// --- nyDateKey --------------------------------------------------------------

test('nyDateKey: UTC 새벽(뉴욕 전날 저녁)은 뉴욕 기준 전날 날짜를 준다', () => {
  // 2026-09-24 02:00 UTC = 2026-09-23 22:00 EDT
  assert.equal(budget.nyDateKey(Date.parse('2026-09-24T02:00:00Z')), '2026-09-23');
});

test('nyDateKey: 뉴욕 장중이면 그날 날짜', () => {
  assert.equal(budget.nyDateKey(Date.parse('2026-09-24T15:00:00Z')), '2026-09-24');
});

// --- evaluate (순수 함수) ----------------------------------------------------

test('evaluate: 칸 한도 안이면 ok', () => {
  const r = budget.evaluate({ counts: { move: 1 } }, 'move', { total: 6, move: 2 });
  assert.equal(r.ok, true);
});

test('evaluate: 용도별 칸이 다 차면 거부(급변이 다른 칸을 뺏지 못한다)', () => {
  const r = budget.evaluate({ counts: { move: 2 } }, 'move', { total: 6, move: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /move 분석 한도 2번 소진/);
});

test('evaluate: 급변 칸이 다 차도 진입가 칸은 여전히 쓸 수 있다', () => {
  const r = budget.evaluate({ counts: { move: 2 } }, 'level', { total: 6, move: 2, level: 2 });
  assert.equal(r.ok, true);
});

test('evaluate: 총 한도가 다 차면 칸이 남아도 거부', () => {
  const r = budget.evaluate({ counts: { move: 1, level: 1, planning: 1 } }, 'move', { total: 3, move: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /총 분석 한도 3번 소진/);
});

test('evaluate: 모르는 용도는 거부(오타로 한도를 우회하지 못하게)', () => {
  const r = budget.evaluate({ counts: {} }, 'typo', {});
  assert.equal(r.ok, false);
});

test('normalizeLimits: 비었거나 잘못된 값은 기본값(총6·각2)', () => {
  assert.deepEqual(budget.normalizeLimits(null), { total: 6, planning: 2, level: 2, move: 2 });
  assert.equal(budget.normalizeLimits({ move: 'abc' }).move, 2);
});

test('freshStateFor: 날짜가 바뀌면 카운트를 새로 시작한다', () => {
  const s = budget.freshStateFor({ dateKey: '2026-09-23', counts: { move: 2 } }, '2026-09-24');
  assert.deepEqual(s.counts, {});
});

test('freshStateFor: 같은 날이면 카운트 유지', () => {
  const s = budget.freshStateFor({ dateKey: '2026-09-24', counts: { move: 1 } }, '2026-09-24');
  assert.equal(s.counts.move, 1);
});

// --- consume / canConsume (파일 I/O, 임시 경로) -------------------------------

test('consume: 한도까지 쓰고 나면 거부되며, 파일에 저장돼 재시작 후에도 유지된다', () => {
  const p = tmpPath();
  budget._setStatePath(p);
  const now = Date.parse('2026-09-24T15:00:00Z');
  const limits = { total: 6, move: 2 };
  try {
    assert.equal(budget.consume('move', limits, now).ok, true);
    assert.equal(budget.consume('move', limits, now).ok, true);
    assert.equal(budget.consume('move', limits, now).ok, false); // 3번째 거부
    assert.equal(budget.canConsume('move', limits, now).ok, false); // 파일에서 다시 읽어도 소진 상태
  } finally {
    budget._resetStatePath();
    fs.rmSync(p, { force: true });
  }
});

test('consume: 다음 뉴욕 거래일이 되면 다시 쓸 수 있다', () => {
  const p = tmpPath();
  budget._setStatePath(p);
  const limits = { total: 6, move: 2 };
  try {
    budget.consume('move', limits, Date.parse('2026-09-24T15:00:00Z'));
    budget.consume('move', limits, Date.parse('2026-09-24T16:00:00Z'));
    assert.equal(budget.canConsume('move', limits, Date.parse('2026-09-25T14:00:00Z')).ok, true);
  } finally {
    budget._resetStatePath();
    fs.rmSync(p, { force: true });
  }
});

test('canConsume: 확인만 하고 카운트는 늘리지 않는다', () => {
  const p = tmpPath();
  budget._setStatePath(p);
  const now = Date.parse('2026-09-24T15:00:00Z');
  try {
    budget.canConsume('move', {}, now);
    budget.canConsume('move', {}, now);
    budget.canConsume('move', {}, now);
    assert.equal(budget.status({}, now).counts.move, undefined);
  } finally {
    budget._resetStatePath();
    fs.rmSync(p, { force: true });
  }
});

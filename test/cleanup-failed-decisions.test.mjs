import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isFailedRecord } = require('../server/cleanup-failed-decisions.js');

test('isFailedRecord: HOLD + 확신도 0은 실패 기록으로 판정', () => {
  assert.equal(isFailedRecord({ action: 'HOLD', confidence: 0 }), true);
});

test('isFailedRecord: 정상 HOLD(확신도 > 0)는 지우지 않는다', () => {
  assert.equal(isFailedRecord({ action: 'HOLD', confidence: 64 }), false);
});

test('isFailedRecord: BUY/SELL은 확신도와 무관하게 지우지 않는다', () => {
  assert.equal(isFailedRecord({ action: 'BUY', confidence: 0 }), false);
  assert.equal(isFailedRecord({ action: 'SELL', confidence: 55 }), false);
});

test('isFailedRecord: 비정상 입력은 false(아무것도 지우지 않는 쪽으로)', () => {
  assert.equal(isFailedRecord(null), false);
  assert.equal(isFailedRecord({}), false);
});

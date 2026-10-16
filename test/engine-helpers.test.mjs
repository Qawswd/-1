import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isFailedAgentResult } = require('../server/engine.js');

test('isFailedAgentResult: 한도 소진 등으로 실패한 결과는 true(판정 기록에서 제외 대상)', () => {
  assert.equal(isFailedAgentResult({ bubble: '분석 실패 — 말풍선을 클릭해 원인을 확인하세요', report: 'x' }), true);
});

test('isFailedAgentResult: 결과 자체가 없으면 true', () => {
  assert.equal(isFailedAgentResult(null), true);
  assert.equal(isFailedAgentResult(undefined), true);
});

test('isFailedAgentResult: 정상 판정(HOLD 포함)은 false — 진짜 HOLD는 기록돼야 한다', () => {
  assert.equal(isFailedAgentResult({ bubble: '관망 — 저항 확인 전', action: 'HOLD', confidence: 60 }), false);
  assert.equal(isFailedAgentResult({ bubble: '조건부 매수', action: 'BUY', confidence: 66 }), false);
});

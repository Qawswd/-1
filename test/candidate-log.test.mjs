import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const cl = require('../server/candidate-log.js');

function withTmp(fn) {
  const p = path.join(os.tmpdir(), `cand-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  cl._setLogPath(p);
  try {
    return fn(p);
  } finally {
    cl._resetLogPath();
    fs.rmSync(p, { force: true });
  }
}

test('후보 → 계획 → 실행이 같은 candidateId로 이어져 기록된다', () =>
  withTmp(() => {
    const id = cl.newCandidateId();
    cl.recordCandidate({ candidateId: id, symbol: 'BTC', kind: 'move', value: -2.1, stage: 'analyzed', passed: true });
    cl.recordPlan({
      candidateId: id,
      symbol: 'BTC',
      decision: { action: 'BUY', confidence: 56, entry: '84,194', stop: '83,600', target: '87,251', rr: 5.15, riskOk: true },
      numeric: { entry: 84194, stop: 83600, target: 87251 },
    });
    cl.recordExecution({ candidateId: id, symbol: 'BTC', payload: { ok: true } });
    const rows = cl.readLog();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.candidateId === id));
    assert.equal(rows[0].direction, 'down');
    assert.equal(rows[1].entryNum, 84194);
    assert.equal(rows[2].status, 'entered');
  }));

test('recordExecution: 미확인·차단을 구분하고 어떤 관문이었는지 flags로 남긴다', () =>
  withTmp(() => {
    cl.recordExecution({ candidateId: 'a', payload: { ok: false, unknown: true, error: '진입 결과를 확인할 수 없습니다' } });
    cl.recordExecution({ candidateId: 'b', payload: { ok: false, error: '한도', dailyLoss: { blocked: true } } });
    const [u, d] = cl.readLog();
    assert.equal(u.status, 'unknown');
    assert.equal(d.status, 'blocked_or_failed');
    assert.deepEqual(d.flags, ['dailyLoss']);
  }));

test('indicatorSnapshot: 필요한 숫자만 뽑고 없는 값은 null(지어내지 않음)', () => {
  const s = cl.indicatorSnapshot({ price: 100, sma20: 95, macd: { hist: -1.2 }, rsi14: 'x', extra: 'big' });
  assert.equal(s.price, 100);
  assert.equal(s.macdHist, -1.2);
  assert.equal(s.rsi14, null);
  assert.equal(s.extra, undefined);
  assert.equal(cl.indicatorSnapshot(null), null);
});

test('summarize: 관문별 통과·탈락과 판정 분포를 센다', () => {
  const r = cl.summarize([
    { type: 'candidate', stage: 'structure', passed: false },
    { type: 'candidate', stage: 'structure', passed: false },
    { type: 'candidate', stage: 'analyzed', passed: true },
    { type: 'plan', action: 'HOLD' },
    { type: 'execution', status: 'entered' },
  ]);
  assert.equal(r.candidates, 3);
  assert.equal(r.byStage['structure:drop'], 2);
  assert.equal(r.analyzed, 1);
  assert.equal(r.plans.HOLD, 1);
  assert.equal(r.executions.entered, 1);
});

test('테스트 실행 중에는 기본 경로(실제 기록 파일)에 쓰지 않는다(운영 데이터 오염 방지)', () => {
  const before = fs.existsSync(cl.LOG_PATH) ? fs.readFileSync(cl.LOG_PATH, 'utf8') : null;
  cl.recordCandidate({ symbol: 'TEST', stage: 'kind', passed: false });
  const after = fs.existsSync(cl.LOG_PATH) ? fs.readFileSync(cl.LOG_PATH, 'utf8') : null;
  assert.equal(after, before);
});

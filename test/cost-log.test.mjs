import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { recordCost, readCostLog, summarizeCosts, _setLogPath, _resetLogPath } = require('../server/cost-log.js');

function tmpLogPath() {
  return path.join(os.tmpdir(), `cost-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

test('recordCost → readCostLog: 기록한 항목을 그대로 읽어온다', () => {
  const p = tmpLogPath();
  _setLogPath(p);
  try {
    recordCost({ symbol: 'BTC', mode: 'algo', costUsd: 0.12, inputTokens: 20000, outputTokens: 9000, agentCount: 12, ts: 1000 });
    const entries = readCostLog();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].costUsd, 0.12);
    assert.equal(entries[0].agentCount, 12);
  } finally {
    _resetLogPath();
    fs.rmSync(p, { force: true });
  }
});

test('recordCost: costUsd를 모르면(null) 지어내지 않고 null 그대로 기록한다', () => {
  const p = tmpLogPath();
  _setLogPath(p);
  try {
    const e = recordCost({ symbol: 'BTC', costUsd: null });
    assert.equal(e.costUsd, null);
  } finally {
    _resetLogPath();
    fs.rmSync(p, { force: true });
  }
});

test('readCostLog: sinceMs 이후 항목만 필터링한다', () => {
  const p = tmpLogPath();
  _setLogPath(p);
  try {
    recordCost({ symbol: 'BTC', costUsd: 0.1, ts: 1000 });
    recordCost({ symbol: 'AAPL', costUsd: 0.2, ts: 5000 });
    const entries = readCostLog(3000);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].symbol, 'AAPL');
  } finally {
    _resetLogPath();
    fs.rmSync(p, { force: true });
  }
});

test('readCostLog: 파일이 없으면 빈 배열', () => {
  _setLogPath(path.join(os.tmpdir(), 'definitely-does-not-exist-cost-99999.jsonl'));
  try {
    assert.deepEqual(readCostLog(), []);
  } finally {
    _resetLogPath();
  }
});

// --- summarizeCosts (순수 함수) ---------------------------------------------------

test('summarizeCosts: 합계·평균·일평균을 정확히 계산한다', () => {
  const entries = [
    { costUsd: 0.1 },
    { costUsd: 0.2 },
    { costUsd: 0.3 },
  ];
  const r = summarizeCosts(entries, 3);
  assert.equal(r.count, 3);
  assert.equal(r.knownCostCount, 3);
  assert.equal(r.totalCostUsd, 0.6);
  assert.equal(r.avgCostUsd, 0.2);
  assert.equal(r.perDayCostUsd, 0.2); // 0.6 / 3일
});

test('summarizeCosts: costUsd가 null인 항목은 합계·평균에서 제외하되 knownCostCount로 몇 건 제외됐는지 알 수 있다', () => {
  const entries = [{ costUsd: 0.1 }, { costUsd: null }, { costUsd: 0.3 }];
  const r = summarizeCosts(entries, 1);
  assert.equal(r.count, 3);
  assert.equal(r.knownCostCount, 2);
  assert.equal(r.totalCostUsd, 0.4);
});

test('summarizeCosts: 전부 costUsd를 모르면 totalCostUsd는 null(0으로 위장하지 않음)', () => {
  const r = summarizeCosts([{ costUsd: null }, { costUsd: null }], 1);
  assert.equal(r.totalCostUsd, null);
  assert.equal(r.avgCostUsd, null);
});

test('summarizeCosts: 빈 배열이면 전부 0/null', () => {
  const r = summarizeCosts([], 7);
  assert.equal(r.count, 0);
  assert.equal(r.totalCostUsd, null);
});

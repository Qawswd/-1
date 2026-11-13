import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { recordTrigger, readTriggerLog, summarizeTriggers, _setLogPath, _resetLogPath } = require('../server/trigger-log.js');

function tmpLogPath() {
  return path.join(os.tmpdir(), `trigger-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
}

// --- recordTrigger / readTriggerLog (실제 파일 I/O, 임시 경로로 격리) ----------------

test('recordTrigger → readTriggerLog: 기록한 항목을 그대로 읽어온다', () => {
  const p = tmpLogPath();
  _setLogPath(p);
  try {
    recordTrigger({ symbol: 'BTC', kind: 'move', ts: 1000 });
    const entries = readTriggerLog();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].symbol, 'BTC');
    assert.equal(entries[0].kind, 'move');
  } finally {
    _resetLogPath();
    fs.rmSync(p, { force: true });
  }
});

test('recordTrigger: symbol·kind가 없어도 에러 없이 null로 기록된다', () => {
  const p = tmpLogPath();
  _setLogPath(p);
  try {
    const e = recordTrigger({});
    assert.equal(e.symbol, null);
    assert.equal(e.kind, null);
  } finally {
    _resetLogPath();
    fs.rmSync(p, { force: true });
  }
});

test('readTriggerLog: sinceMs 이후 항목만 필터링한다', () => {
  const p = tmpLogPath();
  _setLogPath(p);
  try {
    recordTrigger({ symbol: 'BTC', kind: 'move', ts: 1000 });
    recordTrigger({ symbol: 'AAPL', kind: 'move', ts: 5000 });
    const entries = readTriggerLog(3000);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].symbol, 'AAPL');
  } finally {
    _resetLogPath();
    fs.rmSync(p, { force: true });
  }
});

test('readTriggerLog: 파일이 아예 없으면 빈 배열(에러 안 던짐)', () => {
  _setLogPath(path.join(os.tmpdir(), 'definitely-does-not-exist-12345.jsonl'));
  try {
    const entries = readTriggerLog();
    assert.deepEqual(entries, []);
  } finally {
    _resetLogPath();
  }
});

test('readTriggerLog: 한 줄이 깨져 있어도 나머지는 정상적으로 읽는다', () => {
  const p = tmpLogPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{"symbol":"BTC","kind":"move","ts":1000}\nnot valid json\n{"symbol":"AAPL","kind":"volume","ts":2000}\n', 'utf8');
  _setLogPath(p);
  try {
    const entries = readTriggerLog();
    assert.equal(entries.length, 2);
  } finally {
    _resetLogPath();
    fs.rmSync(p, { force: true });
  }
});

// --- summarizeTriggers (순수 함수) -----------------------------------------------

test('summarizeTriggers: 심볼별·종류별 개수와 하루 평균을 정확히 계산한다', () => {
  const entries = [
    { symbol: 'BTC', kind: 'move' },
    { symbol: 'BTC', kind: 'volume' },
    { symbol: 'AAPL', kind: 'move' },
  ];
  const r = summarizeTriggers(entries, 3);
  assert.equal(r.count, 3);
  assert.equal(r.perDay, 1); // 3건 / 3일
  assert.equal(r.bySymbol.BTC, 2);
  assert.equal(r.bySymbol.AAPL, 1);
  assert.equal(r.byKind.move, 2);
  assert.equal(r.byKind.volume, 1);
});

test('summarizeTriggers: 빈 배열이면 전부 0', () => {
  const r = summarizeTriggers([], 7);
  assert.equal(r.count, 0);
  assert.equal(r.perDay, 0);
});

test('summarizeTriggers: windowDays가 없거나 0이면 1일로 취급한다(0으로 나누지 않음)', () => {
  const r = summarizeTriggers([{ symbol: 'BTC', kind: 'move' }], 0);
  assert.equal(r.perDay, 1);
});

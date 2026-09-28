import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { Scheduler } = require('../server/scheduler.js');

function makeEngine({ running = false, quotaExhaustedUntil = null } = {}) {
  const e = new EventEmitter();
  e.running = running;
  e.quotaExhaustedUntil = quotaExhaustedUntil;
  e.runs = [];
  e.run = async (symbol, opts) => {
    e.runs.push({ symbol, opts });
    e.emit('event', { type: 'decision', action: 'HOLD', confidence: 50 });
  };
  return e;
}

const cfg = { schedule: { enabled: true, jobs: [{ at: '09:10', symbol: 'BTC', mode: 'algo' }] } };
const at0910 = new Date(2026, 8, 28, 9, 10, 5); // 로컬 시각 09:10

test('scheduler: 지정 분에 잡을 한 번만 실행한다', async () => {
  const engine = makeEngine();
  const s = new Scheduler({ engine, config: cfg, notify: null });
  s._tick(at0910);
  s._tick(new Date(at0910.getTime() + 20 * 1000));
  await new Promise((r) => setImmediate(r));
  assert.equal(engine.runs.length, 1);
  assert.equal(engine.runs[0].symbol, 'BTC');
  assert.equal(engine.runs[0].opts.source, 'schedule', '성적표에서 정기 판정으로 구분');
  assert.equal(s.history[0].result, '판정 HOLD');
});

test('scheduler: 한도 소진(quotaExhaustedUntil) 중에는 실행하지 않고 건너뜀으로 기록한다', async () => {
  const engine = makeEngine({ quotaExhaustedUntil: at0910.getTime() + 60 * 60 * 1000 });
  const s = new Scheduler({ engine, config: cfg, notify: null });
  s._tick(at0910);
  await new Promise((r) => setImmediate(r));
  assert.equal(engine.runs.length, 0);
  assert.equal(s.history[0].result, '건너뜀');
  assert.match(s.history[0].message, /한도 소진/);
});

test('scheduler: 한도 리셋 시각이 지났으면 다시 실행한다', async () => {
  const engine = makeEngine({ quotaExhaustedUntil: at0910.getTime() - 1000 });
  const s = new Scheduler({ engine, config: cfg, notify: null });
  s._tick(at0910);
  await new Promise((r) => setImmediate(r));
  assert.equal(engine.runs.length, 1);
});

test('scheduler: 다른 분석이 진행 중이면 큐잉하지 않고 건너뛴다', async () => {
  const engine = makeEngine({ running: true });
  const s = new Scheduler({ engine, config: cfg, notify: null });
  s._tick(at0910);
  await new Promise((r) => setImmediate(r));
  assert.equal(engine.runs.length, 0);
  assert.equal(s.history[0].message, '다른 분석이 진행 중');
});

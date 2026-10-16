import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildStats } = require('../server/stats.js');

function writeTempDecisions(decisions) {
  const file = path.join(os.tmpdir(), `stats-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(decisions));
  return file;
}

// --- R:R 집계 버그 회귀 방지 — 모드별 비교표가 "R:R 데이터 없음"만 보여주던 문제 ------

test('buildStats: 모드별(byMode) 평균 R:R이 실제로 계산된다(예전엔 이 필드 자체가 없었다)', async () => {
  const file = writeTempDecisions([
    { ts: '2026-09-19T10:00:00Z', symbol: 'BTC', mode: 'algo', action: 'BUY', confidence: 54, rr: 1.83 },
    { ts: '2026-09-19T11:00:00Z', symbol: 'BTC', mode: 'algo', action: 'SELL', confidence: 58, rr: 2.5 },
  ]);
  const stats = await buildStats({ file });
  assert.equal(stats.byMode.algo.avgRR, 2.17); // (1.83+2.5)/2 반올림
});

test('buildStats: R:R이 없는(HOLD 등) 판정은 평균에서 자연히 빠진다(0으로 왜곡되지 않는다)', async () => {
  const file = writeTempDecisions([
    { ts: '2026-09-19T10:00:00Z', symbol: 'BTC', mode: 'algo', action: 'BUY', confidence: 54, rr: 2 },
    { ts: '2026-09-19T11:00:00Z', symbol: 'BTC', mode: 'algo', action: 'HOLD', confidence: 60 }, // rr 없음
  ]);
  const stats = await buildStats({ file });
  assert.equal(stats.byMode.algo.avgRR, 2); // HOLD이 0으로 섞여 평균이 1이 되면 안 된다
});

test('buildStats: R:R은 가격 데이터가 없어 pending이어도(승패 평가와 무관하게) 집계된다', async () => {
  // priceLookup을 아예 안 줘서 전부 pending이 되는 상황 — 그래도 R:R은 판정 당시
  // 이미 계산된 값이라 집계돼야 한다(가격 데이터 유무와 R:R은 독립적).
  const file = writeTempDecisions([
    { ts: '2026-09-19T10:00:00Z', symbol: 'BTC', mode: 'algo', action: 'BUY', confidence: 54, rr: 3 },
  ]);
  const stats = await buildStats({ file }); // priceLookup 없음
  assert.equal(stats.byMode.algo.pending, 1);
  assert.equal(stats.byMode.algo.avgRR, 3);
});

test('buildStats: 전체(overall)·확신도 버킷(byConfidence)에도 avgRR이 채워진다', async () => {
  const file = writeTempDecisions([
    { ts: '2026-09-19T10:00:00Z', symbol: 'BTC', mode: 'algo', action: 'BUY', confidence: 54, rr: 2 },
  ]);
  const stats = await buildStats({ file });
  assert.equal(stats.overall.avgRR, 2);
  const bucket = stats.byConfidence.find((b) => b.bucket === '50-59');
  assert.equal(bucket.avgRR, 2);
});

// --- scalp/attack 폐지 반영 — 비교표에 죽은 모드가 독립 줄로 안 남는다 -----------------

test('buildStats: byMode에 scalp·attack 전용 줄이 더 이상 없다(algo·unknown만 있다)', async () => {
  const file = writeTempDecisions([{ ts: '2026-09-19T10:00:00Z', symbol: 'BTC', mode: 'algo', action: 'HOLD' }]);
  const stats = await buildStats({ file });
  assert.deepEqual(Object.keys(stats.byMode).sort(), ['algo', 'unknown']);
});

test('buildStats: 과거 scalp/attack 기록은 사라지지 않고 unknown으로 묶여 집계된다', async () => {
  const file = writeTempDecisions([
    { ts: '2026-09-13T10:00:00Z', symbol: 'SKHYNIX', mode: 'scalp', action: 'HOLD', confidence: 62, rr: 1.71 },
    { ts: '2026-09-13T11:00:00Z', symbol: 'BTC', mode: 'attack', action: 'BUY', confidence: 70, rr: 2.2 },
    { ts: '2026-09-19T10:00:00Z', symbol: 'BTC', mode: 'algo', action: 'BUY', confidence: 54, rr: 1.83 },
  ]);
  const stats = await buildStats({ file });
  assert.equal(stats.byMode.unknown.n, 2); // scalp 1건 + attack 1건
  assert.equal(stats.byMode.algo.n, 1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../ops/ai-switch.js');
// config.saveConfig 와 같은 깊은 합치기(객체는 안으로 들어가 바꾼 키만 덮는다)
const mergeInto = (base, patch) => { for (const [k, v] of Object.entries(patch)) { if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') mergeInto(base[k], v); else base[k] = v; } return base; };

test('ai-switch: 끄면 자동 분석·정기 분석만 꺼지고 감시 알림·추세추종은 그대로', () => {
  const cfg = { watcher: { enabled: true, autoAnalyze: true, alertKinds: ['move'] }, schedule: { enabled: true, jobs: [{ at: '09:10' }, { at: '22:10' }] }, trend: { enabled: true } };
  assert.deepEqual(S.describe(cfg), { autoAnalyze: true, schedule: true, jobs: 2, trend: true });
  const off = JSON.parse(JSON.stringify(cfg));
  mergeInto(off, S.patchFor('off'));
  assert.deepEqual(S.describe(off), { autoAnalyze: false, schedule: false, jobs: 2, trend: true });
  assert.equal(off.watcher.enabled, true, '급변동 알림은 남는다');
  assert.deepEqual(off.watcher.alertKinds, ['move']);
  mergeInto(off, S.patchFor('on'));
  assert.deepEqual(S.describe(off), S.describe(cfg));
  assert.equal(S.patchFor('x'), null);
  assert.match(S.line(S.describe(cfg)), /AI 자동 분석 켜짐 · 정기 분석 켜짐\(2개\) · 추세추종 주문 켜짐/);
});

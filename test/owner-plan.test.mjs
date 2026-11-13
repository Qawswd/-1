import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const O = require('../server/backtest/owner-plan.js');

test('account: 칸 크기만큼 더한다 · contestWindows: 시작 금액 대비 −15% 를 찍은 90일 창 비율', () => {
  const d = O.account([[[{ days: [{ t: 1, ret: 0.1 }] }], 0.2], [[{ days: [{ t: 1, ret: -0.1 }, { t: 2, ret: 0.05 }] }], 0.1]]);
  assert.ok(Math.abs(d[0].ret - 0.01) < 1e-12);
  assert.ok(Math.abs(d[1].ret - 0.005) < 1e-12);
  // 100일: 처음 10일 매일 −2%(−18%) 그다음 0 → 0일 시작 창은 −15% 를 찍는다
  const days = Array.from({ length: 100 }, (_, i) => ({ t: i, ret: i < 10 ? -0.02 : 0 }));
  const w = O.contestWindows(days, 0, { len: 90, loss: 15 });
  assert.equal(w.n, 11, '첫날 전 금액부터 — 시작점 0~10');
  assert.ok(w.hitPct > 0 && w.hitPct < 100);
  assert.ok(w.worst < -15);
});

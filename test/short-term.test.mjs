import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../server/backtest/short-term.js');

const DAY = 86400000;
const T0 = Date.UTC(2024, 0, 1);

test('volBreakout: 시가 + k×(어제 고가−저가)를 넘은 날만 그 가격에 사서 그날 종가(다음 날 시가)에 판다', () => {
  const d = [];
  for (let i = 0; i < 8; i++) d.push({ t: T0 + i * DAY, o: 100, h: 102, l: 98, c: 100, v: 1 }); // 어제 폭 4 → 목표 102(k=0.5)
  d.push({ t: T0 + 8 * DAY, o: 100, h: 105, l: 99, c: 104, v: 1 }); // 102 돌파 → 102 매수 104 매도
  const r = S.volBreakout(d, [], 0.5, false);
  // 앞 6일은 계산 준비, 6·7일째는 고가 102 = 목표 102 → 닿음(같으면 체결로 본다), 8일째 돌파
  assert.equal(r.n, 3);
  const r2 = S.volBreakout(d, [], 0.6, false); // 목표 102.4 → 8일째만
  assert.equal(r2.n, 1);
});

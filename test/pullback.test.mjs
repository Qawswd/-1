import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../server/backtest/pullback.js');

const DAY = 86400000;
const M15 = 900000;
// 일봉 0~3일 종가 100·101·102·103 (선 2·3) → 2일 종가에 초록. 15분봉은 하루 내내 그날 종가, 3일 첫 4시간 안에 101.4 까지 한 번 눌림.
const daily = [100, 101, 102, 103].map((c, i) => ({ t: i * DAY, o: c, h: c, l: c, c }));
const m15 = [];
for (let d = 0; d < 4; d++) for (let k = 0; k < 96; k++) {
  const p = daily[d].c;
  m15.push({ t: d * DAY + k * M15, o: p, h: p, l: d === 3 && k === 5 ? 101.4 : p, c: p });
}
const base = { cost: 0, fast: 2, slow: 3, smaLen: 2, tp: 0 };

test('dailyLights: 두 선 위 1 · 숏은 하락 배열일 때만', () => {
  const l = P.dailyLights(daily, { fast: 2, slow: 3 });
  assert.equal(l.get(2 * DAY), 1);
  assert.equal(l.get(1 * DAY), 0, '긴 선이 아직 없음');
  const down = [105, 104, 103, 102].map((c, i) => ({ t: i * DAY, c }));
  assert.equal(P.dailyLights(down, { fast: 2, slow: 3 }).get(3 * DAY), 0, '롱만이면 숏 없음');
  assert.equal(P.dailyLights(down, { fast: 2, slow: 3, allowShort: true }).get(3 * DAY), -1);
});

test('simulatePullback: 기준(E0)은 다음 날 시가 진입 · 눌림(E1)은 4시간 SMA 닿고 위로 마감한 다음 4시간 시가에, 손절은 눌림 바닥 아래', () => {
  const e0 = P.simulatePullback([...m15, { t: 4 * DAY, o: 92, h: 92, l: 92, c: 92 }], daily, { ...base, entry: 'daily', stop: 'fixed' });
  assert.equal(e0.trades.length, 1);
  assert.equal(e0.trades[0].entryT, 3 * DAY);
  assert.equal(e0.trades[0].reason, 'stop', '103 의 −10% = 92.7 을 시가 92 가 건너뜀');
  const e1 = P.simulatePullback([...m15, { t: 4 * DAY, o: 101, h: 101, l: 101, c: 101 }], daily, { ...base, entry: 'pullback', stop: 'pullback' });
  const t = e1.trades[0];
  assert.equal(t.entryT, 3 * DAY + 4 * 3600000, '첫 4시간봉이 101.4 까지 눌렸다 103 으로 마감 → 04:00 시가');
  assert.equal(t.reason, 'stop');
  assert.ok(Math.abs(t.r - (101 / 103 - 1) / ((103 - 101.4 * 0.999) / 103)) < 1e-9, '손절 = 눌림 바닥 101.4 의 0.1% 아래, 시가 갭은 시가에');
});

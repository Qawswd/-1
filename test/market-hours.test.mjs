import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isUsMarketHours, msUntilNextOpen, isNyWeekend } = require('../server/market-hours.js');

// 2026년 서머타임(EDT): 3/8(일) 02:00 ~ 11/1(일) 02:00 — 그 사이는 UTC-4, 그 밖은 UTC-5(EST)

test('EDT(여름, UTC-4): 개장 직전(09:29 현지)은 false', () => {
  // 2026-07-01 13:29 UTC = 09:29 EDT
  assert.equal(isUsMarketHours(new Date('2026-07-01T13:29:00Z')), false);
});

test('EDT(여름): 개장 시각(09:30 현지)은 true', () => {
  // 13:30 UTC = 09:30 EDT
  assert.equal(isUsMarketHours(new Date('2026-07-01T13:30:00Z')), true);
});

test('EDT(여름): 마감 직전(15:59 현지)은 true', () => {
  // 19:59 UTC = 15:59 EDT
  assert.equal(isUsMarketHours(new Date('2026-07-01T19:59:00Z')), true);
});

test('EDT(여름): 마감 시각(16:00 현지)은 false(경계 미포함)', () => {
  // 20:00 UTC = 16:00 EDT
  assert.equal(isUsMarketHours(new Date('2026-07-01T20:00:00Z')), false);
});

test('EST(겨울, UTC-5): 개장 직전(09:29 현지)은 false', () => {
  // 2026-01-15 14:29 UTC = 09:29 EST
  assert.equal(isUsMarketHours(new Date('2026-01-15T14:29:00Z')), false);
});

test('EST(겨울): 개장 시각(09:30 현지)은 true', () => {
  // 14:30 UTC = 09:30 EST
  assert.equal(isUsMarketHours(new Date('2026-01-15T14:30:00Z')), true);
});

test('EST(겨울): 마감 직전(15:59 현지)은 true', () => {
  // 20:59 UTC = 15:59 EST
  assert.equal(isUsMarketHours(new Date('2026-01-15T20:59:00Z')), true);
});

test('EST(겨울): 마감 시각(16:00 현지)은 false', () => {
  // 21:00 UTC = 16:00 EST
  assert.equal(isUsMarketHours(new Date('2026-01-15T21:00:00Z')), false);
});

test('같은 UTC 오프셋이라도 서머타임 여부에 따라 한 시간 어긋나지 않는다(고정 KST 하드코딩 방지 확인)', () => {
  // 20:30 UTC — 여름(EDT)엔 16:30 현지(마감 후, false), 겨울(EST)엔 15:30 현지(장중, true).
  // KST 고정 오프셋으로 잘못 계산했다면 이 둘의 결과가 같아져 버렸을 것이다.
  const summer = isUsMarketHours(new Date('2026-07-01T20:30:00Z'));
  const winter = isUsMarketHours(new Date('2026-01-15T20:30:00Z'));
  assert.equal(summer, false);
  assert.equal(winter, true);
  assert.notEqual(summer, winter);
});

test('isNyWeekend: 뉴욕 기준 토·일은 true, 평일은 false', () => {
  // 2026-09-19(토)·09-20(일) 14:00 UTC — 뉴욕 기준으로도 여전히 그 날짜(오전 10시 EDT)
  assert.equal(isNyWeekend(new Date('2026-09-19T14:00:00Z')), true);
  assert.equal(isNyWeekend(new Date('2026-09-20T14:00:00Z')), true);
  assert.equal(isNyWeekend(new Date('2026-09-18T14:00:00Z')), false); // 금요일
  assert.equal(isNyWeekend(new Date('2026-09-21T14:00:00Z')), false); // 월요일
});

test('isUsMarketHours: 주말은 장중 시간대(09:30~16:00)여도 false — 실제 증시가 닫혀있다', () => {
  // 2026-07-04(토) 14:00 UTC = 10:00 EDT. 시각만 보면 장중이지만 토요일이라 false여야 한다.
  assert.equal(isUsMarketHours(new Date('2026-07-04T14:00:00Z')), false);
  // 같은 주 수요일(07-01) 같은 현지 시각은 true — 시각 판정 자체는 안 바뀌었다는 대조군.
  assert.equal(isUsMarketHours(new Date('2026-07-01T14:00:00Z')), true);
});

test('isUsMarketHours: 일요일도 false', () => {
  assert.equal(isUsMarketHours(new Date('2026-09-20T14:00:00Z')), false); // 일요일 10:00 EDT
});

test('msUntilNextOpen: 금요일 마감 후면 토·일을 건너뛰고 월요일 개장까지 계산한다', () => {
  // 2026-09-18(금) 18:00 EDT(마감 2시간 후) = 22:00 UTC
  // → 2026-09-21(월) 09:30 EDT 개장까지 63.5시간 남아야 한다(토·일 이틀을 그냥 더하는 게 아니라
  //   실제로 다음 "장이 열리는" 순간까지 정확히 계산돼야 한다).
  const ms = msUntilNextOpen(new Date('2026-09-18T22:00:00Z'));
  assert.equal(ms, 63.5 * 60 * 60 * 1000);
});

test('msUntilNextOpen: 토요일 한낮이어도 0이 아니라(장중 아님) 월요일 개장까지 남은 시간을 준다', () => {
  const ms = msUntilNextOpen(new Date('2026-09-19T14:00:00Z')); // 토요일 10:00 EDT
  assert.ok(ms > 0, '토요일엔 장중이 아니므로 0이면 안 된다');
  // 토요일 10:00 EDT → 월요일 09:30 EDT까지 정확히 47.5시간
  assert.equal(ms, 47.5 * 60 * 60 * 1000);
});

test('msUntilNextOpen: 장중이면 0', () => {
  assert.equal(msUntilNextOpen(new Date('2026-07-01T14:00:00Z')), 0);
});

test('msUntilNextOpen: 개장 전이면 남은 시간이 양수', () => {
  // 09:00 EDT(개장 30분 전) = 13:00 UTC
  const ms = msUntilNextOpen(new Date('2026-07-01T13:00:00Z'));
  assert.equal(ms, 30 * 60 * 1000);
});

test('msUntilNextOpen: 마감 후면 다음날 개장까지 남은 시간(양수)', () => {
  // 17:00 EDT(마감 1시간 후) = 21:00 UTC → 다음날 09:30 EDT까지 16.5시간 남음
  // (17:00→24:00은 7시간, 00:00→09:30은 9.5시간, 합 16.5시간)
  const ms = msUntilNextOpen(new Date('2026-07-01T21:00:00Z'));
  assert.equal(ms, 16.5 * 60 * 60 * 1000);
});

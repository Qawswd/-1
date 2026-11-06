'use strict';

// market-hours.js — 미국 주식 정규장 시간대 판별 ("출퇴근제")
//
// 원칙
// - KST(한국시간) 고정 오프셋을 하드코딩하지 않는다. 서머타임(EDT/EST) 전환 시점마다
//   한 시간씩 틀어지기 때문이다. 대신 항상 America/New_York 타임존으로 직접 변환해서
//   "현지 시각이 09:30~16:00 사이인가"만 본다 — 서버가 어느 타임존에서 돌아가든
//   (이 서버는 UTC) 정확하다.
// - 미국 증시 휴장일(추수감사절 등)은 의도적으로 반영하지 않는다. 이 프로젝트가 보는
//   것은 바이낸스의 주식 연계 무기한 선물이고, 바이낸스 자체는 휴장이 없기 때문에
//   "매일 같은 시간대"로 동작하는 것이 설계 의도다(사용자 확인 완료).
// - 외부 의존성 0. Node 내장 Intl만 쓴다.

const MARKET_OPEN_MIN = 9 * 60 + 30; // 09:30
const MARKET_CLOSE_MIN = 16 * 60; // 16:00

// date를 America/New_York 현지 시각의 "자정부터 지난 분(0~1439)"으로 변환한다.
function nyMinutesOfDay(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  // Intl은 자정을 "24"로 표기하기도 한다(hour12:false 특성) — 24는 0으로 다룬다.
  const hour = Number(map.hour) % 24;
  const minute = Number(map.minute);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

// 지금(또는 인자로 준 시각)이 미국 정규장 시간대(09:30~16:00 America/New_York)인지.
// 요일 제한 없음 — 매일 같은 시간대로 판단한다(위 설계 의도 참고).
function isUsMarketHours(date) {
  const d = date instanceof Date ? date : new Date();
  const minutes = nyMinutesOfDay(d);
  if (minutes === null) return false;
  return minutes >= MARKET_OPEN_MIN && minutes < MARKET_CLOSE_MIN;
}

// 다음 개장까지 남은 밀리초(이미 장중이면 0). 상태 표시용.
function msUntilNextOpen(date) {
  const d = date instanceof Date ? date : new Date();
  const minutes = nyMinutesOfDay(d);
  if (minutes === null) return null;
  if (minutes >= MARKET_OPEN_MIN && minutes < MARKET_CLOSE_MIN) return 0;
  const minutesUntilOpen =
    minutes < MARKET_OPEN_MIN
      ? MARKET_OPEN_MIN - minutes
      : 24 * 60 - minutes + MARKET_OPEN_MIN; // 이미 마감 → 다음날 개장까지
  return minutesUntilOpen * 60 * 1000;
}

module.exports = { isUsMarketHours, msUntilNextOpen, nyMinutesOfDay, MARKET_OPEN_MIN, MARKET_CLOSE_MIN };

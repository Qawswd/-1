'use strict';

// market-hours.js — 미국 주식 정규장 시간대 판별 ("출퇴근제")
//
// 원칙
// - KST(한국시간) 고정 오프셋을 하드코딩하지 않는다. 서머타임(EDT/EST) 전환 시점마다
//   한 시간씩 틀어지기 때문이다. 대신 항상 America/New_York 타임존으로 직접 변환해서
//   "현지 시각이 09:30~16:00 사이인가"만 본다 — 서버가 어느 타임존에서 돌아가든
//   (이 서버는 UTC) 정확하다.
// - 요일은 본다(월~금만) — 처음엔 "바이낸스 자체는 휴장이 없다"는 이유로 요일을
//   안 봤지만, 그건 BTC 하나만 있을 때 얘기다. 지금은 AAPL·MSFT 같은 진짜 미국
//   주식 연계 상품도 워치리스트에 있고, 이런 상품은 주말엔 실제 뉴욕 증시가 닫혀있어
//   가격이 왜곡되거나 거래량이 거의 없을 수 있다 — 그 상태에서 "크게 움직였다"는
//   신호는 진짜 시장 움직임이 아니라 착시에 가깝다. "회사는 평일 특정 시간에만
//   연다"는 원래의 출퇴근제 취지에도 맞다(사용자 확인 완료). BTC 입장에서는 이미
//   이전부터 이 좁은 시간대 밖에서는 자동 진입이 안 나가고 있었으므로, 주말도
//   같은 맥락에서 막는 것이지 새로운 종류의 제약이 아니다.
// - 미국 증시 휴장일(추수감사절 등 특정 날짜)은 반영하지 않는다 — 그건 날짜를
//   해마다 갱신해야 하는 별도 목록이 필요해서다. 요일(주말)만 본다.
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

// date가 America/New_York 현지 기준 토·일인지. UTC 기준으로 보면 자정을 넘나드는
// 시간대라 요일이 하루 어긋날 수 있어, 반드시 현지 타임존으로 변환해서 봐야 한다.
function isNyWeekend(date) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(date);
  return wd === 'Sat' || wd === 'Sun';
}

// 지금(또는 인자로 준 시각)이 미국 정규장 시간대(평일 09:30~16:00 America/New_York)인지.
function isUsMarketHours(date) {
  const d = date instanceof Date ? date : new Date();
  if (isNyWeekend(d)) return false;
  const minutes = nyMinutesOfDay(d);
  if (minutes === null) return false;
  return minutes >= MARKET_OPEN_MIN && minutes < MARKET_CLOSE_MIN;
}

// 다음 개장까지 남은 밀리초(이미 장중이면 0). 상태 표시용.
// isUsMarketHours를 그대로 재사용해 1분 단위로 앞으로 훑는다 — 주말·서머타임 경계를
// 손으로 계산하다 실수하는 것보다, 이미 검증된 판정 함수를 반복 호출하는 쪽이 안전하다
// (최대 10일 앞까지 보면 되고, 상태 조회는 자주 일어나는 호출이 아니라 성능은 무관하다).
function msUntilNextOpen(date) {
  const d = date instanceof Date ? date : new Date();
  if (isUsMarketHours(d)) return 0;
  const MAX_MINUTES = 10 * 24 * 60;
  for (let m = 1; m <= MAX_MINUTES; m++) {
    const candidate = new Date(d.getTime() + m * 60 * 1000);
    if (isUsMarketHours(candidate)) return m * 60 * 1000;
  }
  return null; // 이론상 도달하지 않는다
}

module.exports = { isUsMarketHours, msUntilNextOpen, isNyWeekend, nyMinutesOfDay, MARKET_OPEN_MIN, MARKET_CLOSE_MIN };

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findReleaseId,
  fetchUpcomingDates,
  buildEconomicCalendarLines,
  fetchEconomicCalendar,
  fetchReleasesList,
  firstBusinessDayOfMonth,
  nthWeekdayOfMonth,
  lastWeekdayOfMonth,
  estimateRuleBasedEvents,
  _setFetch,
  _resetCache,
} = require('../server/fred-calendar.js');

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj };
}

// --- findReleaseId (순수 함수) -----------------------------------------------

test('findReleaseId: 이름이 부분 일치하면 id를 찾는다', () => {
  const list = [
    { id: 9, name: 'Advance Monthly Sales for Retail and Food Services' },
    { id: 10, name: 'Consumer Price Index' },
  ];
  assert.equal(findReleaseId(list, ['consumer price index']), 10);
});

test('findReleaseId: 대소문자 무관하게 매칭한다', () => {
  const list = [{ id: 10, name: 'Consumer Price Index' }];
  assert.equal(findReleaseId(list, ['CONSUMER price INDEX']), 10);
});

test('findReleaseId: 여러 검색어 중 하나만 맞아도 찾는다', () => {
  const list = [{ id: 3, name: 'Unemployment Insurance Weekly Claims Report' }];
  assert.equal(findReleaseId(list, ['does not exist', 'weekly claims']), 3);
});

test('findReleaseId: 매칭되는 게 없으면 null(지어내지 않음)', () => {
  const list = [{ id: 10, name: 'Consumer Price Index' }];
  assert.equal(findReleaseId(list, ['ism manufacturing pmi']), null);
});

test('findReleaseId: 빈 배열/잘못된 입력은 null', () => {
  assert.equal(findReleaseId([], ['cpi']), null);
  assert.equal(findReleaseId(null, ['cpi']), null);
  assert.equal(findReleaseId([{ id: 1, name: 'x' }], []), null);
});

// --- fetchUpcomingDates (가짜 fetch) ------------------------------------------

test('fetchUpcomingDates: 미래 날짜만 필터링해서 배열로 준다', async () => {
  const now = Date.parse('2026-09-21T00:00:00Z');
  _setFetch(async (url) => {
    assert.match(url, /include_release_dates_with_no_data=true/); // 핵심 파라미터 확인
    return jsonResponse({
      release_dates: [
        { release_id: 10, date: '2026-09-15' }, // 과거 — 빠져야 함
        { release_id: 10, date: '2026-09-25' },
        { release_id: 10, date: '2026-10-01' },
      ],
    });
  });
  const dates = await fetchUpcomingDates(10, 'fake-key', { now, windowDays: 14 });
  _setFetch(null);
  assert.deepEqual(dates, ['2026-09-25', '2026-10-01']);
});

test('fetchUpcomingDates: 응답이 비정상이어도(release_dates 없음) 빈 배열', async () => {
  _setFetch(async () => jsonResponse({}));
  const dates = await fetchUpcomingDates(10, 'fake-key', {});
  _setFetch(null);
  assert.deepEqual(dates, []);
});

test('fetchUpcomingDates: HTTP 오류면 예외를 던진다(호출부가 처리)', async () => {
  _setFetch(async () => jsonResponse({}, 500));
  await assert.rejects(fetchUpcomingDates(10, 'fake-key', {}));
  _setFetch(null);
});

// --- buildEconomicCalendarLines (순수 함수) -----------------------------------

test('buildEconomicCalendarLines: 날짜순으로 정렬하고 오늘/내일/N일 후를 정확히 표시한다', () => {
  const now = Date.parse('2026-09-21T00:00:00Z');
  const events = [
    { date: '2026-09-23', label: 'CPI' },
    { date: '2026-09-21', label: 'FOMC' },
    { date: '2026-09-22', label: 'GDP' },
  ];
  const lines = buildEconomicCalendarLines(events, now);
  assert.equal(lines.length, 3);
  assert.match(lines[0], /2026-09-21\(오늘\) — FOMC/);
  assert.match(lines[1], /2026-09-22\(내일\) — GDP/);
  assert.match(lines[2], /2026-09-23\(2일 후\) — CPI/);
});

test('buildEconomicCalendarLines: 이벤트가 없으면 안내 문구 하나만', () => {
  const lines = buildEconomicCalendarLines([], Date.now());
  assert.equal(lines.length, 1);
  assert.match(lines[0], /데이터 없음/);
});

test('buildEconomicCalendarLines: 잘못된 입력(배열 아님)도 안전하게 안내 문구', () => {
  const lines = buildEconomicCalendarLines(null, Date.now());
  assert.equal(lines.length, 1);
});

// --- fetchEconomicCalendar (오케스트레이션, 가짜 fetch) -------------------------

test('fetchEconomicCalendar: FRED_API_KEY가 없으면 조회 자체를 안 하고 ok:false', async () => {
  const prev = process.env.FRED_API_KEY;
  delete process.env.FRED_API_KEY;
  try {
    const r = await fetchEconomicCalendar({});
    assert.equal(r.ok, false);
    assert.match(r.error, /FRED_API_KEY/);
  } finally {
    if (prev !== undefined) process.env.FRED_API_KEY = prev;
  }
});

test('fetchEconomicCalendar: 정상 흐름 — 찾은 지표는 이벤트로, 규칙 기반 추정(ISM·ADP·CB)도 함께 섞여 들어간다', async () => {
  _resetCache();
  process.env.FRED_API_KEY = 'fake-key';
  const now = Date.parse('2026-09-21T00:00:00Z');
  _setFetch(async (url) => {
    if (url.includes('/releases?')) {
      return jsonResponse({
        releases: [
          { id: 10, name: 'Consumer Price Index' },
          { id: 53, name: 'Gross Domestic Product' },
        ],
      });
    }
    if (url.includes('release_id=10')) {
      return jsonResponse({ release_dates: [{ release_id: 10, date: '2026-09-30' }] });
    }
    if (url.includes('release_id=53')) {
      return jsonResponse({ release_dates: [{ release_id: 53, date: '2026-10-29' }] });
    }
    return jsonResponse({}, 404);
  });
  const r = await fetchEconomicCalendar({ now });
  _setFetch(null);
  assert.equal(r.ok, true);
  // FRED 확정 2건(CPI, GDP) + 규칙 기반 추정 3건(이 기간엔 ISM·ADP·CB 각 1개씩 걸림) = 5건.
  assert.equal(r.events.length, 5);
  assert.ok(r.events.some((e) => e.label.includes('ISM 제조업 PMI') && e.label.includes('추정')));
  assert.ok(r.events.some((e) => e.label.includes('ADP 비농업고용') && e.label.includes('추정')));
  assert.ok(r.events.some((e) => e.label.includes('CB 소비자신뢰지수') && e.label.includes('추정')));
  // ISM·ADP·CB는 이제 FRED 검색 대상이 아니므로 notFound에 안 들어간다.
  assert.ok(!r.notFound.includes('ISM 제조업 PMI'));
});

test('fetchEconomicCalendar: 발표목록 조회 자체가 실패해도 에러 없이 ok:false로 돌려준다', async () => {
  _resetCache();
  process.env.FRED_API_KEY = 'fake-key';
  _setFetch(async () => jsonResponse({}, 500));
  const r = await fetchEconomicCalendar({});
  _setFetch(null);
  assert.equal(r.ok, false);
  assert.equal(r.events.length, 0);
});

test('fetchEconomicCalendar: 지표 하나의 날짜 조회가 실패해도 나머지(FRED+규칙 기반)는 계속 모은다', async () => {
  _resetCache();
  process.env.FRED_API_KEY = 'fake-key';
  const now = Date.parse('2026-09-21T00:00:00Z');
  _setFetch(async (url) => {
    if (url.includes('/releases?')) {
      return jsonResponse({
        releases: [
          { id: 10, name: 'Consumer Price Index' },
          { id: 53, name: 'Gross Domestic Product' },
        ],
      });
    }
    if (url.includes('release_id=10')) return jsonResponse({}, 500); // CPI 조회 실패
    if (url.includes('release_id=53')) {
      return jsonResponse({ release_dates: [{ release_id: 53, date: '2026-10-29' }] });
    }
    return jsonResponse({}, 404);
  });
  const r = await fetchEconomicCalendar({ now });
  _setFetch(null);
  assert.equal(r.ok, true);
  // GDP(FRED) 1건 + 규칙 기반 추정 3건 = 4건. CPI는 조회 실패했으니 안 들어간다.
  assert.equal(r.events.length, 4);
  assert.ok(r.events.some((e) => e.label === 'GDP(국내총생산)'));
});

// --- fetchReleasesList (캐시) --------------------------------------------------

test('fetchReleasesList: 같은 호출을 두 번 해도 실제 fetch는 한 번만 나간다(캐시)', async () => {
  _resetCache();
  let calls = 0;
  _setFetch(async () => {
    calls++;
    return jsonResponse({ releases: [{ id: 10, name: 'Consumer Price Index' }] });
  });
  await fetchReleasesList('fake-key');
  await fetchReleasesList('fake-key');
  _setFetch(null);
  assert.equal(calls, 1);
});

// --- 규칙 기반 추정 함수 (순수 함수, 실제 계산값으로 검증) ---------------------------

test('firstBusinessDayOfMonth: 1일이 평일이면 그대로 1일', () => {
  const d = firstBusinessDayOfMonth(2026, 0); // 2026-01-01은 목요일
  assert.equal(d.toISOString().slice(0, 10), '2026-01-01');
});

test('firstBusinessDayOfMonth: 1일이 토요일이면 월요일로 넘어간다', () => {
  const d = firstBusinessDayOfMonth(2026, 7); // 2026-08-01은 토요일
  assert.equal(d.toISOString().slice(0, 10), '2026-08-03');
});

test('nthWeekdayOfMonth: 그 달 첫째주 금요일을 정확히 찾는다', () => {
  const d = nthWeekdayOfMonth(2026, 8, 5, 1); // 2026년 9월 첫째주 금요일
  assert.equal(d.toISOString().slice(0, 10), '2026-09-04');
});

test('lastWeekdayOfMonth: 그 달 마지막 화요일을 정확히 찾는다', () => {
  const d1 = lastWeekdayOfMonth(2026, 8, 2); // 2026년 9월
  assert.equal(d1.toISOString().slice(0, 10), '2026-09-29');
  const d2 = lastWeekdayOfMonth(2026, 1, 2); // 2026년 2월(짧은 달)
  assert.equal(d2.toISOString().slice(0, 10), '2026-02-24');
});

test('estimateRuleBasedEvents: 라벨에 항상 "(추정"이 포함돼 FRED 확정 지표와 구분된다', () => {
  const events = estimateRuleBasedEvents(Date.parse('2026-09-21T00:00:00Z'), 30);
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.label.includes('추정')));
});

test('estimateRuleBasedEvents: windowDays 밖의 이벤트는 제외된다', () => {
  const events = estimateRuleBasedEvents(Date.parse('2026-09-21T00:00:00Z'), 3); // 3일 안엔 아무 규칙 이벤트도 없어야 함
  assert.equal(events.length, 0);
});

test('estimateRuleBasedEvents: 과거 날짜(이미 지난 이번 달 일정)는 포함하지 않는다', () => {
  const events = estimateRuleBasedEvents(Date.parse('2026-09-21T00:00:00Z'), 14);
  for (const e of events) {
    assert.ok(e.date >= '2026-09-21');
  }
});

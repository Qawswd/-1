'use strict';

// fred-calendar.js — FRED(세인트루이스 연방준비은행) 공식 API로 주요 경제지표 발표
// 일정을 가져온다. 지금은 AI 분석 시 "오늘/이번 주 이런 발표가 있다"는 참고 자료로만
// 쓴다 — 실행(주문)을 막거나 지연시키지 않는다. "발표 직전엔 신규 진입을 멈춘다"는
// 기능은 오늘 밤 실전 가동을 지켜본 뒤 별도로 만든다(실행 경로를 건드리는 변경은
// 더 신중하게 가는 게 맞다).
//
// 무료 API 키가 필요하다(.env의 FRED_API_KEY) — https://fred.stlouisfed.org/docs/api/api_key.html
// ISM 제조업 PMI·ADP 고용·CB 소비자신뢰지수처럼 민간기관이 만드는 지표는 FRED
// 발표목록(release)에 없을 수 있다 — 못 찾으면 그 지표만 조용히 건너뛴다(지어내지
// 않는다). 원칙은 이 프로젝트의 다른 외부 데이터 연동(SEC EDGAR 등)과 같다.

const FRED_BASE = 'https://api.stlouisfed.org/fred';

let fetchImpl = (...args) => fetch(...args);
function _setFetch(fn) {
  fetchImpl = typeof fn === 'function' ? fn : (...args) => fetch(...args);
}

async function doFetch(url) {
  const res = await fetchImpl(url);
  if (!res.ok) {
    const err = new Error(`FRED 요청 실패: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// --------------------------------------------------------------------------
// 발표목록(release) 캐시 — 158개 안팎으로 작고 자주 안 바뀐다. 매번 새로 받을 이유가
// 없어서 24시간 정도 메모리에 캐시해둔다.
// --------------------------------------------------------------------------

let _releasesCache = null; // { list, fetchedAt }
const RELEASES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// 테스트 전용 — 캐시를 비운다.
function _resetCache() {
  _releasesCache = null;
}

async function fetchReleasesList(apiKey) {
  if (_releasesCache && Date.now() - _releasesCache.fetchedAt < RELEASES_CACHE_TTL_MS) {
    return _releasesCache.list;
  }
  const url = `${FRED_BASE}/releases?api_key=${encodeURIComponent(apiKey)}&file_type=json`;
  const data = await doFetch(url);
  const list = Array.isArray(data && data.releases) ? data.releases : [];
  _releasesCache = { list, fetchedAt: Date.now() };
  return list;
}

// --------------------------------------------------------------------------
// 순수 함수 — 검색어로 release_id를 찾는다(이름 부분 일치, 대소문자 무관).
// --------------------------------------------------------------------------

function findReleaseId(releasesList, searchTerms) {
  if (!Array.isArray(releasesList) || !Array.isArray(searchTerms) || !searchTerms.length) return null;
  const terms = searchTerms.map((t) => String(t).toLowerCase());
  for (const r of releasesList) {
    const name = String((r && r.name) || '').toLowerCase();
    if (terms.some((t) => name.includes(t))) return r.id;
  }
  return null;
}

// --------------------------------------------------------------------------
// 특정 release_id의 앞으로 다가올 발표일을 조회한다.
// include_release_dates_with_no_data=true가 핵심이다 — 이게 없으면 아직 데이터가
// 없는(=미래) 발표일이 응답에서 빠진다(공식 문서에 명시된 동작).
// --------------------------------------------------------------------------

async function fetchUpcomingDates(releaseId, apiKey, { now, windowDays = 14 } = {}) {
  const n = Number.isFinite(now) ? now : Date.now();
  const start = new Date(n).toISOString().slice(0, 10);
  const end = new Date(n + windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const url =
    `${FRED_BASE}/releases/dates?release_id=${encodeURIComponent(releaseId)}&api_key=${encodeURIComponent(apiKey)}` +
    `&file_type=json&include_release_dates_with_no_data=true` +
    `&realtime_start=${start}&realtime_end=${end}&sort_order=asc`;
  const data = await doFetch(url);
  const dates = Array.isArray(data && data.release_dates) ? data.release_dates : [];
  return dates.map((d) => d && d.date).filter((d) => typeof d === 'string' && d >= start);
}

// --------------------------------------------------------------------------
// 요약 줄 만들기 (순수 함수)
// --------------------------------------------------------------------------

function daysUntil(dateStr, now) {
  const n = Number.isFinite(now) ? now : Date.now();
  const target = new Date(`${dateStr}T00:00:00Z`).getTime();
  const today = new Date(`${new Date(n).toISOString().slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((target - today) / (24 * 60 * 60 * 1000));
}

function buildEconomicCalendarLines(events, now) {
  if (!Array.isArray(events) || !events.length) {
    return ['앞으로 예정된 주요 경제지표 발표 데이터 없음(조회 실패 또는 설정 안 됨)'];
  }
  const sorted = [...events].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return sorted.map((e) => {
    const d = daysUntil(e.date, now);
    const when = d === 0 ? '오늘' : d === 1 ? '내일' : `${d}일 후`;
    return `${e.date}(${when}) — ${e.label}`;
  });
}

// --------------------------------------------------------------------------
// 규칙 기반 추정 — ISM 제조업 PMI·ADP 고용·CB 소비자신뢰지수는 민간기관이 만들어서
// FRED 발표목록에 없다. 대신 각 기관이 공식적으로 밝힌 "몇 번째 영업일/요일에
// 나온다"는 패턴으로 계산한다(ISM 자체 공지: "매달 첫 영업일". ADP: 통상 그 달
// 첫째주 금요일 NFP 발표 이틀 전인 수요일. CB: 통상 그 달 마지막 화요일).
//
// 이건 FRED처럼 "공식 확정된" 날짜가 아니라 "일반적인 패턴으로 계산한 추정"이다 —
// 공휴일 등으로 실제 날짜가 며칠 밀릴 수 있다(ISM도 스스로 "휴일 때문에 밀릴 수
// 있다"고 밝힌다). 그래서 라벨에 "(추정)"을 붙여 FRED 확정 지표와 구분한다 —
// AI가 이 차이를 알고 판단하는 게, 구분 없이 섞어서 "확정"인 척하는 것보다 낫다.
// --------------------------------------------------------------------------

function firstBusinessDayOfMonth(year, month) {
  let d = new Date(Date.UTC(year, month, 1));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d = new Date(d.getTime() + 24 * 60 * 60 * 1000);
  }
  return d;
}

function nthWeekdayOfMonth(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month, 1));
  const firstWeekday = first.getUTCDay();
  const day = 1 + ((weekday - firstWeekday + 7) % 7) + (n - 1) * 7;
  return new Date(Date.UTC(year, month, day));
}

function lastWeekdayOfMonth(year, month, weekday) {
  const lastDate = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month, lastDate));
  const diff = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month, lastDate - diff));
}

function fmtUtcDate(d) {
  return d.toISOString().slice(0, 10);
}

function estimateRuleBasedEvents(now, windowDays) {
  const n = Number.isFinite(now) ? now : Date.now();
  const startD = new Date(n);
  const endMs = n + windowDays * 24 * 60 * 60 * 1000;
  const startStr = fmtUtcDate(startD);
  const events = [];

  // 이번 달·다음 달 두 달치를 계산해두고, 요청한 기간(windowDays) 안에 드는 것만
  // 남긴다 — 월말에 조회하면 다음 달 초 일정도 걸릴 수 있어서다.
  for (let offset = 0; offset <= 1; offset++) {
    const base = new Date(Date.UTC(startD.getUTCFullYear(), startD.getUTCMonth() + offset, 1));
    const y = base.getUTCFullYear();
    const m = base.getUTCMonth();

    events.push({ date: fmtUtcDate(firstBusinessDayOfMonth(y, m)), label: 'ISM 제조업 PMI(추정 — 매달 첫 영업일)' });
    events.push({ date: fmtUtcDate(lastWeekdayOfMonth(y, m, 2)), label: 'CB 소비자신뢰지수(추정 — 매달 마지막 화요일)' });

    // ADP는 통상 그 달 NFP(첫째주 금요일) 발표 이틀 전인 수요일.
    const nfpFriday = nthWeekdayOfMonth(y, m, 5, 1);
    const adpDate = new Date(nfpFriday.getTime() - 2 * 24 * 60 * 60 * 1000);
    events.push({ date: fmtUtcDate(adpDate), label: 'ADP 비농업고용(추정 — NFP 이틀 전 수요일)' });
  }

  return events.filter((e) => {
    const t = new Date(`${e.date}T00:00:00Z`).getTime();
    return e.date >= startStr && t <= endMs;
  });
}

// --------------------------------------------------------------------------
// 오케스트레이션 — 지표별로 FRED 발표목록에서 이름을 찾아 앞으로의 발표일을 모으고,
// FRED에 없는 민간지표 몇 개는 규칙 기반 추정으로 보충한다.
// --------------------------------------------------------------------------

// 검색어는 FRED 공식 release 이름과 부분 일치해야 매칭된다. 여기 없는(ISM·ADP·CB)
// 지표는 위 estimateRuleBasedEvents가 별도로 계산해서 보충한다.
const INDICATORS = [
  { label: 'FOMC 금리결정', terms: ['federal open market committee'] },
  { label: 'CPI(소비자물가지수)', terms: ['consumer price index'] },
  { label: 'GDP(국내총생산)', terms: ['gross domestic product'] },
  { label: '비농업고용(NFP, 고용상황보고서)', terms: ['employment situation'] },
  { label: '신규실업수당청구건수', terms: ['unemployment insurance weekly claims', 'initial claims'] },
  { label: 'JOLTS(구인·이직보고서)', terms: ['job openings and labor turnover'] },
  { label: '신규주택판매', terms: ['new residential sales'] },
  { label: '원유재고(EIA)', terms: ['petroleum status report', 'weekly petroleum'] },
];

async function fetchEconomicCalendar({ windowDays = 14, now } = {}) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return { ok: false, error: 'FRED_API_KEY 설정 안 됨', events: [], lines: [], notFound: [] };

  let releasesList;
  try {
    releasesList = await fetchReleasesList(apiKey);
  } catch (e) {
    return { ok: false, error: e.message, events: [], lines: [], notFound: [] };
  }

  const events = [...estimateRuleBasedEvents(now, windowDays)]; // 규칙 기반 추정 먼저 채워둔다
  const notFound = [];
  for (const ind of INDICATORS) {
    const releaseId = findReleaseId(releasesList, ind.terms);
    if (!releaseId) {
      notFound.push(ind.label);
      continue;
    }
    try {
      const dates = await fetchUpcomingDates(releaseId, apiKey, { now, windowDays });
      for (const date of dates) events.push({ date, label: ind.label });
    } catch (e) {
      continue; // 이 지표 하나 실패해도 나머지는 계속 진행한다.
    }
  }

  return { ok: true, events, lines: buildEconomicCalendarLines(events, now), notFound };
}

module.exports = {
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
};

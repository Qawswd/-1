'use strict';

// analysis-budget.js — 하루 자동분석(12명 풀가동) 횟수 상한. 비용·한도를 아끼기 위해
// 하루 총 6번으로 제한하고, 용도별로 칸을 나눈다:
//   planning — 개장 전 계획 수립 (3단계에서 추가 예정)
//   level    — AI가 정해둔 진입가 도달 시 재확인 (3단계에서 추가 예정)
//   move     — 가격 급변 + 차트 구조 일치 트리거
// 칸을 나누는 이유: "선착순 6번"이면 오전 출렁임에 다 써버려서, 정작 AI가 준비해둔
// 진입가에 닿았을 때 분석을 못 하게 된다. 급변 트리거가 다른 칸을 뺏지 못하게 막는다.
//
// 수동 분석(대시보드 ANALYZE 버튼)은 여기서 세지 않는다 — 사람이 직접 판단해 누르는
// 것이라 막지 않는다(비용 기록 cost-log에는 그대로 남는다). 익절·충돌 조정 등 1명짜리
// 호출도 세지 않는다.
//
// 하루 기준은 뉴욕 거래일(America/New_York 날짜)이다. 서버가 재시작돼도 횟수가
// 초기화되지 않도록 파일(reports/analysis-budget.json)에 저장한다.

const fs = require('fs');
const path = require('path');

const DEFAULT_LIMITS = { total: 6, planning: 2, level: 2, move: 2 };
const STATE_PATH = path.join(__dirname, '..', 'reports', 'analysis-budget.json');

let _statePath = STATE_PATH;
function _setStatePath(p) {
  _statePath = p || STATE_PATH;
}
function _resetStatePath() {
  _statePath = STATE_PATH;
}

// 테스트 실행 중(node --test가 NODE_TEST_CONTEXT를 설정)에는 실제 기록 파일에 쓰지 않는다.
// 예전엔 npm test를 돌릴 때마다 가짜 기록이 실제 파일에 쌓여, 운영 데이터가 오염됐다
// (2026-09-25 발견). 테스트가 임시 경로를 지정한 경우(_setLogPath)는 그대로 쓴다.
function _writesBlocked(currentPath, defaultPath) {
  return !!process.env.NODE_TEST_CONTEXT && currentPath === defaultPath;
}


// 뉴욕 현지 날짜 'YYYY-MM-DD'. en-CA 로캘이 이 형식을 그대로 준다.
function nyDateKey(now) {
  const d = new Date(Number.isFinite(now) ? now : Date.now());
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function normalizeLimits(limits) {
  const l = limits && typeof limits === 'object' ? limits : {};
  const pick = (k) => (Number.isFinite(Number(l[k])) && Number(l[k]) >= 0 ? Number(l[k]) : DEFAULT_LIMITS[k]);
  return { total: pick('total'), planning: pick('planning'), level: pick('level'), move: pick('move') };
}

// 순수 함수 — 날짜가 바뀌었으면 카운트를 새로 시작한 상태를 돌려준다.
function freshStateFor(state, dateKey) {
  if (state && state.dateKey === dateKey && state.counts && typeof state.counts === 'object') {
    return { dateKey, counts: { ...state.counts } };
  }
  return { dateKey, counts: {} };
}

// 순수 함수 — 이 용도(category)로 1번 더 쓸 수 있는지 판정한다(실제로 쓰지는 않음).
function evaluate(state, category, limits) {
  const lim = normalizeLimits(limits);
  const counts = (state && state.counts) || {};
  const used = Number(counts[category]) || 0;
  const usedTotal = Object.values(counts).reduce((s, v) => s + (Number(v) || 0), 0);
  const catLimit = lim[category];
  if (!Number.isFinite(catLimit)) {
    return { ok: false, reason: `알 수 없는 분석 용도: ${category}`, used, usedTotal, catLimit: null, total: lim.total };
  }
  if (usedTotal >= lim.total) {
    return { ok: false, reason: `하루 총 분석 한도 ${lim.total}번 소진`, used, usedTotal, catLimit, total: lim.total };
  }
  if (used >= catLimit) {
    return { ok: false, reason: `오늘 ${category} 분석 한도 ${catLimit}번 소진`, used, usedTotal, catLimit, total: lim.total };
  }
  return { ok: true, reason: null, used, usedTotal, catLimit, total: lim.total };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(_statePath, 'utf8'));
  } catch (e) {
    return null; // 파일 없음·깨짐 — 오늘 처음으로 취급
  }
}

function saveState(state) {
  if (_writesBlocked(_statePath, STATE_PATH)) return;
  try {
    fs.mkdirSync(path.dirname(_statePath), { recursive: true });
    fs.writeFileSync(_statePath, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    // 저장 실패는 조용히 넘긴다 — 최악이어도 재시작 후 카운트가 새로 시작될 뿐이다.
  }
}

// 쓸 수 있는지 확인만 한다(카운트 증가 없음).
function canConsume(category, limits, now) {
  const state = freshStateFor(loadState(), nyDateKey(now));
  return evaluate(state, category, limits);
}

// 확인 후 가능하면 1회 사용으로 기록한다. 반환값은 evaluate 결과(ok=false면 기록 안 함).
function consume(category, limits, now) {
  const state = freshStateFor(loadState(), nyDateKey(now));
  const res = evaluate(state, category, limits);
  if (!res.ok) return res;
  state.counts[category] = (Number(state.counts[category]) || 0) + 1;
  saveState(state);
  return { ...res, used: res.used + 1, usedTotal: res.usedTotal + 1 };
}

// 대시보드·로그용 — 오늘 사용 현황.
function status(limits, now) {
  const state = freshStateFor(loadState(), nyDateKey(now));
  return { dateKey: state.dateKey, counts: state.counts, limits: normalizeLimits(limits) };
}

module.exports = {
  DEFAULT_LIMITS,
  nyDateKey,
  normalizeLimits,
  freshStateFor,
  evaluate,
  canConsume,
  consume,
  status,
  _setStatePath,
  _resetStatePath,
};

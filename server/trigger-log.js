'use strict';

// trigger-log.js — 한도(quota)와 완전히 무관하게, "가격/거래량 조건을 만족해서 분석이
// 진행됐을 트리거"를 그대로 기록한다. API 전환 시 실제로 하루에 몇 번 분석이 돌지,
// 정확한 숫자로 계산하기 위한 데이터 수집용이다 — 감으로 어림잡지 않기 위해서다.
//
// "한도가 없었다면 진행됐을" 시점(모든 다른 게이트 — 출퇴근제·차트 구조 필터 등은
// 이미 통과한 상태)에 기록한다. 그래서 한도 소진 여부와 무관하게 "진짜 트리거 빈도"를
// 정확히 잴 수 있다. 파일에 추가만 하는 방식(append-only)이라 구조가 단순하다.

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'reports', 'trigger-log.jsonl');

// 테스트에서 경로를 바꿔 끼울 수 있게(실제 파일을 안 건드리도록).
let _logPath = LOG_PATH;
function _setLogPath(p) {
  _logPath = p || LOG_PATH;
}
function _resetLogPath() {
  _logPath = LOG_PATH;
}

// 테스트 실행 중(node --test가 NODE_TEST_CONTEXT를 설정)에는 실제 기록 파일에 쓰지 않는다.
// 예전엔 npm test를 돌릴 때마다 가짜 기록이 실제 파일에 쌓여, 운영 데이터가 오염됐다
// (2026-09-25 발견). 테스트가 임시 경로를 지정한 경우(_setLogPath)는 그대로 쓴다.
function _writesBlocked(currentPath, defaultPath) {
  return !!process.env.NODE_TEST_CONTEXT && currentPath === defaultPath;
}


// 트리거 1건을 기록한다. 파일 쓰기가 실패해도(디스크 문제 등) 예외를 던지지 않는다 —
// 기록 실패로 실제 감시·분석 흐름이 끊기면 안 된다(부가 기능이 핵심 기능을 막지
// 않는다는 이 프로젝트의 일관된 원칙).
function recordTrigger({ symbol, kind, ts } = {}) {
  const entry = {
    ts: Number.isFinite(ts) ? ts : Date.now(),
    symbol: symbol || null,
    kind: kind || null,
  };
  if (_writesBlocked(_logPath, LOG_PATH)) return entry;
  try {
    fs.mkdirSync(path.dirname(_logPath), { recursive: true });
    fs.appendFileSync(_logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    // 조용히 무시 — 기록 실패가 감시 루프를 막으면 안 된다.
  }
  return entry;
}

// 로그 파일에서 sinceMs 이후의 기록만 읽어 통계를 낸다. 파일이 없거나 깨져 있어도
// 빈 통계를 준다(에러를 던지지 않는다).
function readTriggerLog(sinceMs) {
  let text;
  try {
    text = fs.readFileSync(_logPath, 'utf8');
  } catch (e) {
    return [];
  }
  const lines = text.split('\n').filter((l) => l.trim());
  const entries = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (!Number.isFinite(sinceMs) || (Number.isFinite(e.ts) && e.ts >= sinceMs)) {
        entries.push(e);
      }
    } catch (e) {
      // 한 줄이 깨져 있어도(예: 쓰다가 중단됨) 나머지는 계속 읽는다.
    }
  }
  return entries;
}

// 순수 함수 — entries 배열을 받아 요약 통계를 낸다(하루 평균, 심볼별 분포 등).
function summarizeTriggers(entries, windowDays) {
  if (!Array.isArray(entries) || !entries.length) {
    return { count: 0, perDay: 0, bySymbol: {}, byKind: {} };
  }
  const bySymbol = {};
  const byKind = {};
  for (const e of entries) {
    const sym = e.symbol || '(알수없음)';
    const kind = e.kind || '(알수없음)';
    bySymbol[sym] = (bySymbol[sym] || 0) + 1;
    byKind[kind] = (byKind[kind] || 0) + 1;
  }
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 1;
  return {
    count: entries.length,
    perDay: Math.round((entries.length / days) * 100) / 100,
    bySymbol,
    byKind,
  };
}

module.exports = { recordTrigger, readTriggerLog, summarizeTriggers, _setLogPath, _resetLogPath, LOG_PATH };

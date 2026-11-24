'use strict';

// cost-log.js — 분석 1회(12명 전체)가 끝날 때마다 실제로 쓴 토큰·비용을 기록한다.
// API 전환 여부를 감이 아니라 실제 숫자로 판단하기 위한 데이터 수집용이다.
// trigger-log.js와 같은 구조(append-only, 부가 기능이라 실패해도 핵심 흐름을 안 막음).

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'reports', 'cost-log.jsonl');

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


// 분석 1회의 비용을 기록한다. costUsd·inputTokens·outputTokens 중 일부가 null이어도
// (일부 에이전트가 겉포장 파싱에 실패한 경우) 있는 것만 기록한다 — 지어내지 않는다.
function recordCost({ symbol, mode, costUsd, inputTokens, outputTokens, agentCount, ts, candidateId } = {}) {
  const entry = {
    ts: Number.isFinite(ts) ? ts : Date.now(),
    candidateId: candidateId || null, // 후보 기록(candidate-log)과 연결 — 어떤 신호가 토큰을 썼는지
    symbol: symbol || null,
    mode: mode || null,
    costUsd: Number.isFinite(costUsd) ? costUsd : null,
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : null,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : null,
    agentCount: Number.isFinite(agentCount) ? agentCount : null,
  };
  if (_writesBlocked(_logPath, LOG_PATH)) return entry;
  try {
    fs.mkdirSync(path.dirname(_logPath), { recursive: true });
    fs.appendFileSync(_logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    // 조용히 무시 — 기록 실패가 분석 흐름을 막으면 안 된다.
  }
  return entry;
}

function readCostLog(sinceMs) {
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
      // 깨진 줄은 건너뛴다.
    }
  }
  return entries;
}

// 순수 함수 — 비용 항목들을 요약한다. costUsd를 모르는 항목(null)은 합계·평균에서
// 제외하되, 몇 건이 제외됐는지도 같이 알려준다 — 실제보다 적게 나온 것처럼 숨기지
// 않기 위해서다.
function summarizeCosts(entries, windowDays) {
  if (!Array.isArray(entries) || !entries.length) {
    return { count: 0, knownCostCount: 0, totalCostUsd: null, avgCostUsd: null, perDayCostUsd: null, perDayCount: 0 };
  }
  const known = entries.filter((e) => Number.isFinite(e.costUsd));
  const totalCostUsd = known.length ? Math.round(known.reduce((s, e) => s + e.costUsd, 0) * 1e6) / 1e6 : null;
  const avgCostUsd = known.length ? Math.round((totalCostUsd / known.length) * 1e6) / 1e6 : null;
  const days = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 1;
  const perDayCostUsd = totalCostUsd != null ? Math.round((totalCostUsd / days) * 1e6) / 1e6 : null;
  return {
    count: entries.length,
    knownCostCount: known.length,
    totalCostUsd,
    avgCostUsd,
    perDayCostUsd,
    perDayCount: Math.round((entries.length / days) * 100) / 100,
  };
}

module.exports = { recordCost, readCostLog, summarizeCosts, _setLogPath, _resetLogPath, LOG_PATH };

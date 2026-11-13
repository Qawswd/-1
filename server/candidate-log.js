'use strict';

// candidate-log.js — 매매 후보의 "전체 생애"를 기록한다. 개선을 판정하는 기준 데이터다.
// 기록이 없으면 이후 무엇을 바꿔도 좋아졌는지 알 수 없다.
//
// 한 후보(candidateId)에 여러 줄이 쌓인다(append-only, reports/candidate-log.jsonl):
//   type 'candidate' — 신호가 떴고, 어느 관문에서 통과·탈락했는지(stage, reason)와
//                       그 시점의 시장 데이터(features)
//   type 'plan'      — 12명 분석이 돌았다면 최종 판정과 계획(진입·손절·목표)
//   type 'execution' — 거래소 실행 결과(진입·차단·실패·미확인)
// 토큰·비용은 cost-log.jsonl에 같은 candidateId로 남는다.
//
// 여기서는 판정하지 않는다. "손절과 목표 중 무엇이 먼저 닿았나, 허용가에 실제로 진입할 수
// 있었나"는 이후 가격 데이터로 나중에 소급해 판정한다(outcome 라벨링 — 다음 단계).
// 탈락 후보를 "나중에 올랐으니 좋은 자리였다"로 판단하지 않기 위해, 당시 데이터를 그대로
// 남기는 것이 이 모듈의 역할이다.
//
// 기록 실패는 절대 감시·분석·주문 흐름을 막지 않는다(모든 함수가 예외를 삼킨다).
// AI를 호출하지 않으므로 토큰을 쓰지 않는다.

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'reports', 'candidate-log.jsonl');
let _logPath = LOG_PATH;
function _setLogPath(p) {
  _logPath = p || LOG_PATH;
}
function _resetLogPath() {
  _logPath = LOG_PATH;
}
// 테스트 실행 중에는 실제 기록 파일에 쓰지 않는다(임시 경로 지정 시에는 씀).
function _writesBlocked() {
  return !!process.env.NODE_TEST_CONTEXT && _logPath === LOG_PATH;
}

function newCandidateId(now) {
  const t = (Number.isFinite(now) ? now : Date.now()).toString(36);
  return `c-${t}-${Math.random().toString(36).slice(2, 8)}`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 지표 객체에서 판정·검증에 쓸 숫자만 뽑는다(원본 전체를 저장하면 파일이 불필요하게 커진다).
function indicatorSnapshot(ind) {
  if (!ind || typeof ind !== 'object') return null;
  return {
    price: num(ind.price),
    sma20: num(ind.sma20),
    sma50: num(ind.sma50),
    sma200: num(ind.sma200),
    rsi14: num(ind.rsi14),
    macdHist: num(ind.macd && ind.macd.hist),
    high20: num(ind.high20),
    low20: num(ind.low20),
    volatilityPct: num(ind.volatilityPct),
  };
}

function append(row) {
  const entry = { ts: Date.now(), ...row };
  if (_writesBlocked()) return entry;
  try {
    fs.mkdirSync(path.dirname(_logPath), { recursive: true });
    fs.appendFileSync(_logPath, JSON.stringify(entry) + '\n', 'utf8');
  } catch (_) {
    // 조용히 무시 — 기록 실패가 매매 흐름을 막으면 안 된다.
  }
  return entry;
}

// 신호가 어느 관문에서 통과·탈락했는지 기록한다.
// stage: 'kind' | 'market_hours' | 'running' | 'structure' | 'quota' | 'budget' | 'gap' | 'analyzed'
function recordCandidate({ candidateId, source, symbol, kind, value, severity, price, stage, passed, reason, features } = {}) {
  const v = num(value);
  return append({
    type: 'candidate',
    candidateId: candidateId || newCandidateId(),
    source: source || 'watcher',
    symbol: symbol || null,
    kind: kind || null,
    value: v,
    direction: v == null ? null : v >= 0 ? 'up' : 'down',
    severity: severity || null,
    price: num(price),
    stage: stage || null,
    passed: !!passed,
    reason: reason || null,
    features: features || null,
  });
}

// 12명 분석의 최종 계획. 문자열 계획(entry 등)은 원문 그대로, 숫자로 읽힌 값은 따로 둔다
// (나중에 판정할 때 숫자가 필요하고, 원문은 해석 오류를 확인할 때 필요하다).
function recordPlan({ candidateId, symbol, decision, numeric, aceFailed } = {}) {
  const d = decision || {};
  const n = numeric || {};
  return append({
    type: 'plan',
    candidateId: candidateId || null,
    symbol: symbol || null,
    action: d.action || null,
    confidence: num(d.confidence),
    verdict: d.verdict || null,
    entry: d.entry == null ? null : String(d.entry).slice(0, 300),
    stop: d.stop == null ? null : String(d.stop).slice(0, 300),
    target: d.target == null ? null : String(d.target).slice(0, 300),
    entryNum: num(n.entry),
    stopNum: num(n.stop),
    targetNum: num(n.target),
    rr: num(d.rr),
    riskOk: d.riskOk == null ? null : !!d.riskOk,
    aceFailed: !!aceFailed,
  });
}

// 거래소 실행 결과. payload는 engine._notifyExecution에 넘기는 객체 그대로다 — 형태가
// 여러 가지라 핵심 필드만 뽑는다.
function recordExecution({ candidateId, symbol, payload } = {}) {
  const p = payload || {};
  let status = 'other';
  if (p.ok === true) status = 'entered';
  else if (p.unknown) status = 'unknown';
  else if (p.ok === false) status = 'blocked_or_failed';
  const flags = Object.keys(p).filter(
    (k) => !['ok', 'error', 'unknown', 'entryOrder', 'stopOrder'].includes(k) && p[k] && typeof p[k] === 'object'
  );
  return append({
    type: 'execution',
    candidateId: candidateId || null,
    symbol: symbol || null,
    status,
    reason: p.error ? String(p.error).slice(0, 300) : null,
    flags, // 예: dailyLoss, portfolioExposure, consecutiveLossPause 등 어떤 관문이었는지
  });
}

function readLog(sinceMs) {
  let text;
  try {
    text = fs.readFileSync(_logPath, 'utf8');
  } catch (_) {
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (!Number.isFinite(sinceMs) || (Number.isFinite(r.ts) && r.ts >= sinceMs)) rows.push(r);
    } catch (_) {
      // 깨진 줄은 건너뛴다.
    }
  }
  return rows;
}

// 순수 함수 — 관문별 통과·탈락 분포와 분석·진입 전환 수를 낸다.
function summarize(rows) {
  const out = { candidates: 0, byStage: {}, analyzed: 0, plans: { BUY: 0, SELL: 0, HOLD: 0, other: 0 }, executions: {} };
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    if (r.type === 'candidate') {
      out.candidates += 1;
      const key = `${r.stage || '?'}:${r.passed ? 'pass' : 'drop'}`;
      out.byStage[key] = (out.byStage[key] || 0) + 1;
      if (r.stage === 'analyzed') out.analyzed += 1;
    } else if (r.type === 'plan') {
      const a = String(r.action || '').toUpperCase();
      if (a in out.plans) out.plans[a] += 1;
      else out.plans.other += 1;
    } else if (r.type === 'execution') {
      out.executions[r.status] = (out.executions[r.status] || 0) + 1;
    }
  }
  return out;
}

module.exports = {
  LOG_PATH,
  newCandidateId,
  indicatorSnapshot,
  recordCandidate,
  recordPlan,
  recordExecution,
  readLog,
  summarize,
  _setLogPath,
  _resetLogPath,
};

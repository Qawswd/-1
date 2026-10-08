'use strict';

// backtest/evaluate-hypotheses.js — 후보 로그에 남긴 가설(H1·H2·M0) 기계 판정과 AI 판정(plan)을
// "그 뒤 실제 가격"으로 소급 판정해 나란히 비교한다. Phase 2 진입 조건
// "AI 판정이 같은 기간 기계 규칙보다 낫다"(docs/00-CEO-PLAN.md)를 숫자로 확인하는 도구.
//
//   node server/backtest/evaluate-hypotheses.js                # 최근 60일
//   node server/backtest/evaluate-hypotheses.js --days 30
//
// 입력: reports/candidate-log.jsonl (watcher 가 쓴 것)
// 가격: 바이낸스 USDⓈ-M 공개 15분봉 (fapi, 키 불필요, 읽기 전용). 트리거 시각 이후 최대 100봉.
// 판정 규칙은 백테스트(engine.simulateTrade)와 동일: 다음 봉 시가 진입, 손절·목표 동시면 손절, 시간 만료면 종가.
// 아직 보유 한도 봉 수가 안 지난 건은 'pending' 으로 두고 통계에서 뺀다(추측 금지).

const fs = require('fs');
const path = require('path');
const E = require('./engine');

const LOG_PATH = path.join(__dirname, '..', '..', 'reports', 'candidate-log.jsonl');
const OUT_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'results');
const FAPI = 'https://fapi.binance.com/fapi/v1/klines';
const BAR_MS = 15 * 60 * 1000;
const AI_MAX_HOLD_BARS = 96; // AI 계획에는 보유 한도가 없으므로 가설과 같은 24시간으로 통일
const COST = { feePct: 0.05, slipPct: 0.02 };

// --- 순수 함수 --------------------------------------------------------------------

function readRows(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (_) {
      /* 깨진 줄은 건너뛴다 */
    }
  }
  return rows;
}

// candidateId 별로 "가설이 실린 마지막 후보 행"과 "plan 행"을 묶는다.
function groupByCandidate(rows) {
  const map = new Map();
  for (const r of rows) {
    if (!r || !r.candidateId) continue;
    const g = map.get(r.candidateId) || { candidateId: r.candidateId, symbol: r.symbol || null, source: null, candidate: null, plan: null, execution: null };
    if (r.type === 'candidate' && r.source && !g.source) g.source = r.source;
    if (r.type === 'candidate' && r.features && Array.isArray(r.features.hypotheses)) g.candidate = r;
    else if (r.type === 'plan') g.plan = r;
    else if (r.type === 'execution') g.execution = r;
    if (!g.symbol && r.symbol) g.symbol = r.symbol;
    map.set(r.candidateId, g);
  }
  return [...map.values()].filter((g) => g.candidate || g.plan);
}

function toFuturesSymbol(sym) {
  const s = String(sym || '').toUpperCase().replace(/-/g, '');
  return s.endsWith('USDT') ? s : `${s}USDT`;
}

// 바이낸스 kline 배열 → {t,o,h,l,c,v}
function parseKlines(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((k) => ({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[5]) }))
    .filter((b) => [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite));
}

// 명시된 손절·목표로 판정 (AI 계획용). bars[0] 시가 진입. 보유 한도 넘도록 봉이 없으면 pending.
function simulateLevels(bars, side, stop, target, maxHoldBars, cost = COST) {
  if (!Array.isArray(bars) || bars.length < 1) return { status: 'pending', reason: '봉 없음' };
  const dir = side === 'LONG' ? 1 : side === 'SHORT' ? -1 : 0;
  if (!dir) return { status: 'invalid', reason: `방향 없음(${side})` };
  const s = Number(stop);
  const tg = Number(target);
  const entry = bars[0].o;
  if (!(entry > 0) || !(s > 0) || !(tg > 0)) return { status: 'invalid', reason: '레벨 없음' };
  if (dir === 1 ? !(s < entry && tg > entry) : !(s > entry && tg < entry)) return { status: 'invalid', reason: '레벨이 방향과 모순' };
  const last = Math.min(bars.length - 1, maxHoldBars);
  for (let j = 0; j <= last; j++) {
    const b = bars[j];
    const hitStop = dir === 1 ? b.l <= s : b.h >= s;
    const hitTarget = dir === 1 ? b.h >= tg : b.l <= tg;
    if (hitStop || hitTarget) {
      const exit = hitStop ? s : tg;
      const gross = ((exit - entry) / entry) * 100 * dir;
      const pct = gross - 2 * (cost.feePct + cost.slipPct);
      const stopPct = (Math.abs(entry - s) / entry) * 100;
      return { status: 'resolved', reason: hitStop ? 'stop' : 'target', entry, exit, pct: Number(pct.toFixed(4)), r: Number((pct / stopPct).toFixed(3)), bars: j + 1 };
    }
  }
  if (bars.length - 1 < maxHoldBars) return { status: 'pending', reason: `보유 한도 전(${bars.length}/${maxHoldBars + 1}봉)` };
  const exit = bars[last].c;
  const gross = ((exit - entry) / entry) * 100 * dir;
  const pct = gross - 2 * (cost.feePct + cost.slipPct);
  const stopPct = (Math.abs(entry - s) / entry) * 100;
  return { status: 'resolved', reason: 'time', entry, exit, pct: Number(pct.toFixed(4)), r: Number((pct / stopPct).toFixed(3)), bars: last + 1 };
}

// 가설 판정: 손절·목표는 기록된 ATR·배수로 다음 봉 시가 기준 재계산(백테스트와 동일 정의).
function simulateHypothesis(bars, h) {
  if (!h || !h.applies) return { status: 'skipped', reason: h && h.reason ? h.reason : '미적용' };
  const atr = Number(h.atr);
  if (!(atr > 0) || !bars.length) return { status: 'pending', reason: 'ATR/봉 없음' };
  const entry = bars[0].o;
  const dir = h.side === 'LONG' ? 1 : -1;
  // 기록된 stop/target 은 트리거 가격 기준이라, 진입가 기준으로 같은 거리만큼 다시 잡는다.
  const dist = Math.abs(Number(h.entry) - Number(h.stop));
  const rrMult = dist > 0 ? Math.abs(Number(h.target) - Number(h.entry)) / dist : null;
  if (!(dist > 0) || !(rrMult > 0)) return { status: 'invalid', reason: '기록된 레벨 이상' };
  return simulateLevels(bars, h.side, entry - dir * dist, entry + dir * dist * rrMult, h.maxHoldBars || 96);
}

// 시장 국면 — 판정 시각 직전 일봉 기준. 종가가 50일 평균 위이고 20일 수익률 > +3% 면 상승,
// 아래이고 < −3% 면 하락, 나머지는 횡보. 데이터가 모자라면 null(지어내지 않는다).
const REGIME = { smaLen: 50, chgLen: 20, chgPct: 3 };
function classifyRegime(daily, ts) {
  const d = (Array.isArray(daily) ? daily : []).filter((b) => b && Number.isFinite(b.t) && b.t + 86400000 <= ts);
  if (d.length < REGIME.smaLen + 1) return null;
  const closes = d.map((b) => Number(b.c));
  const last = closes[closes.length - 1];
  const sma = closes.slice(-REGIME.smaLen).reduce((a, b) => a + b, 0) / REGIME.smaLen;
  const ref = closes[closes.length - 1 - REGIME.chgLen];
  const chg = ((last - ref) / ref) * 100;
  if (last > sma && chg > REGIME.chgPct) return 'up';
  if (last < sma && chg < -REGIME.chgPct) return 'down';
  return 'sideways';
}
const REGIME_KO = { up: '상승장', sideways: '횡보장', down: '하락장' };

// "무조건 롱" 기준선 — AI 계획의 손절·익절 거리(%)는 그대로 두고 방향만 롱으로 고정한다.
// AI 가 이걸 못 이기면 방향 판단력이 아니라 상승장 덕을 본 것이다.
function simulateLongBaseline(bars, plan, maxHoldBars, cost = COST) {
  if (!Array.isArray(bars) || bars.length < 1) return { status: 'pending', reason: '봉 없음' };
  const o = bars[0].o;
  const e = Number(plan.entryNum) > 0 ? Number(plan.entryNum) : o;
  const sd = Math.abs(e - Number(plan.stopNum)) / e;
  const td = Math.abs(Number(plan.targetNum) - e) / e;
  if (!(sd > 0) || !(td > 0)) return { status: 'invalid', reason: '레벨 없음' };
  return simulateLevels(bars, 'LONG', o * (1 - sd), o * (1 + td), maxHoldBars, cost);
}

function maxDrawdownR(rows) {
  const done = (rows || []).filter((d) => d && d.status === 'resolved' && Number.isFinite(Number(d.r)));
  if (!done.length) return null;
  done.sort((a, b) => Number(a.ts) - Number(b.ts));
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const d of done) {
    cum += Number(d.r);
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }
  return Math.round(dd * 100) / 100;
}

function stats(results) {
  const done = results.filter((r) => r.status === 'resolved');
  const wins = done.filter((r) => r.pct > 0);
  const losses = done.filter((r) => r.pct < 0);
  const gw = wins.reduce((s, r) => s + r.pct, 0);
  const gl = losses.reduce((s, r) => s + Math.abs(r.pct), 0);
  const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
  return {
    total: results.length,
    resolved: done.length,
    pending: results.filter((r) => r.status === 'pending').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    invalid: results.filter((r) => r.status === 'invalid').length,
    wins: wins.length,
    losses: losses.length,
    winRate: done.length ? r2((wins.length / done.length) * 100) : null,
    profitFactor: gl > 0 ? r2(gw / gl) : null,
    expectancyPct: done.length ? r2(done.reduce((s, r) => s + r.pct, 0) / done.length) : null,
    avgR: done.length ? r2(done.reduce((s, r) => s + r.r, 0) / done.length) : null,
    totalPct: r2(done.reduce((s, r) => s + r.pct, 0)),
  };
}

// 전체 평가. fetchKlines(symbol, startMs, limit) → bars 를 주입받는다(테스트·오프라인용).
async function evaluate({ rows, fetchKlines, fetchDaily, now = Date.now(), sinceMs = 0 }) {
  const groups = groupByCandidate(rows).filter((g) => (g.candidate ? g.candidate.ts : g.plan.ts) >= sinceMs);
  const cache = new Map();
  const getBars = async (symbol, afterMs) => {
    const start = Math.floor(afterMs / BAR_MS) * BAR_MS + BAR_MS; // 트리거가 속한 봉의 다음 봉부터
    const key = `${symbol}|${start}`;
    if (!cache.has(key)) cache.set(key, await fetchKlines(toFuturesSymbol(symbol), start, 100));
    return cache.get(key);
  };

  const perHypothesis = {};
  const ai = [];
  const aiBySource = { trigger: [], schedule: [], manual: [] };
  const srcKey = (g) => (g.source === 'schedule' ? 'schedule' : g.source === 'manual' ? 'manual' : 'trigger');
  const plannedRR = [];
  const longBase = [];
  const aiByRegime = { up: [], sideways: [], down: [], unknown: [] };
  const dailyCache = new Map();
  const getDaily = async (symbol) => {
    if (typeof fetchDaily !== 'function') return [];
    const k = toFuturesSymbol(symbol);
    if (!dailyCache.has(k)) {
      try {
        dailyCache.set(k, await fetchDaily(k, now, 200));
      } catch (_) {
        dailyCache.set(k, []);
      }
    }
    return dailyCache.get(k);
  };
  const details = [];
  for (const g of groups) {
    const symbol = g.symbol;
    if (g.candidate) {
      let bars = [];
      try {
        bars = await getBars(symbol, g.candidate.ts);
      } catch (e) {
        bars = [];
      }
      for (const h of g.candidate.features.hypotheses) {
        const res = simulateHypothesis(bars, h);
        (perHypothesis[h.id] = perHypothesis[h.id] || []).push(res);
        details.push({ candidateId: g.candidateId, symbol, ts: g.candidate.ts, who: h.id, side: h.side, ...res });
      }
    }
    if (g.plan && ['BUY', 'SELL'].includes(String(g.plan.action).toUpperCase())) {
      let bars = [];
      try {
        bars = await getBars(symbol, g.plan.ts);
      } catch (e) {
        bars = [];
      }
      const side = String(g.plan.action).toUpperCase() === 'BUY' ? 'LONG' : 'SHORT';
      const res = simulateLevels(bars, side, g.plan.stopNum, g.plan.targetNum, AI_MAX_HOLD_BARS);
      ai.push(res);
      aiBySource[srcKey(g)].push(res);
      if (Number.isFinite(Number(g.plan.rr)) && Number(g.plan.rr) > 0) plannedRR.push(Number(g.plan.rr));
      const regime = classifyRegime(await getDaily(symbol), g.plan.ts);
      aiByRegime[regime || 'unknown'].push(res);
      const lb = simulateLongBaseline(bars, g.plan, AI_MAX_HOLD_BARS);
      longBase.push(lb);
      details.push({ candidateId: g.candidateId, symbol, ts: g.plan.ts, who: 'AI', source: srcKey(g), side, regime, confidence: g.plan.confidence, ...res });
      details.push({ candidateId: g.candidateId, symbol, ts: g.plan.ts, who: 'LONG', regime, ...lb });
    } else if (g.plan) {
      const skip = { status: 'skipped', reason: `관망(${g.plan.action})` };
      ai.push(skip);
      aiBySource[srcKey(g)].push(skip);
    }
  }
  const summary = { candidates: groups.length, generatedAt: new Date(now).toISOString() };
  for (const id of Object.keys(perHypothesis)) summary[id] = stats(perHypothesis[id]);
  summary.AI = stats(ai);
  if (aiBySource.trigger.length) summary['AI-trig'] = stats(aiBySource.trigger);
  if (aiBySource.schedule.length) summary['AI-sched'] = stats(aiBySource.schedule);
  if (aiBySource.manual.length) summary['AI-manual'] = stats(aiBySource.manual);
  if (longBase.length) summary.LONG = stats(longBase);
  for (const k of ['up', 'sideways', 'down', 'unknown']) {
    if (aiByRegime[k].length) summary[`AI-${k}`] = stats(aiByRegime[k]);
  }
  const avgPlannedRR = plannedRR.length ? Math.round((plannedRR.reduce((a, b) => a + b, 0) / plannedRR.length) * 100) / 100 : null;
  // 최대 낙폭(R) — AI 판정을 시간순으로 이어 붙였을 때 누적 R 의 고점 대비 최대 하락.
  // 매매당 위험 1% 기준이면 1R ≈ 계좌 1% 이므로 관문 '계좌 최대 낙폭 ≤ 15%' 를 실제 시세로 잰다
  // (데모 계좌 손익은 데모 시세·펀딩이 실제와 달라 쓰지 않는다 — 2026-10-08 확인).
  summary.AI.maxDrawdownR = maxDrawdownR(details.filter((d) => d.who === 'AI'));
  return { summary, details, avgPlannedRR, verdict: phase2Verdict(summary.AI, summary), calibration: calibrate(details) };
}

// 확신도 캘리브레이션 — AI 가 말한 확률(확신도)과 실제 익절 비율을 구간별로 대조한다.
// 확신도 = "익절이 손절보다 먼저 닿을 확률"(2026-09-30 정의)이므로 두 숫자가 가까워야 정상이다.
const CAL_BUCKETS = [[0, 40, '40% 미만'], [40, 50, '40~49%'], [50, 60, '50~59%'], [60, 101, '60% 이상']];
function calibrate(details) {
  const rows = (details || []).filter((d) => d && d.who === 'AI' && d.status === 'resolved' && Number.isFinite(Number(d.confidence)));
  return CAL_BUCKETS.map(([lo, hi, label]) => {
    const b = rows.filter((d) => Number(d.confidence) >= lo && Number(d.confidence) < hi);
    const wins = b.filter((d) => d.pct > 0).length;
    const avg = b.length ? Math.round(b.reduce((a, d) => a + Number(d.confidence), 0) / b.length) : null;
    return { label, n: b.length, statedPct: avg, actualPct: b.length ? Math.round((wins / b.length) * 100) : null };
  });
}

function renderCalibration(cal) {
  const out = ['확신도 구간   건수   AI가 말한 확률   실제 익절 비율'];
  for (const c of cal || []) {
    out.push(`${c.label.padEnd(10)} ${String(c.n).padStart(5)}   ${c.statedPct == null ? '-' : c.statedPct + '%'}`.padEnd(34) + `${c.actualPct == null ? '-' : c.actualPct + '%'}`);
  }
  return out.join('\n');
}

// Phase 2 관문(docs/00-CEO-PLAN.md) 중 이 표로 판정할 수 있는 부분. 나머지(계좌 낙폭,
// 기계 규칙 대비 우위)는 표를 보고 사람이 확인한다.
const PHASE2 = { minResolved: 30, minPF: 1.3, targetWinRate: 45, minNonUp: 8, maxDrawdownR: 15 };
function phase2Verdict(s, all = {}) {
  if (!s || !s.resolved) return { pass: false, lines: ['판정된 AI 매매 0건 — 아직 결론 없음'] };
  const lines = [];
  const okN = s.resolved >= PHASE2.minResolved;
  const okE = s.expectancyPct != null && s.expectancyPct > 0;
  const okPF = s.profitFactor != null && s.profitFactor >= PHASE2.minPF;
  const okW = s.winRate != null && s.winRate >= PHASE2.targetWinRate;
  lines.push(`${okN ? '✅' : '⏳'} 표본 ${s.resolved}/${PHASE2.minResolved}건`);
  lines.push(`${okE ? '✅' : '❌'} 기대값 ${s.expectancyPct ?? '-'}% (> 0 이어야 함)`);
  lines.push(`${okPF ? '✅' : '❌'} PF ${s.profitFactor ?? '-'} (≥ ${PHASE2.minPF})`);
  lines.push(`${okW ? '✅' : '❌'} 승률 ${s.winRate ?? '-'}% (손익비 1.8 기준 목표 ≥ ${PHASE2.targetWinRate}%)`);
  // 국면 조건(2026-10-04): 상승장 밖(횡보·하락) 판정이 충분히 모이고 거기서 손실이 아니어야 한다.
  const side = all['AI-sideways'] || { resolved: 0, expectancyPct: null };
  const down = all['AI-down'] || { resolved: 0, expectancyPct: null };
  const nonUpN = (side.resolved || 0) + (down.resolved || 0);
  const nonUpSum = (side.resolved ? side.expectancyPct * side.resolved : 0) + (down.resolved ? down.expectancyPct * down.resolved : 0);
  const nonUpExp = nonUpN ? Math.round((nonUpSum / nonUpN) * 100) / 100 : null;
  const okNonUpN = nonUpN >= PHASE2.minNonUp;
  const okNonUpE = nonUpExp != null && nonUpExp >= 0;
  lines.push(`${okNonUpN ? '✅' : '⏳'} 상승장 밖(횡보·하락) 표본 ${nonUpN}/${PHASE2.minNonUp}건`);
  lines.push(`${okNonUpE ? '✅' : nonUpN ? '❌' : '⏳'} 상승장 밖 기대값 ${nonUpExp ?? '-'}% (≥ 0 이어야 함)`);
  // 무조건 롱 기준선보다 나아야 한다 — 못 이기면 상승장 덕.
  const lb = all.LONG;
  const okLong = !!(lb && lb.resolved && s.expectancyPct != null && lb.expectancyPct != null && s.expectancyPct > lb.expectancyPct);
  lines.push(`${okLong ? '✅' : lb && lb.resolved ? '❌' : '⏳'} AI 기대값 ${s.expectancyPct ?? '-'}% > 무조건 롱 ${lb && lb.resolved ? lb.expectancyPct : '-'}%`);
  // 최대 낙폭 — 실제 시세로 채점한 판정의 누적 R 기준(매매당 1% 위험이면 R ≈ 계좌 %).
  const dd = s.maxDrawdownR;
  const okDD = dd != null && dd <= PHASE2.maxDrawdownR;
  lines.push(`${okDD ? '✅' : dd == null ? '⏳' : '❌'} 최대 낙폭 ${dd ?? '-'}R (매매당 1% 위험 기준 계좌 약 ${dd ?? '-'}%, ≤ ${PHASE2.maxDrawdownR})`);
  return { pass: okN && okE && okPF && okNonUpN && okNonUpE && okLong && okDD, lines };
}

function renderSummary(summary) {
  const ids = Object.keys(summary).filter((k) => !['candidates', 'generatedAt'].includes(k));
  const head = ['판정자', '전체', '판정됨', '대기', '미적용', '승', '패', '승률%', 'PF', '기대값%', '평균R', '누적%'];
  const w = [8, 5, 6, 5, 6, 4, 4, 6, 6, 8, 6, 8];
  const line = (cols) => cols.map((c, i) => String(c == null ? '-' : c).padStart(w[i])).join(' ');
  const out = [line(head), line(w.map((x) => '-'.repeat(x)))];
  for (const id of ids) {
    const s = summary[id];
    out.push(line([id, s.total, s.resolved, s.pending, s.skipped + s.invalid, s.wins, s.losses, s.winRate, s.profitFactor, s.expectancyPct, s.avgR, s.totalPct]));
  }
  return out.join('\n');
}

// --- 네트워크·파일 (실행 시에만) -----------------------------------------------------------

async function fetchKlinesBinance(symbol, startMs, limit) {
  const url = `${FAPI}?symbol=${encodeURIComponent(symbol)}&interval=15m&startTime=${startMs}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`klines HTTP ${res.status}`);
  return parseKlines(await res.json());
}

async function fetchDailyBinance(symbol, endMs, limit) {
  const url = `${FAPI}?symbol=${encodeURIComponent(symbol)}&interval=1d&endTime=${endMs}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`daily klines HTTP ${res.status}`);
  return parseKlines(await res.json());
}

async function main() {
  const args = process.argv.slice(2);
  let days = 60;
  const i = args.indexOf('--days');
  if (i >= 0) days = Number(args[i + 1]) || 60;
  const rows = readRows(fs.existsSync(LOG_PATH) ? fs.readFileSync(LOG_PATH, 'utf8') : '');
  const sinceMs = Date.now() - days * 86400000;
  const { summary, details, avgPlannedRR, verdict, calibration } = await evaluate({ rows, fetchKlines: fetchKlinesBinance, fetchDaily: fetchDailyBinance, sinceMs });
  console.log(`후보 ${summary.candidates}건 (최근 ${days}일) — 판정 규칙: 다음 봉 시가 진입 · 손절/목표 동시면 손절 · 보유 한도 후 종가 · 비용 왕복 0.14%`);
  console.log(renderSummary(summary));
  console.log(`\nAI 계획 손익비 평균: ${avgPlannedRR == null ? '데이터 없음' : '1 : ' + avgPlannedRR}`);
  console.log(`\n[Phase 2 관문 — AI 전체] ${verdict.pass ? '통과' : '미통과'}`);
  for (const l of verdict.lines) console.log('  ' + l);
  console.log('  (나머지 조건: AI 가 H1·M0 보다 기대값·PF 우위 — 위 표로 확인. 데모 계좌 손익은 데모 시세·펀딩이 실제와 달라 관문에 쓰지 않는다)');
  console.log('\n읽는 법(국면): AI-up/sideways/down = 판정 시점 시장 국면별 AI 성적. LONG = 같은 손절·익절 거리로 무조건 롱. ' +
    '국면 기준: 일봉 종가가 50일 평균 위·20일 수익률 > +3% 면 상승장, 아래·< −3% 면 하락장, 나머지 횡보장.');
  console.log('\n[확신도 캘리브레이션] 두 숫자가 가까우면 AI 의 확률 감각을 믿을 수 있다. 실제가 한참 낮으면 기대값 기준을 올린다.');
  console.log(renderCalibration(calibration));
  console.log('\n읽는 법: AI 행이 H1·M0 행보다 기대값·PF 가 높아야 "AI 가 기계 규칙 위에서 우위를 만든다". 판정됨 30건 미만이면 아직 결론 없음.');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(OUT_DIR, `hypotheses-${stamp}.json`), JSON.stringify({ summary, details }, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, `hypotheses-${stamp}.md`), `# AI vs 기계 규칙 (${stamp}, 최근 ${days}일)\n\n\`\`\`\n${renderSummary(summary)}\n\`\`\`\n`);
  console.log(`\n저장: reports/backtest/results/hypotheses-${stamp}.md`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[evaluate-hypotheses] 실패:', e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = { readRows, groupByCandidate, toFuturesSymbol, parseKlines, simulateLevels, simulateHypothesis, stats, evaluate, renderSummary, phase2Verdict, PHASE2, calibrate, renderCalibration, classifyRegime, simulateLongBaseline, REGIME, maxDrawdownR };

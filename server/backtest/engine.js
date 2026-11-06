'use strict';

// backtest/engine.js — 감시기(watcher) 트리거 규칙을 과거 15분봉에 그대로 적용해 보는 백테스터의
// 순수 계산부. 네트워크·파일 접근 없음 → 전부 유닛테스트 가능. 실행 진입점은 run.js.
//
// 무엇을 재현하나 (watcher.js · indicators.js 의 실제 규칙)
//   1) 트리거: 15분 전 대비 |변동| ≥ movePct  (watcher._evaluate 의 kind:'move')
//   2) 필터  : 일봉 지표로 추세(SMA20·MACD 방향 일치) / 역추세(20일 구간 극단) 판정
//              (indicators.structureAgreesWithDirection / reversalAgreesWithDirection)
//   3) 쿨다운: 같은 심볼은 cooldownMin 동안 재트리거 없음 (watcher._raise)
//   4) 포지션: 한 번에 하나만 (exchange 가 기존 포지션이 있으면 새 진입을 막는 것과 동일)
//
// 무엇을 대체하나
//   실전에서는 트리거 통과 후 AI 12명이 방향·레벨을 정한다. 여기서는 그 자리에 기계적
//   규칙을 넣는다 — "AI 가 어떤 방향을 고르든, 이 트리거 자리 자체에 우위가 있는가"를
//   먼저 보기 위해서다. 우위가 없는 자리에서 AI 가 우위를 만들 가능성은 낮다.
//     trend    : 움직인 방향으로 진입 (추세 필터가 동의할 때만)
//     reversal : 움직인 반대 방향으로 진입 (역추세 필터가 동의할 때만)
//     any-trend: 추세 또는 역추세 중 하나라도 통과하면(실전 후보 집합) 움직인 방향으로
//     raw      : 필터 없이 모든 트리거에서 움직인 방향으로 (기준선)
//     raw-rev  : 필터 없이 모든 트리거에서 반대 방향으로 (기준선)
//
// 출구는 단순 고정: 손절 = ATR(14, 15분봉) × stopAtrMult, 목표 = 손절거리 × rr, 시간 만료 = maxHoldBars.
// 같은 봉에서 손절·목표가 둘 다 닿으면 손절로 본다(보수적). 진입은 트리거 봉 다음 봉의 시가.
// 비용: 테이커 수수료 양쪽 + 슬리피지 양쪽. 펀딩비는 v1 에서 무시한다(보유 ≤ 12시간 가정 — 결과에 명시).
//
// 한계(정직하게)
//   - 실전 감시기는 1분마다 "15분 전 대비"를 보지만 여기서는 15분봉 종가 대비 종가만 본다 → 트리거가 더 적게 잡힌다.
//   - 일봉 지표는 진행 중인 당일 봉을 포함해 계산한다(실전 fetchMarket 이 그렇게 받는다).
//   - 과거 데이터는 미래를 보장하지 않는다. 이 도구는 "나쁜 규칙을 걸러내는" 용도다.

const { computeIndicators, structureAgreesWithDirection, reversalAgreesWithDirection } = require('../indicators');

const DEFAULTS = Object.freeze({
  movePct: 1.5, // 트리거 임계(%) — config.watcher.triggers.movePct
  cooldownBars: 4, // 60분 / 15분봉 — config.watcher.cooldownMin
  reversalBandPct: 20, // config.watcher.reversalBandPct
  stopAtrMult: 1.5, // 손절 = ATR × 이 값
  rr: 1.8, // 목표 = 손절거리 × rr — config.risk.minRR 과 맞춤
  maxHoldBars: 48, // 12시간
  feePct: 0.05, // 테이커, 한쪽 (%)
  slipPct: 0.02, // 슬리피지, 한쪽 (%)
  dailyLookback: 120, // 지표 계산에 쓰는 일봉 개수 (market.js 가 받는 것과 동일)
  minDailyBars: 30, // 이보다 일봉이 적으면 지표를 신뢰하지 않아 트리거를 무시
  atrPeriod: 14,
});

const STRATEGIES = Object.freeze(['trend', 'reversal', 'any-trend', 'raw', 'raw-rev']);

// --- 데이터 --------------------------------------------------------------------------

// "t,o,h,l,c,v" CSV → [{t,o,h,l,c,v}] (헤더 자동 감지, 깨진 줄은 건너뜀, 시간순 정렬·중복 제거)
function parseCandleCsv(text) {
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    if (!line || /^t\s*,/.test(line)) continue;
    const p = line.split(',');
    if (p.length < 6) continue;
    const c = { t: Number(p[0]), o: Number(p[1]), h: Number(p[2]), l: Number(p[3]), c: Number(p[4]), v: Number(p[5]) };
    if (![c.t, c.o, c.h, c.l, c.c, c.v].every(Number.isFinite)) continue;
    out.push(c);
  }
  out.sort((a, b) => a.t - b.t);
  const dedup = [];
  for (const c of out) {
    if (dedup.length && dedup[dedup.length - 1].t === c.t) dedup[dedup.length - 1] = c;
    else dedup.push(c);
  }
  return dedup;
}

function utcDayKey(t) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// 단순 ATR: 최근 period 개 True Range 의 평균 (market.js intradaySummaryLines 와 같은 정의).
// 반환: bars 와 같은 길이의 배열, 계산 불가 구간은 null.
function atrSeries(bars, period = 14) {
  const n = bars.length;
  const out = new Array(n).fill(null);
  if (n < 2) return out;
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const h = bars[i].h;
    const l = bars[i].l;
    const pc = bars[i - 1].c;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let sum = 0;
  for (let i = 1; i < n; i++) {
    sum += tr[i];
    if (i > period) sum -= tr[i - period];
    if (i >= period) out[i] = sum / period;
  }
  return out;
}

// --- 트리거 --------------------------------------------------------------------------

// 15분봉 i 에서의 트리거 판정. 직전 봉 종가 대비 |변동| ≥ movePct 면 {direction, movePct}.
function moveTrigger(bars, i, movePct) {
  if (i < 1) return null;
  const ref = bars[i - 1].c;
  const cur = bars[i].c;
  if (!(ref > 0) || !Number.isFinite(cur)) return null;
  const pct = ((cur - ref) / ref) * 100;
  if (Math.abs(pct) < movePct) return null;
  return { direction: pct >= 0 ? 'up' : 'down', movePct: Number(pct.toFixed(4)) };
}

// 일봉 누적기 — 15분봉을 순서대로 넣으면 UTC 일봉 배열을 유지한다(마지막 원소는 진행 중인 당일).
class DailyAggregator {
  constructor() {
    this.daily = [];
    this._key = null;
  }
  push(bar) {
    const key = utcDayKey(bar.t);
    if (key !== this._key) {
      this._key = key;
      this.daily.push({ t: key, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v });
    } else {
      const d = this.daily[this.daily.length - 1];
      if (bar.h > d.h) d.h = bar.h;
      if (bar.l < d.l) d.l = bar.l;
      d.c = bar.c;
      d.v += bar.v;
    }
  }
  // 지표용 사본(최근 lookback 개). 마지막 원소가 진행 중 봉이라 값을 복사해 넘긴다.
  recent(lookback) {
    return this.daily.slice(-lookback).map((d) => ({ ...d }));
  }
}

// 필터 판정: 일봉 지표로 추세/역추세 동의 여부.
function evaluateFilters(direction, dailyCandles, opts) {
  if (!dailyCandles || dailyCandles.length < (opts.minDailyBars || DEFAULTS.minDailyBars)) {
    return { trend: false, reversal: false, ind: null };
  }
  const ind = computeIndicators(dailyCandles);
  const trend = structureAgreesWithDirection(direction, ind);
  const reversal = reversalAgreesWithDirection(direction, ind, { bandPct: opts.reversalBandPct });
  return { trend, reversal, ind };
}

// 전략별 진입 방향 결정. null 이면 진입하지 않는다.
function decideSide(strategy, direction, filters) {
  const withMove = direction === 'up' ? 'LONG' : 'SHORT';
  const against = direction === 'up' ? 'SHORT' : 'LONG';
  switch (strategy) {
    case 'trend':
      return filters.trend ? withMove : null;
    case 'reversal':
      return filters.reversal ? against : null;
    case 'any-trend':
      return filters.trend || filters.reversal ? withMove : null;
    case 'raw':
      return withMove;
    case 'raw-rev':
      return against;
    default:
      throw new Error(`알 수 없는 전략: ${strategy}`);
  }
}

// --- 체결 시뮬레이션 --------------------------------------------------------------------

// 트리거 봉 i 의 다음 봉 시가에 진입 → 손절/목표/시간만료 중 먼저 오는 것으로 청산.
// 반환 trade: { entryIdx, exitIdx, side, entry, exit, stop, target, reason, pct, r, bars }
function simulateTrade(bars, i, side, atr, p) {
  const e = i + 1;
  if (e >= bars.length) return null;
  if (!(atr > 0)) return null;
  const entry = bars[e].o;
  const dist = atr * p.stopAtrMult;
  const dir = side === 'LONG' ? 1 : -1;
  const stop = entry - dir * dist;
  const target = entry + dir * dist * p.rr;
  const last = Math.min(bars.length - 1, e + p.maxHoldBars);

  let exit = null;
  let reason = null;
  let exitIdx = null;
  for (let j = e; j <= last; j++) {
    const b = bars[j];
    const hitStop = side === 'LONG' ? b.l <= stop : b.h >= stop;
    const hitTarget = side === 'LONG' ? b.h >= target : b.l <= target;
    if (hitStop) {
      // 같은 봉에서 둘 다 닿으면 손절로 본다 — 실전에서 어느 쪽이 먼저였는지 알 수 없으므로 불리하게.
      exit = stop;
      reason = 'stop';
      exitIdx = j;
      break;
    }
    if (hitTarget) {
      exit = target;
      reason = 'target';
      exitIdx = j;
      break;
    }
  }
  if (exit == null) {
    exit = bars[last].c;
    reason = 'time';
    exitIdx = last;
  }

  const gross = ((exit - entry) / entry) * 100 * dir;
  const cost = 2 * (p.feePct + p.slipPct); // 진입+청산
  const pct = gross - cost;
  const stopPct = (dist / entry) * 100;
  return {
    entryIdx: e,
    exitIdx,
    entryTime: bars[e].t,
    exitTime: bars[exitIdx].t,
    side,
    entry,
    exit,
    stop,
    target,
    reason,
    grossPct: Number(gross.toFixed(4)),
    pct: Number(pct.toFixed(4)),
    r: Number((pct / stopPct).toFixed(3)),
    stopPct: Number(stopPct.toFixed(4)),
    bars: exitIdx - e + 1,
  };
}

// 전 구간 실행. 반환 { trades, triggers, filtered, params }
function runStrategy(bars, strategy, params = {}) {
  if (!STRATEGIES.includes(strategy)) throw new Error(`알 수 없는 전략: ${strategy}`);
  const p = { ...DEFAULTS, ...params };
  const atr = atrSeries(bars, p.atrPeriod);
  const agg = new DailyAggregator();
  const trades = [];
  let triggers = 0;
  let filtered = 0;
  let cooldownUntil = -1;
  let busyUntil = -1; // 포지션 보유 중인 마지막 봉 인덱스

  for (let i = 0; i < bars.length; i++) {
    agg.push(bars[i]);
    if (i <= busyUntil) continue; // 포지션 보유 중 — 새 트리거 무시 (exchange 의 "기존 포지션" 차단과 동일)
    if (i <= cooldownUntil) continue;
    const trig = moveTrigger(bars, i, p.movePct);
    if (!trig) continue;
    triggers += 1;
    cooldownUntil = i + p.cooldownBars;

    let filters = { trend: false, reversal: false };
    if (strategy !== 'raw' && strategy !== 'raw-rev') {
      filters = evaluateFilters(trig.direction, agg.recent(p.dailyLookback), p);
    }
    const side = decideSide(strategy, trig.direction, filters);
    if (!side) {
      filtered += 1;
      continue;
    }
    const tr = simulateTrade(bars, i, side, atr[i], p);
    if (!tr) continue;
    tr.triggerIdx = i;
    tr.triggerMovePct = trig.movePct;
    tr.filters = { trend: !!filters.trend, reversal: !!filters.reversal };
    trades.push(tr);
    busyUntil = tr.exitIdx;
  }
  return { strategy, params: p, trades, triggers, filtered };
}

// --- 집계 --------------------------------------------------------------------------

function round2(x) {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
}

// positionPct: 거래당 계좌 대비 명목 비중(%). 실전 execution.maxPositionPct(20) 와 맞춘다 —
// 표의 pct 는 "명목 대비" 수익률이라, 계좌 기준 누적·낙폭은 이 비율을 곱해야 실제 체감과 맞는다.
function summarize(trades, positionPct = 20) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pct > 0);
  const losses = trades.filter((t) => t.pct < 0);
  const grossWin = wins.reduce((s, t) => s + t.pct, 0);
  const grossLoss = losses.reduce((s, t) => s + Math.abs(t.pct), 0);
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    cum += t.pct;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  const reasons = {};
  for (const t of trades) reasons[t.reason] = (reasons[t.reason] || 0) + 1;
  return {
    n,
    wins: wins.length,
    losses: losses.length,
    winRate: n ? round2((wins.length / n) * 100) : null,
    avgWinPct: wins.length ? round2(grossWin / wins.length) : null,
    avgLossPct: losses.length ? round2(-grossLoss / losses.length) : null,
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : wins.length ? null : null,
    expectancyPct: n ? round2(trades.reduce((s, t) => s + t.pct, 0) / n) : null,
    avgR: n ? round2(trades.reduce((s, t) => s + t.r, 0) / n) : null,
    totalPct: round2(trades.reduce((s, t) => s + t.pct, 0)), // 1배·전액 명목 기준 단순 합
    maxDrawdownPct: round2(maxDd), // 명목 100% 기준
    positionPct,
    equityTotalPct: round2((trades.reduce((s, t) => s + t.pct, 0) * positionPct) / 100), // 계좌 기준(비중 반영)
    equityMaxDrawdownPct: round2((maxDd * positionPct) / 100),
    avgBars: n ? round2(trades.reduce((s, t) => s + t.bars, 0) / n) : null,
    reasons,
  };
}

function byYear(trades) {
  const groups = {};
  for (const t of trades) {
    const y = new Date(t.entryTime).getUTCFullYear();
    (groups[y] = groups[y] || []).push(t);
  }
  const out = {};
  for (const y of Object.keys(groups).sort()) out[y] = summarize(groups[y]);
  return out;
}

function bySide(trades) {
  return {
    LONG: summarize(trades.filter((t) => t.side === 'LONG')),
    SHORT: summarize(trades.filter((t) => t.side === 'SHORT')),
  };
}

module.exports = {
  DEFAULTS,
  STRATEGIES,
  parseCandleCsv,
  utcDayKey,
  atrSeries,
  moveTrigger,
  DailyAggregator,
  evaluateFilters,
  decideSide,
  simulateTrade,
  runStrategy,
  summarize,
  byYear,
  bySide,
};

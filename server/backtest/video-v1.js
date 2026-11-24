'use strict';

// backtest/video-v1.js — 영상 1 (@TRADING_B.O.O.K "1억 챌린지") 의 매매 방식을 기계 규칙으로 옮긴 것.
//
// 영상에서 읽어낸 것 (docs/videos/01-trading-book.md)
//   차트  : 15분봉 · 추세 리본(빠른/느린 이평, 청록=상승·빨강=하락) · 오실레이터(과매도/과매수 구간)
//   진입  : "단기적인 눌림이 해소될 것 같은데" → 상승 리본에서 오실레이터가 바닥에서 올라올 때 롱
//           "힘이 빠지고 있는 중인데"        → 하락 리본에서 오실레이터가 천장에서 내려올 때 숏
//   출구  : 손절 0.44~0.53% · 목표 1.1~1.2% (RR 2.1~2.75 표시) · 분할 익절 지정가
//   비중  : 90배(BTC) / 20배(하이닉스) · 25% 비중 · 물타기("살짝 추가로")
// 음성이 없어 정확한 지표·기간은 알 수 없다 → 가장 표준적인 해석으로 고정하고(EMA20/50 리본, RSI14 과매도 35/과매수 65)
// 파라미터 이웃을 같이 돌려 "해석이 조금 달라도 결론이 같은지" 본다. 물타기·분할익절은 v1 에서 제외(단일 진입·단일 청산).
//
// 출구는 영상 그대로 % 고정(ATR 아님). 비용 왕복 0.14%. 포지션 1개.

const E = require('./engine');

const DEFAULTS = Object.freeze({
  emaFast: 20,
  emaSlow: 50,
  rsiLen: 14,
  rsiLow: 35, // 이 아래에서 위로 돌파 = "눌림 해소"
  rsiHigh: 65, // 이 위에서 아래로 이탈 = "힘 빠짐"
  stopPct: 0.5,
  targetPct: 1.2,
  maxHoldBars: 24, // 6시간
  feePct: 0.05,
  slipPct: 0.02,
  longOnly: false,
});

function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    prev = prev == null ? values[i] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder RSI 시리즈. 앞 period 개는 null.
function rsiSeries(closes, period = 14) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n < period + 1) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  const rsi = (g, l) => (l === 0 ? (g === 0 ? 50 : 100) : g === 0 ? 0 : 100 - 100 / (1 + g / l));
  out[period] = rsi(avgG, avgL);
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = rsi(avgG, avgL);
  }
  return out;
}

// 봉 i 에서의 신호. 'LONG' | 'SHORT' | null
function signalAt(i, closes, fast, slow, rsi, p) {
  if (i < 1 || rsi[i] == null || rsi[i - 1] == null) return null;
  const up = fast[i] > slow[i];
  const down = fast[i] < slow[i];
  if (up && rsi[i - 1] <= p.rsiLow && rsi[i] > p.rsiLow) return 'LONG';
  if (!p.longOnly && down && rsi[i - 1] >= p.rsiHigh && rsi[i] < p.rsiHigh) return 'SHORT';
  return null;
}

// % 고정 출구 시뮬레이션 — engine.simulateTrade 와 같은 규칙(다음 봉 시가 진입 · 동시 도달은 손절 · 만료는 종가)
function simulatePct(bars, i, side, p) {
  const e = i + 1;
  if (e >= bars.length) return null;
  const entry = bars[e].o;
  const dir = side === 'LONG' ? 1 : -1;
  const stop = entry * (1 - (dir * p.stopPct) / 100);
  const target = entry * (1 + (dir * p.targetPct) / 100);
  const last = Math.min(bars.length - 1, e + p.maxHoldBars);
  let exit = null;
  let reason = null;
  let exitIdx = null;
  for (let j = e; j <= last; j++) {
    const b = bars[j];
    const hitStop = side === 'LONG' ? b.l <= stop : b.h >= stop;
    const hitTarget = side === 'LONG' ? b.h >= target : b.l <= target;
    if (hitStop) { exit = stop; reason = 'stop'; exitIdx = j; break; }
    if (hitTarget) { exit = target; reason = 'target'; exitIdx = j; break; }
  }
  if (exit == null) { exit = bars[last].c; reason = 'time'; exitIdx = last; }
  const gross = ((exit - entry) / entry) * 100 * dir;
  const pct = gross - 2 * (p.feePct + p.slipPct);
  return {
    entryIdx: e, exitIdx, entryTime: bars[e].t, exitTime: bars[exitIdx].t, side, entry, exit, stop, target, reason,
    grossPct: Number(gross.toFixed(4)), pct: Number(pct.toFixed(4)), r: Number((pct / p.stopPct).toFixed(3)), stopPct: p.stopPct, bars: exitIdx - e + 1,
  };
}

function runV1(bars, params = {}) {
  const p = { ...DEFAULTS, ...params };
  const closes = bars.map((b) => b.c);
  const fast = emaSeries(closes, p.emaFast);
  const slow = emaSeries(closes, p.emaSlow);
  const rsi = rsiSeries(closes, p.rsiLen);
  const trades = [];
  let signals = 0;
  let busyUntil = -1;
  for (let i = p.emaSlow; i < bars.length; i++) {
    if (i <= busyUntil) continue;
    const side = signalAt(i, closes, fast, slow, rsi, p);
    if (!side) continue;
    signals += 1;
    const tr = simulatePct(bars, i, side, p);
    if (!tr) continue;
    trades.push(tr);
    busyUntil = tr.exitIdx;
  }
  return { params: p, trades, signals };
}

module.exports = { DEFAULTS, emaSeries, rsiSeries, signalAt, simulatePct, runV1 };

// --- CLI -------------------------------------------------------------------------------------
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const DATA_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data');
  const args = process.argv.slice(2);
  const sweep = args.includes('--sweep');
  const fromIdx = args.indexOf('--from');
  const from = fromIdx >= 0 ? Date.parse(args[fromIdx + 1]) : null;
  const toIdx = args.indexOf('--to');
  const to = toIdx >= 0 ? Date.parse(args[toIdx + 1]) : null;
  const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(d));
  const line = (cols, w) => cols.map((c, i) => String(c).padStart(w[i])).join(' ');
  const W = [26, 7, 6, 6, 6, 8, 6, 8, 8];
  console.log(line(['심볼·변형', '신호', '거래', '승률%', 'PF', '기대값%', '평균R', '누적%', '계좌DD%'], W));
  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    let bars = E.parseCandleCsv(fs.readFileSync(path.join(DATA_DIR, `${symbol}-15m.csv`), 'utf8'));
    if (Number.isFinite(from)) bars = bars.filter((b) => b.t >= from);
    if (Number.isFinite(to)) bars = bars.filter((b) => b.t <= to);
    const variants = [{ name: 'v1 기본', p: {} }, { name: 'v1 롱만', p: { longOnly: true } }];
    if (sweep) {
      for (const stopPct of [0.4, 0.5, 0.75]) for (const targetPct of [1.0, 1.2, 1.5]) for (const rsiLow of [30, 35, 40]) variants.push({ name: `s${stopPct}/t${targetPct}/rsi${rsiLow}`, p: { stopPct, targetPct, rsiLow, rsiHigh: 100 - rsiLow } });
    }
    let pos = 0;
    let tot = 0;
    for (const v of variants) {
      const r = runV1(bars, v.p);
      const s = E.summarize(r.trades);
      if (v.name.startsWith('s')) { tot += 1; if (s.expectancyPct > 0) pos += 1; if (sweep && !(s.expectancyPct > 0)) continue; }
      console.log(line([`${symbol} ${v.name}`, r.signals, s.n, fmt(s.winRate, 1), fmt(s.profitFactor), fmt(s.expectancyPct, 3), fmt(s.avgR), fmt(s.totalPct, 1), fmt(s.equityMaxDrawdownPct, 1)], W));
      if (v.name === 'v1 기본') {
        const by = E.byYear(r.trades);
        console.log('   연도별: ' + Object.keys(by).map((y) => `${y} n${by[y].n} PF${fmt(by[y].profitFactor)}`).join(' · '));
      }
    }
    if (sweep) console.log(`   이웃 ${tot}개 중 양(+) ${pos}개 (${tot ? Math.round((pos / tot) * 100) : 0}%) — 양(+)인 것만 위에 표시`);
  }
}

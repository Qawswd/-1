'use strict';

// backtest/video-v2.js — 영상 1 후속 캡처(docs/videos/01-trading-book.md 추가분)의 핵심 규칙:
// "급등 → 거래량·변동성 점점 감소(수렴 삼각형/페넌트) → 상방 돌파 확률 매우 높음".
//
// 기계화(변동성 수축 돌파, 일명 squeeze breakout):
//   1) 임펄스 : 직전 impulseBars 동안 |변동| ≥ impulsePct
//   2) 수축   : 그 뒤 squeezeBars 동안의 고저 폭이 임펄스 구간 폭의 squeezeRatio 이하 (거래량도 평균 대비 volRatio 이하)
//   3) 돌파   : 종가가 수축 구간 고점 위(롱) / 저점 아래(숏) 로 마감, 돌파 봉 거래량이 수축 평균의 breakVol 배 이상
//   4) 출구   : 손절 = 수축 구간 반대편(혹은 최소 minStopPct), 목표 = 손절거리 × rr, 최대 maxHoldBars
// 영상은 "상승 페넌트 → 상방 돌파"만 말하지만, 방향 편향이 진짜인지 보려고 양방향·롱만·임펄스 방향만 세 변형을 돌린다.

const E = require('./engine');

const DEFAULTS = Object.freeze({
  impulseBars: 16, // 4시간
  impulsePct: 3.0,
  squeezeBars: 16, // 4시간
  squeezeRatio: 0.5, // 수축 폭 ≤ 임펄스 폭 × 0.5
  volRatio: 0.8, // 수축 구간 평균 거래량 ≤ 임펄스 구간 평균 × 0.8
  breakVol: 1.5, // 돌파 봉 거래량 ≥ 수축 평균 × 1.5
  minStopPct: 0.3,
  rr: 2.0,
  maxHoldBars: 48,
  feePct: 0.05,
  slipPct: 0.02,
  mode: 'both', // 'both' | 'long' | 'with-impulse'(임펄스 방향으로만)
});

function mean(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
}

// 봉 i 에서 돌파 신호 판정. 반환 { side, hi, lo, impulseDir } | null
function signalAt(bars, i, p) {
  const sqStart = i - p.squeezeBars; // 수축 구간 [sqStart, i-1]
  const impStart = sqStart - p.impulseBars; // 임펄스 구간 [impStart, sqStart-1]
  if (impStart < 1) return null;
  const impMove = ((bars[sqStart - 1].c - bars[impStart - 1].c) / bars[impStart - 1].c) * 100;
  if (Math.abs(impMove) < p.impulsePct) return null;
  let impHi = -Infinity;
  let impLo = Infinity;
  let impVol = 0;
  for (let k = impStart; k < sqStart; k++) {
    if (bars[k].h > impHi) impHi = bars[k].h;
    if (bars[k].l < impLo) impLo = bars[k].l;
    impVol += bars[k].v;
  }
  let hi = -Infinity;
  let lo = Infinity;
  let sqVol = 0;
  for (let k = sqStart; k < i; k++) {
    if (bars[k].h > hi) hi = bars[k].h;
    if (bars[k].l < lo) lo = bars[k].l;
    sqVol += bars[k].v;
  }
  const impRange = impHi - impLo;
  if (!(impRange > 0) || hi - lo > impRange * p.squeezeRatio) return null;
  const sqAvgVol = sqVol / p.squeezeBars;
  if (sqAvgVol > (impVol / p.impulseBars) * p.volRatio) return null;
  const b = bars[i];
  if (b.v < sqAvgVol * p.breakVol) return null;
  const impulseDir = impMove > 0 ? 'LONG' : 'SHORT';
  let side = null;
  if (b.c > hi) side = 'LONG';
  else if (b.c < lo) side = 'SHORT';
  if (!side) return null;
  if (p.mode === 'long' && side !== 'LONG') return null;
  if (p.mode === 'with-impulse' && side !== impulseDir) return null;
  return { side, hi, lo, impulseDir, impMove: Number(impMove.toFixed(2)) };
}

function simulate(bars, i, sig, p) {
  const e = i + 1;
  if (e >= bars.length) return null;
  const entry = bars[e].o;
  const dir = sig.side === 'LONG' ? 1 : -1;
  let dist = sig.side === 'LONG' ? entry - sig.lo : sig.hi - entry;
  const minDist = (entry * p.minStopPct) / 100;
  if (!(dist > 0) || dist < minDist) dist = minDist;
  const stop = entry - dir * dist;
  const target = entry + dir * dist * p.rr;
  const last = Math.min(bars.length - 1, e + p.maxHoldBars);
  let exit = null;
  let reason = null;
  let exitIdx = null;
  for (let j = e; j <= last; j++) {
    const b = bars[j];
    const hitStop = dir === 1 ? b.l <= stop : b.h >= stop;
    const hitTarget = dir === 1 ? b.h >= target : b.l <= target;
    if (hitStop) { exit = stop; reason = 'stop'; exitIdx = j; break; }
    if (hitTarget) { exit = target; reason = 'target'; exitIdx = j; break; }
  }
  if (exit == null) { exit = bars[last].c; reason = 'time'; exitIdx = last; }
  const gross = ((exit - entry) / entry) * 100 * dir;
  const pct = gross - 2 * (p.feePct + p.slipPct);
  const stopPct = (dist / entry) * 100;
  return { entryIdx: e, exitIdx, entryTime: bars[e].t, exitTime: bars[exitIdx].t, side: sig.side, entry, exit, stop, target, reason, grossPct: Number(gross.toFixed(4)), pct: Number(pct.toFixed(4)), r: Number((pct / stopPct).toFixed(3)), stopPct: Number(stopPct.toFixed(4)), bars: exitIdx - e + 1, impulseDir: sig.impulseDir };
}

function runV2(bars, params = {}) {
  const p = { ...DEFAULTS, ...params };
  const trades = [];
  let signals = 0;
  let busyUntil = -1;
  for (let i = p.impulseBars + p.squeezeBars + 1; i < bars.length; i++) {
    if (i <= busyUntil) continue;
    const sig = signalAt(bars, i, p);
    if (!sig) continue;
    signals += 1;
    const tr = simulate(bars, i, sig, p);
    if (!tr) continue;
    trades.push(tr);
    busyUntil = tr.exitIdx;
  }
  return { params: p, trades, signals };
}

module.exports = { DEFAULTS, signalAt, simulate, runV2 };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const DATA_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data');
  const args = process.argv.slice(2);
  const sweep = args.includes('--sweep');
  const fromIdx = args.indexOf('--from');
  const from = fromIdx >= 0 ? Date.parse(args[fromIdx + 1]) : null;
  const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(d));
  const line = (cols, w) => cols.map((c, i) => String(c).padStart(w[i])).join(' ');
  const W = [34, 6, 6, 6, 6, 8, 6, 8, 8];
  console.log(line(['심볼·변형', '신호', '거래', '승률%', 'PF', '기대값%', '평균R', '누적%', '계좌DD%'], W));
  for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
    let bars = E.parseCandleCsv(fs.readFileSync(path.join(DATA_DIR, `${symbol}-15m.csv`), 'utf8'));
    if (Number.isFinite(from)) bars = bars.filter((b) => b.t >= from);
    const variants = [
      { name: 'v2 양방향', p: {} },
      { name: 'v2 롱만', p: { mode: 'long' } },
      { name: 'v2 임펄스 방향(페넌트)', p: { mode: 'with-impulse' } },
    ];
    if (sweep) {
      for (const impulsePct of [2, 3, 5]) for (const squeezeRatio of [0.4, 0.5, 0.7]) for (const rr of [1.5, 2, 3]) for (const maxHoldBars of [24, 48, 96]) variants.push({ name: `imp${impulsePct}/sq${squeezeRatio}/rr${rr}/h${maxHoldBars}`, p: { impulsePct, squeezeRatio, rr, maxHoldBars, mode: 'with-impulse' } });
    }
    let pos = 0;
    let tot = 0;
    for (const v of variants) {
      const r = runV2(bars, v.p);
      const s = E.summarize(r.trades);
      const isSweep = v.name.startsWith('imp');
      if (isSweep) { if (s.n < 30) continue; tot += 1; if (s.expectancyPct > 0) pos += 1; if (!(s.expectancyPct > 0) || s.profitFactor < 1.2) continue; }
      console.log(line([`${symbol} ${v.name}`, r.signals, s.n, fmt(s.winRate, 1), fmt(s.profitFactor), fmt(s.expectancyPct, 3), fmt(s.avgR), fmt(s.totalPct, 1), fmt(s.equityMaxDrawdownPct, 1)], W));
      if (!isSweep) {
        const by = E.byYear(r.trades);
        console.log('   연도별: ' + Object.keys(by).map((y) => `${y} n${by[y].n} PF${fmt(by[y].profitFactor)}`).join(' · '));
      }
    }
    if (sweep) console.log(`   이웃(임펄스 방향) ${tot}개 중 양(+) ${pos}개 (${tot ? Math.round((pos / tot) * 100) : 0}%) — PF≥1.2 인 것만 위에 표시`);
  }
}

'use strict';

// backtest/short-term.js — 짧게 사고파는 대표 전략 3가지를 BTC·ETH 6.7년 일봉으로 시험한다(2026-10-15, 오너 "장기투자는 원하지 않는다").
//   ① 변동성 돌파(래리 윌리엄스, 한국 코인 자동매매에서 가장 유명): 오늘 시가 + k×(어제 고가−저가)를 넘으면 그 가격에 사서 다음 날 시가에 판다(옵션: 5일선 위일 때만)
//   ② RSI(2) 되돌림(코너스): 200일선 위에서 RSI2 가 낮게 마감하면 사고, 5일선 위로 올라오면 판다
//   ③ 단기 돌파(터틀 축소판): N일 최고가 돌파 마감 → 다음 날 시가 매수, N/2일 최저가 이탈 마감 → 다음 날 시가 매도
// 비용 한쪽 0.07%, 펀딩 반영(변동성 돌파는 하루 중 절반만 들고 있다고 본다). 전부 넣었을 때 기준.
//   node server/backtest/short-term.js
const path = require('path');
const root = path.join(__dirname, '..', '..');
const E = require('./engine');
const fs = require('fs');
const T = require('./trend');
const { parseFundingCsv } = require('./carry');
const DAY = 86400000, SIDE = 0.0007, OOS = Date.parse('2024-01-01');
const load = (s) => ({ d: E.parseCandleCsv(fs.readFileSync(`${root}/reports/backtest/data/${s}-1d.csv`, 'utf8')), f: parseFundingCsv(fs.readFileSync(`${root}/reports/backtest/data/${s}-funding.csv`, 'utf8')) });
const fundDay = (f) => { const m = new Map(); for (const x of f) { const k = Math.floor(x.t / DAY) * DAY; m.set(k, (m.get(k) || 0) + x.rate); } return m; };
// 하루 단위 수익률 목록 + 거래 목록 → 성적
function report(days, trades) {
  const s = T.summarizeTrend(days), o = T.summarizeTrend(days, { from: OOS });
  const w = trades.filter((x) => x > 0), l = trades.filter((x) => x <= 0);
  const pf = l.length ? w.reduce((a, b) => a + b, 0) / Math.abs(l.reduce((a, b) => a + b, 0)) : null;
  return { cagr: s.cagrPct, dd: s.maxDrawdownPct, n: trades.length, win: Math.round((w.length / trades.length) * 1000) / 10, pf: pf && Math.round(pf * 100) / 100, oos: o ? `${o.cagrPct}/${o.maxDrawdownPct}` : '-', pm: s.positiveMonthsPct, years: s.byYear };
}
// 1) 변동성 돌파: 오늘 시가 + k×(어제 고가−저가) 를 넘으면 그 가격에 사서, 다음 날 시가(=오늘 종가)에 판다. 옵션: 5일 평균선 위일 때만
function volBreakout(d, f, k, maFilter) {
  const fd = fundDay(f); const days = []; const trades = [];
  for (let i = 0; i < d.length; i++) {
    let ret = 0;
    if (i >= 6) {
      const prev = d[i - 1], b = d[i];
      const target = b.o + k * (prev.h - prev.l);
      const ma5 = (d[i - 1].c + d[i - 2].c + d[i - 3].c + d[i - 4].c + d[i - 5].c) / 5;
      if (b.h >= target && (!maFilter || b.o > ma5)) {
        const entry = Math.max(target, b.o);
        ret = (b.c / entry) * (1 - SIDE) * (1 - SIDE) - 1 - 0.5 * (fd.get(Math.floor(b.t / DAY) * DAY) || 0);
        trades.push(ret);
      }
    }
    days.push({ t: d[i].t, ret });
  }
  return report(days, trades);
}
// 2) RSI(2) 되돌림(코너스): 200일 평균 위에서 RSI2 < th 로 마감하면 종가에 사고, 종가가 5일 평균 위로 올라오면 종가에 판다
function rsi2(d, f, th) {
  const fd = fundDay(f); const days = []; const trades = [];
  let inPos = false, entry = 0, mul = 1;
  const rsi = []; let ag = 0, al = 0;
  for (let i = 1; i < d.length; i++) {
    const ch = d[i].c - d[i - 1].c; const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    ag = i < 3 ? (ag * (i - 1) + g) / i : (ag + g) / 2; al = i < 3 ? (al * (i - 1) + l) / i : (al + l) / 2; // 2일 와일더 평활
    rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  days.push({ t: d[0].t, ret: 0 });
  for (let i = 1; i < d.length; i++) {
    let ret = 0;
    if (inPos) { ret = d[i].c / d[i - 1].c - 1 - (fd.get(Math.floor(d[i].t / DAY) * DAY) || 0); mul *= 1 + ret; }
    const sma = (n) => { let s = 0; for (let j = i - n + 1; j <= i; j++) s += d[j].c; return s / n; };
    if (i >= 200) {
      if (!inPos && rsi[i] < th && d[i].c > sma(200)) { inPos = true; mul = 1 - SIDE; ret += -SIDE; }
      else if (inPos && d[i].c > sma(5)) { inPos = false; ret += -SIDE; mul *= 1 - SIDE; trades.push(mul - 1); }
    }
    days.push({ t: d[i].t, ret });
  }
  return report(days, trades);
}
// 3) 단기 돌파(터틀 축소판): 종가가 직전 N일 최고가 위면 다음 날 시가에 사고, 직전 N/2일 최저가 밑으로 마감하면 다음 날 시가에 판다
function donchian(d, f, n) {
  const fd = fundDay(f); const days = []; const trades = []; let inPos = false, mul = 1, pending = 0;
  for (let i = 0; i < d.length; i++) {
    const b = d[i]; let ret = 0;
    if (pending === 1) { inPos = true; mul = 1; ret = (b.c / b.o) * (1 - SIDE) - 1; mul *= 1 + ret; }
    else if (pending === -1) { ret = (b.o / d[i - 1].c) * (1 - SIDE) - 1; mul *= 1 + ret; trades.push(mul - 1); inPos = false; }
    else if (inPos) { ret = b.c / d[i - 1].c - 1 - (fd.get(Math.floor(b.t / DAY) * DAY) || 0); mul *= 1 + ret; }
    pending = 0;
    if (i >= n) {
      let hi = -Infinity, lo = Infinity; for (let j = i - n; j < i; j++) hi = Math.max(hi, d[j].h);
      for (let j = i - Math.floor(n / 2); j < i; j++) lo = Math.min(lo, d[j].l);
      if (!inPos && b.c > hi && i + 1 < d.length) pending = 1;
      else if (inPos && b.c < lo && i + 1 < d.length) pending = -1;
    }
    days.push({ t: b.t, ret });
  }
  return report(days, trades);
}
function main() {
  const fmt = (name, r) => `${name.padEnd(30)} 연 ${String(r.cagr).padStart(7)}% · 최대손실 −${String(r.dd).padStart(5)}% · 거래 ${String(r.n).padStart(4)} · 승률 ${r.win}% · PF ${r.pf} · 플러스월 ${r.pm}% · 2024~ ${r.oos}`;
  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    const { d, f } = load(sym);
    console.log(`\n== ${sym} (그냥 보유: 연 ${T.summarizeTrend(T.buyHoldDays(d)).cagrPct}%)`);
    for (const k of [0.3, 0.4, 0.5, 0.6, 0.7]) console.log(fmt(`변동성돌파 k=${k}`, volBreakout(d, f, k, false)));
    for (const k of [0.3, 0.5, 0.7]) { const r = volBreakout(d, f, k, true); console.log(fmt(`변동성돌파 k=${k} +5일선`, r)); if (k === 0.5) console.log('   연도별', JSON.stringify(r.years)); }
    for (const th of [5, 10, 20]) console.log(fmt(`RSI2<${th} 되돌림`, rsi2(d, f, th)));
    for (const n of [10, 20, 40]) { const r = donchian(d, f, n); console.log(fmt(`돌파 ${n}일`, r)); if (n === 20) console.log('   연도별', JSON.stringify(r.years)); }
  }
}

if (require.main === module) main();

module.exports = { volBreakout, rsi2, donchian };

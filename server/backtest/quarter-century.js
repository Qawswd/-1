'use strict';

// quarter-century.js — 지난 25년(2001-11 ~ 지금) 주식 칸만(2026-11-13 오너 '지난 25년은?').
// 코인은 2010 전에 없었고 우리 기록은 2015~ 라 코인 두 칸은 현금(0%)으로 둔다 = '코인이 못 벌 때'와 같은 계산.
// 규칙은 지금 주식 규칙 그대로(ten-year STOP_CLOSE: 두 선 위에서 사고 · 200일선 아래 마감 정리 · 종가 손절 −25% · 익절 없음) · 칸 20%.
// 2001~2010(닷컴 붕괴 · 2008 금융위기 — 지수가 10년 제자리)과 2011~ 를 나눠 본다. 종목 하나에 다 넣었을 때 규칙 vs 그냥 들고 있기도.
// 데이터(서버): node server/backtest/fetch-stocks.js --from 1995 SPY QQQ MSFT NVDA  → reports/backtest/data/stocks/<SYM>-1d.csv
//   node server/backtest/quarter-century.js [--from 2001-11-01] [--split 2011] [--combo SPY,QQQ,MSFT ...]
// 한계: 네 종목 모두 '살아남은' 회사다(2000 년의 시스코 · 인텔처럼 무너진 1등은 후보에 없다) — 실제 고를 때의 불확실성은 이보다 크다.

const fs = require('fs');
const path = require('path');
const E = require('./engine');
const FS = require('./fetch-stocks');
const X = require('./exits');
const T = require('./trend');
const U = require('./stock-universe');
const TY = require('./ten-year');

const DAY = 86400000;
const DEFAULT_COMBOS = Object.freeze([['SPY', 'QQQ', 'MSFT'], ['SPY', 'MSFT', 'NVDA'], ['NVDA', 'QQQ', 'MSFT']]);
const pc = (x) => (x == null || !Number.isFinite(x) ? '-' : `${Math.round(x * 1000) / 10}`);
const p1 = (x) => (x == null || !Number.isFinite(x) ? '-' : `${Math.round(x * 10) / 10}`);
const dayStr = (d) => new Date(d * DAY).toISOString().slice(0, 10);

function loadStock(dir, sym) {
  const p = path.join(dir, `${FS.fileKey(sym)}-1d.csv`);
  if (!fs.existsSync(p)) return null;
  const rows = E.parseCandleCsv(fs.readFileSync(p, 'utf8'));
  return FS.looksDaily(rows) ? rows : null;
}

// 한 조합 · 한 구간(d0, n) — 주식 세 칸 20% · 코인 두 칸 현금
function comboStats(runs, names, d0, n) {
  const stockG = runs.map((r) => TY.toGrid(r.days, d0, n));
  const coinG = [new Float64Array(n), new Float64Array(n)];
  const res = TY.runAll({ coinG, stockG, names, w: 0.2, d0, n });
  const [H1, H3, H5] = res.hist;
  const neg = (H) => (H.n ? { pct: (H.neg / H.n) * 100, worst: H.min.v } : null);
  return { cagr: res.cagr[0], multiple: res.multiple[0], dd: res.dd[0], worstYear: res.worstYear[0], negYears: res.negYears[0], years: res.years, yearly: res.years.map((y, j) => res.yearly[j][0]), under: res.under[0], h1: neg(H1), h3: neg(H3), h5: neg(H5) };
}

function line(label, s) {
  const h = (x, k) => (x ? `${k} 마이너스 ${p1(x.pct)}% · 최악 ${p1(x.worst)}%` : `${k} -`);
  return `    ${label}: 1년 평균 ${pc(s.cagr)}% · 1,000만 원 → ${Math.round(s.multiple * 1000).toLocaleString()}만 · 최대 손실 −${pc(s.dd)}% · 최악의 해 ${pc(s.worstYear)}% · 마이너스 해 ${s.negYears}/${s.years.length} · 다시 고점까지 최장 ${s.under}일 | ${h(s.h1, '1년 뒤')} · ${h(s.h3, '3년 뒤')} · ${h(s.h5, '5년 뒤')}`;
}

function report({ stocks, combos, from, split, log }) {
  const lastT = Math.min(...[...stocks.values()].map((b) => b[b.length - 1].t));
  const d0 = Math.floor(from / DAY);
  const n = Math.floor(lastT / DAY) - d0 + 1;
  const s0 = Math.floor(Date.UTC(split, 0, 1) / DAY);
  log(`■ 지난 25년 — ${dayStr(d0)} ~ ${dayStr(d0 + n - 1)} · 주식 세 칸 20%(코인 두 칸은 현금 — 코인이 없던 시절) · 지금 주식 규칙(두 선 위 → 200일선 아래 · 종가 손절 −25% · 익절 없음) · 비용 한쪽 0.07%`);
  log('  ※ 네 종목 모두 살아남은 회사다 — 2000 년에 같은 방법으로 골랐다면 시스코 · 인텔처럼 무너진 1등이 섞였을 수 있다.');
  const runs = new Map([...stocks].map(([sym, bars]) => [sym, X.simulateExits(bars, TY.STOP_CLOSE)]));
  const out = [];
  for (const combo of combos) {
    if (!combo.every((s) => stocks.has(s))) {
      log(`  [${combo.join(' · ')}] 데이터 없음(${combo.filter((s) => !stocks.has(s)).join(' · ')})`);
      continue;
    }
    const rs = combo.map((s) => runs.get(s));
    const all = comboStats(rs, combo, d0, n);
    const a = comboStats(rs, combo, d0, s0 - d0);
    const b = comboStats(rs, combo, s0, d0 + n - s0);
    log(`  [${combo.join(' · ')}]`);
    log(line(`25년 전체`, all));
    log(`       연도별 ${all.years.map((y, j) => `${y} ${pc(all.yearly[j])}%`).join(' · ')}`);
    log(line(`${dayStr(d0).slice(0, 4)}~${split - 1}(닷컴 붕괴 · 금융위기)`, a));
    log(line(`${split}~`, b));
    out.push({ combo, all, a, b });
  }
  log('  종목 하나에 다 넣었을 때 — 규칙 vs 그냥 들고 있기(1년 평균 / 최대 손실):');
  for (const [sym, bars] of stocks) {
    const r = runs.get(sym);
    const segs = [[from, Infinity, '25년'], [from, s0 * DAY - 1, `~${split - 1}`], [s0 * DAY, Infinity, `${split}~`]].map(([f, t, label]) => {
      const x = T.summarizeTrend(r.days, { from: f, to: t });
      const h = T.summarizeTrend(U.holdDays(bars), { from: f, to: t });
      return `${label} 규칙 ${x ? `${x.cagrPct}% / −${x.maxDrawdownPct}%` : '-'} · 들고 있기 ${h ? `${h.cagrPct}% / −${h.maxDrawdownPct}%` : '-'}`;
    });
    const tr = r.trades.filter((t) => t.entryT >= from);
    log(`    ${sym}: ${segs.join(' | ')} · 거래 ${tr.length}번 · 손절 ${tr.filter((t) => t.reason === 'stop').length}번`);
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : d);
  const dir = path.resolve(arg('--dir', FS.OUT_DIR));
  const from = Date.parse(`${arg('--from', '2001-11-01')}T00:00:00Z`);
  const split = Number(arg('--split', 2011)) || 2011;
  const ci = argv.indexOf('--combo');
  const combos = ci >= 0 ? argv.slice(ci + 1).filter((x) => !x.startsWith('--')).map((x) => x.split(',').map((y) => y.trim().toUpperCase()).filter(Boolean)) : DEFAULT_COMBOS;
  const syms = [...new Set(combos.flat())];
  const stocks = new Map();
  const missing = [];
  for (const s of syms) {
    const bars = loadStock(dir, s);
    // 시작 전에 200일선이 생겨 있어야 한다
    if (bars && bars.length > 200 && bars[200].t <= from) stocks.set(s, bars);
    else missing.push(s);
  }
  if (missing.length) console.log(`기록이 없거나 ${new Date(from).toISOString().slice(0, 10)} 전에 200일이 안 되는 종목: ${missing.join(' · ')} — 먼저 node server/backtest/fetch-stocks.js --from 1995 ${syms.join(' ')}`);
  if (!stocks.size) return;
  report({ stocks, combos, from, split, log: (s = '') => console.log(s) });
}

if (require.main === module) main();

module.exports = { comboStats, report, loadStock, DEFAULT_COMBOS };

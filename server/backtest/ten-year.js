'use strict';

// ten-year.js — 다시 시작 판(토스 주식 3 + 업비트 BTC·ETH 롱만)을 최근 약 10년에 '모든 경우의 수'로(2026-11-01, 오너
// "토스 업비트 20퍼로 했을 때 잘됐을 때랑 실패했을 때의 최근 10년치 결과를 모든 경우의 수로 — 시간이 얼마가 걸리든").
// 경우의 수 = ① 주식 3개를 고르는 모든 조합(목록 N개 중 3개) × ② 시작한 날(기간 안의 모든 날) × ③ 들고 간 기간(1·3·5년, 끝까지)
// 규칙은 docs/08 그대로: 종목마다 칸 하나(20%, 비교로 15%) · 두 선(50·200) 위 마감 → 다음 날 시가 · 손절 −10% · 익절 +30% ·
//   선 하나라도 아래 마감 → 다음 날 시가 정리 · 현물·실제 주식이라 펀딩 없음 · 비용 한쪽 0.07%
// 데이터: 코인 = fetch-coins-long.js(현물 USD 일봉, 2015~) · 주식 = fetch-tradfi.js(Yahoo 일봉, 2015~) — 기간 시작 전에 200일선이 생긴 종목만
// 한계(결과를 할인해서 본다): 주식 목록은 바이낸스가 이미 오른 종목을 골라 상장한 것(망한 회사는 없다) · 같은 날 손절·익절이 둘 다 닿으면
//   손절로 본다(옛 15분봉이 없다) · 코인은 09:00 실행(17:30 이면 1년 약 2.5%p 덜) · 업비트 원화 가격·환율·세금은 넣지 않았다 ·
//   중간에 시작한 날은 그날 규칙이 들고 있던 것을 그대로 이어받는다(새로 시작해도 두 선 위면 바로 사므로 거의 같다)
//   node server/backtest/ten-year.js [--from 2016-11-01] [--dir reports/backtest/data]

const fs = require('fs');
const path = require('path');
const E = require('./engine');
const T = require('./trend');
const X = require('./exits');
const U = require('./stock-universe');

const DAY = 86400000;
const LONG = { mode: 'long', stop: { k: 'pct', v: 10 }, tp: 3, trail: 'none', signalExit: true, holdDays: 0 };
const HORIZONS = Object.freeze([['1년', 365], ['3년', 1096], ['5년', 1826]]);
const QS = Object.freeze([[0, '최악'], [0.01, '1%'], [0.05, '5%'], [0.1, '10%'], [0.25, '25%'], [0.5, '중간'], [0.75, '75%'], [0.9, '90%'], [0.95, '95%'], [0.99, '99%'], [1, '최고']]);

function loadLongCoins(dir) {
  const out = [];
  for (const name of ['BTC', 'ETH']) {
    const p = path.join(dir, 'long', `${name}-USD-1d.csv`);
    if (fs.existsSync(p)) out.push({ name, bars: E.parseCandleCsv(fs.readFileSync(p, 'utf8')) });
  }
  return out;
}

// 하루 수익을 UTC 날짜 칸에 — 코인은 매일, 주식은 장 서는 날만(나머지 0)
function toGrid(days, d0, n) {
  const g = new Float64Array(n);
  for (const d of days) {
    const k = Math.floor(d.t / DAY) - d0;
    if (k >= 0 && k < n) g[k] = (1 + g[k]) * (1 + d.ret) - 1;
  }
  return g;
}

// 정렬된 복사본의 분위수
function quantiles(arr) {
  const v = Float64Array.from(arr).filter(Number.isFinite).sort();
  if (!v.length) return null;
  return QS.map(([q]) => v[Math.min(v.length - 1, Math.round(q * (v.length - 1)))]);
}

// 1% 칸 히스토그램(−100% ~ +limit%) — 수억 개 값을 메모리 없이 센다
class Hist {
  constructor(limit = 20000) {
    this.limit = limit;
    this.counts = new Float64Array(limit + 101);
    this.n = 0;
    this.neg = 0;
    this.le20 = 0;
    this.min = { v: Infinity };
    this.max = { v: -Infinity };
  }
  add(pct, tag) {
    const k = Math.max(0, Math.min(this.counts.length - 1, Math.floor(pct) + 100));
    this.counts[k]++;
    this.n++;
    if (pct < 0) this.neg++;
    if (pct <= -20) this.le20++;
    if (pct < this.min.v) this.min = { v: pct, tag };
    if (pct > this.max.v) this.max = { v: pct, tag };
  }
  quantile(q) {
    if (!this.n) return null;
    if (q <= 0) return this.min.v;
    if (q >= 1) return this.max.v;
    const target = q * (this.n - 1);
    let acc = 0;
    for (let k = 0; k < this.counts.length; k++) {
      acc += this.counts[k];
      if (acc > target) return k - 100 + 0.5; // 칸 가운데
    }
    return this.max.v;
  }
}

// 하루 수익(acc) → 그 조합의 성적 · E 는 길이 n+1(E[0] = 1, E[k+1] = k 일 뒤)
function equityStats(acc, E2, years) {
  const n = acc.length;
  E2[0] = 1;
  let peak = 1;
  let peakK = 0;
  let dd = 0;
  let under = 0;
  for (let k = 0; k < n; k++) {
    const e = E2[k] * (1 + acc[k]);
    E2[k + 1] = e;
    if (e >= peak) {
      peak = e;
      peakK = k + 1;
    } else {
      const x = 1 - e / peak;
      if (x > dd) dd = x;
      if (k + 1 - peakK > under) under = k + 1 - peakK;
    }
  }
  const yearly = years.map(([s, e]) => E2[e + 1] / E2[s] - 1);
  return {
    multiple: E2[n],
    cagr: Math.pow(E2[n], 365.25 / n) - 1,
    dd,
    under,
    yearly,
    worstYear: Math.min(...yearly),
    negYears: yearly.filter((x) => x < 0).length,
  };
}

// 달력 연도별 [시작 칸, 끝 칸]
function yearRanges(d0, n) {
  const out = [];
  let cur = null;
  for (let k = 0; k < n; k++) {
    const y = new Date((d0 + k) * DAY).getUTCFullYear();
    if (!cur || cur.y !== y) {
      if (cur) out.push(cur);
      cur = { y, s: k, e: k };
    } else cur.e = k;
  }
  if (cur) out.push(cur);
  return out;
}

// 칸 w 로 모든 3종목 조합을 돈다 — 조합 성적 · 연도별 · 시작 날짜 × 기간 히스토그램
function runAll({ coinG, stockG, names, w, d0, n, onProgress }) {
  const N = stockG.length;
  const yr = yearRanges(d0, n);
  const years = yr.map((y) => [y.s, y.e]);
  const total = (N * (N - 1) * (N - 2)) / 6;
  const res = {
    total,
    years: yr.map((y) => y.y),
    cagr: new Float64Array(total),
    multiple: new Float64Array(total),
    dd: new Float64Array(total),
    under: new Float64Array(total),
    worstYear: new Float64Array(total),
    negYears: new Float64Array(total),
    yearly: yr.map(() => new Float64Array(total)),
    hist: HORIZONS.map(() => new Hist()),
    best: [],
    worst: [],
  };
  const coinPart = new Float64Array(n);
  for (const g of coinG) for (let k = 0; k < n; k++) coinPart[k] += w * g[k];
  const acc = new Float64Array(n);
  const E2 = new Float64Array(n + 1);
  const keep = (list, item, better) => {
    list.push(item);
    list.sort((a, b) => (better(a, b) ? -1 : 1));
    if (list.length > 5) list.pop();
  };
  let idx = 0;
  let lastPct = -1;
  for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) for (let c = b + 1; c < N; c++) {
    const ga = stockG[a];
    const gb = stockG[b];
    const gc = stockG[c];
    for (let k = 0; k < n; k++) acc[k] = coinPart[k] + w * (ga[k] + gb[k] + gc[k]);
    const s = equityStats(acc, E2, years);
    res.cagr[idx] = s.cagr;
    res.multiple[idx] = s.multiple;
    res.dd[idx] = s.dd;
    res.under[idx] = s.under;
    res.worstYear[idx] = s.worstYear;
    res.negYears[idx] = s.negYears;
    s.yearly.forEach((v, j) => { res.yearly[j][idx] = v; });
    const item = { names: [names[a], names[b], names[c]], cagr: s.cagr, dd: s.dd, worstYear: s.worstYear, multiple: s.multiple };
    keep(res.best, item, (x, y) => x.cagr > y.cagr);
    keep(res.worst, item, (x, y) => x.cagr < y.cagr);
    HORIZONS.forEach(([, h], j) => {
      const H = res.hist[j];
      for (let st = 0; st + h <= n; st++) H.add((E2[st + h] / E2[st] - 1) * 100, idx * 100000 + st);
    });
    idx++;
    const pct = Math.floor((idx / total) * 10);
    if (onProgress && pct !== lastPct) {
      lastPct = pct;
      onProgress(pct * 10);
    }
  }
  return res;
}

const p1 = (x) => (x == null || !Number.isFinite(x) ? '-' : `${Math.round(x * 10) / 10}`);
const pc = (x) => p1(x * 100);
const dayStr = (d) => new Date(d * DAY).toISOString().slice(0, 10);

function report(res, { w, d0, n, names, log }) {
  const N = names.length;
  const combo = (tag) => {
    const id = Math.floor(tag / 100000);
    const st = tag % 100000;
    // id → (a,b,c) 되돌리기
    let k = 0;
    for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) {
      const cnt = N - b - 1;
      if (k + cnt > id) return { names: [names[a], names[b], names[b + 1 + (id - k)]], start: dayStr(d0 + st) };
      k += cnt;
    }
    return { names: [], start: dayStr(d0 + st) };
  };
  // highIsWorse: 최대 손실·물린 날·마이너스 해처럼 클수록 나쁜 값은 순서를 뒤집어 '최악'이 가장 큰 값이 되게
  const row = (label, arr, fmt, highIsWorse = false) => {
    const q = quantiles(arr);
    const ordered = q && highIsWorse ? [...q].reverse() : q;
    log(`  ${label}: ${ordered ? QS.map(([, l], i) => `${l} ${fmt(ordered[i])}`).join(' · ') : '데이터 없음'}`);
  };
  log(`\n■ 칸 ${w * 100}% — 주식 ${N}개 중 3개 모든 조합 ${res.total.toLocaleString()}가지 × 시작한 날 · ${dayStr(d0)} ~ ${dayStr(d0 + n - 1)}(${p1(n / 365.25)}년)`);
  log('① 처음부터 끝까지(조합마다 하나) — 분위수: 최악 · 1% · 5% · 10% · 25% · 중간 · 75% · 90% · 95% · 99% · 최고');
  row('1년 평균 수익률 %', res.cagr, pc);
  row('1,000만 원 → 끝에(만 원)', res.multiple, (x) => `${Math.round(x * 1000).toLocaleString()}`);
  row('최대 손실 %(고점 대비)', res.dd, (x) => `−${pc(x)}`, true);
  row('최악의 해 %', res.worstYear, pc);
  row('마이너스인 해 수', res.negYears, (x) => `${x}/${res.years.length}`, true);
  row('다시 고점까지 가장 길게(일)', res.under, (x) => `${Math.round(x)}`, true);
  const lossCombos = res.multiple.filter((x) => x < 1).length;
  log(`  끝에 원금보다 적은 조합: ${lossCombos.toLocaleString()}가지(${p1((lossCombos / res.total) * 100)}%)`);
  log(`  가장 잘된 5: ${res.best.map((x) => `${x.names.join('·')} 연 ${pc(x.cagr)}% / −${pc(x.dd)}% / 최악의 해 ${pc(x.worstYear)}%`).join(' | ')}`);
  log(`  가장 안된 5: ${res.worst.map((x) => `${x.names.join('·')} 연 ${pc(x.cagr)}% / −${pc(x.dd)}% / 최악의 해 ${pc(x.worstYear)}%`).join(' | ')}`);
  log(`② 해마다 정산(${res.years[0]} 은 ${dayStr(d0).slice(5)}부터, ${res.years[res.years.length - 1]} 은 ${dayStr(d0 + n - 1).slice(5)}까지) — 최악 · 10% · 중간 · 90% · 최고 · 그해 마이너스 조합`);
  res.years.forEach((y, j) => {
    const q = quantiles(res.yearly[j]);
    const neg = res.yearly[j].filter((x) => x < 0).length;
    log(`  ${y}: ${pc(q[0])} · ${pc(q[3])} · ${pc(q[5])} · ${pc(q[7])} · ${pc(q[10])} · 마이너스 ${p1((neg / res.total) * 100)}%`);
  });
  log('③ 아무 날 시작해서 정해진 기간 뒤(모든 조합 × 모든 시작한 날) — 분위수 · 마이너스로 끝난 비율 · −20% 이하 비율');
  HORIZONS.forEach(([label], j) => {
    const H = res.hist[j];
    if (!H.n) return log(`  ${label} 뒤: 기간이 모자람`);
    const lo = combo(H.min.tag);
    const hi = combo(H.max.tag);
    log(`  ${label} 뒤(${H.n.toLocaleString()}가지): ${QS.map(([q, l]) => `${l} ${p1(H.quantile(q))}%`).join(' · ')} · 마이너스 ${p1((H.neg / H.n) * 100)}% · −20% 이하 ${p1((H.le20 / H.n) * 100)}%`);
    log(`     가장 나빴던 경우: ${lo.names.join('·')} · ${lo.start} 시작 → ${p1(H.min.v)}% | 가장 좋았던 경우: ${hi.names.join('·')} · ${hi.start} 시작 → ${p1(H.max.v)}%`);
  });
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : d);
  const dir = path.resolve(arg('--dir', path.join(__dirname, '..', '..', 'reports', 'backtest', 'data')));
  const out = [];
  const log = (s = '') => { console.log(s); out.push(s); };
  const coins = loadLongCoins(dir);
  if (coins.length < 2) return log('BTC·ETH 긴 일봉 없음 — 먼저 node server/backtest/fetch-coins-long.js');
  const Uv = U.loadUniverse(dir);
  if (Uv.missing) return log('주식 데이터 없음 — 서버에서 node server/backtest/fetch-tradfi.js 먼저');
  // 시작: --from(기본 2016-11-01)과 두 코인의 200일선이 생긴 날 중 늦은 날
  const want = Date.parse(`${arg('--from', '2016-11-01')}T00:00:00Z`);
  const coinReady = Math.max(...coins.map((c) => (c.bars[200] ? c.bars[200].t : Infinity)));
  const startT = Math.max(want, coinReady);
  const stocks = Uv.stocks.filter((s) => s.bars.length > 200 && s.bars[200].t <= startT);
  if (stocks.length < 3) return log(`기간 시작 전에 200일선이 생긴 주식이 ${stocks.length}개뿐 — 3개 이상 필요`);
  // 끝: 코인 마지막 날과 주식 마지막 날 중 이른 날(주식 파일이 오래됐으면 그날까지 — 새로 받으려면 fetch-tradfi.js)
  const stockEnd = Math.max(...stocks.map((s) => s.bars[s.bars.length - 1].t));
  const endT = Math.min(...coins.map((c) => c.bars[c.bars.length - 1].t), stockEnd);
  if (!Number.isFinite(startT) || startT >= endT) return log('코인 기록이 모자람');
  const d0 = Math.floor(startT / DAY);
  const n = Math.floor(endT / DAY) - d0 + 1;
  const short = Uv.stocks.length - stocks.length;
  log(`다시 시작 판 × 최근 약 10년 × 모든 경우의 수 — BTC·ETH(현물 USD) + 주식 ${stocks.length}개 중 3개(기간 시작 전에 200일선이 생긴 것 · 늦게 시작해 뺀 것 ${short + Uv.short.length}개)`);
  log(`코인 기록: ${coins.map((c) => `${c.name} ${dayStr(Math.floor(c.bars[0].t / DAY))}~`).join(' · ')} · 같은 규칙(50·200 · −10% · +30% · 선 아래 마감 정리) · 비용 한쪽 0.07% · 펀딩·세금·환율 없음`);
  const coinRuns = coins.map((c) => X.simulateExits(c.bars, { ...LONG }));
  const coinG = coinRuns.map((r) => toGrid(r.days, d0, n));
  const names = stocks.map((s) => s.name);
  const stockG = stocks.map((s) => toGrid(X.simulateExits(s.bars, { ...LONG }).days, d0, n));
  // 참고: 코인 하나에 다 넣었을 때 해마다(2017 상승 · 2018 하락이 이번에 처음 들어간다)
  coins.forEach((c, i) => {
    const r = T.summarizeTrend(coinRuns[i].days, { from: startT });
    const h = T.summarizeTrend(U.holdDays(c.bars), { from: startT });
    if (r && h) log(`  참고 ${c.name} 규칙(한 종목에 다): 연 ${r.cagrPct}% · 최대 손실 −${r.maxDrawdownPct}% · 연도별 ${Object.entries(r.byYear).map(([y, v]) => `${y} ${v}%`).join(' · ')} | 그냥 들고 있기 연 ${h.cagrPct}% · −${h.maxDrawdownPct}%`);
  });
  for (const w of [0.2, 0.15]) {
    const t0 = Date.now();
    const res = runAll({ coinG, stockG, names, w, d0, n, onProgress: (p) => process.stderr.write(`  칸 ${w * 100}% 계산 ${p}%\r`) });
    process.stderr.write('\n');
    report(res, { w, d0, n, names, log });
    log(`  (계산 ${Math.round((Date.now() - t0) / 1000)}초)`);
  }
  log('\n주의: 주식 목록은 바이낸스가 이미 오른 종목을 골라 상장한 것(망한 회사 없음) — 실제 최악은 이보다 나쁠 수 있다. 같은 날 손절·익절 둘 다면 손절로 봤다. 코인은 09:00 실행 기준.');
  if (!process.env.NODE_TEST_CONTEXT) {
    const rdir = path.join(dir, '..', 'results');
    fs.mkdirSync(rdir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(rdir, `ten-year-${stamp}.md`), '```\n' + out.join('\n') + '\n```\n');
  }
}

if (require.main === module) main();

module.exports = { toGrid, quantiles, Hist, equityStats, yearRanges, runAll, loadLongCoins, HORIZONS };

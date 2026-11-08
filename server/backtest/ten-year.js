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
//   --big(2026-11-01, docs/07 '큰 회사에서 고르기'): 기간 시작 전 120 거래일 평균 거래대금 상위 20·30·50 과 전체를 칸 20% 로 나란히
//   --no-coin(2026-11-01 오너 '코인이 대상승 안 해도 24% 먹어?'): 코인 두 칸을 현금(0%)으로 — 코인이 아무것도 못 벌 때 주식 몫만 · --big 과 같이
//   --stock-rules(2026-11-01 오너 '주식의 규칙만 바꾸는 건?'): 코인 규칙은 그대로, 주식 칸만 S0 지금 · S1 익절 없음 · S2 200일선만(손절 −25%) — docs/07
//   --stock-grid(2026-11-01 오너 '후보 더 만들어 최선의 결과가 나올 때까지'): 주식 칸 규칙 24개(들어가기 2 · 나오기 3 · 손절 3 · 익절 2)를 한 번에 —
//      고르는 법은 결과 전에 docs/07 에(앞·뒤 기간 × 상위 30·50 의 가장 나쁜 값으로 고르고, 이웃 손절도 나아야 하고, 1%p 넘게 나아야 바꾼다)
//   --combo SPY,MSFT,NVDA SPY,QQQ,MSFT(2026-11-08 오너 '데이터로 비교해 봐'): 고른 3종목 조합끼리 — 지금 규칙(주식 두 선 위 → 200일선 아래 · −25%)으로 코인과 함께/현금
//   --now: 지금(최근 120 거래일) 거래대금 순위 — 대표님이 주식 3개를 고를 목록(docs/08 '큰 회사에서 고르기')
//   node server/backtest/ten-year.js [--from 2016-11-01] [--dir reports/backtest/data] [--big | --now | --stock-rules | --stock-grid | --combo A,B,C ...] [--no-coin]

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
function runAll({ coinG, stockG, names, w, d0, n, onProgress, hist = true }) {
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
    if (hist) HORIZONS.forEach(([, h], j) => {
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

// 그때 알 수 있던 '큰 회사' — beforeT 전 len 거래일의 평균 거래대금(종가 × 거래량)
function dollarVolume(bars, beforeT, len = 120) {
  const xs = bars.filter((b) => b.t < beforeT).slice(-len);
  if (xs.length < Math.min(60, len)) return null;
  return xs.reduce((a, b) => a + b.c * b.v, 0) / xs.length;
}

// 묶음 하나를 한 줄로 — 실패 쪽 끝(최악·1%·10%)이 보이게
function compact(res) {
  const c = quantiles(res.cagr);
  const d = quantiles(res.dd);
  const y = quantiles(res.worstYear);
  const m = quantiles(res.multiple);
  const [H1, H3] = res.hist;
  return {
    cagrLow: [c[0], c[1], c[3]], cagrMid: c[5], cagrHigh: c[7], cagrBest: c[10],
    ddMid: d[5], dd10: d[7], ddWorst: d[10],
    wyMid: y[5], wy10: y[3], wyWorst: y[0],
    mult10: m[3], multMid: m[5],
    neg1: H1.n ? H1.neg / H1.n : null, worst1: H1.n ? H1.min.v : null, neg3: H3.n ? H3.neg / H3.n : null,
  };
}

function compactLine(label, total, k) {
  return `  ${label}(${total.toLocaleString()}가지): 1년 평균 최악 ${pc(k.cagrLow[0])}% · 1% ${pc(k.cagrLow[1])}% · 10% ${pc(k.cagrLow[2])}% · 중간 ${pc(k.cagrMid)}% · 90% ${pc(k.cagrHigh)}% · 최고 ${pc(k.cagrBest)}% | 1,000만 원 → 10% ${Math.round(k.mult10 * 1000).toLocaleString()}만 · 중간 ${Math.round(k.multMid * 1000).toLocaleString()}만 | 최대 손실 최악 −${pc(k.ddWorst)}% · 10% −${pc(k.dd10)}% · 중간 −${pc(k.ddMid)}% | 최악의 해 최악 ${pc(k.wyWorst)}% · 10% ${pc(k.wy10)}% · 중간 ${pc(k.wyMid)}% | 1년 뒤 마이너스 ${p1(k.neg1 * 100)}% · 1년 뒤 최악 ${p1(k.worst1)}% · 3년 뒤 마이너스 ${p1(k.neg3 * 100)}%`;
}

// --big: 거래대금 상위 묶음 vs 전체(칸 20%) — 채택 기준은 docs/07
function bigCompanies({ stocks, stockG, coinG, startT, d0, n, log }) {
  const ranked = stocks.map((s, i) => ({ i, name: s.name, dv: dollarVolume(s.bars, startT) })).filter((x) => x.dv != null).sort((a, b) => b.dv - a.dv);
  log(`\n■ 큰 회사에서 고르기 — ${dayStr(d0)} 전 120 거래일 평균 거래대금 순위(그때 알 수 있던 것만) · 칸 20%`);
  log(`  순위: ${ranked.slice(0, 50).map((x, k) => `${k + 1}.${x.name}`).join(' ')}`);
  if (ranked.length > 50) log(`  51위~: ${ranked.slice(50).map((x) => x.name).join(' ')}`);
  const groups = [['상위 20', 20], ['상위 30', 30], ['상위 50', 50], [`전체 ${ranked.length}`, ranked.length]];
  const got = {};
  for (const [label, k] of groups) {
    const pick = ranked.slice(0, Math.min(k, ranked.length));
    if (pick.length < 3) continue;
    const t0 = Date.now();
    const res = runAll({ coinG, stockG: pick.map((x) => stockG[x.i]), names: pick.map((x) => x.name), w: 0.2, d0, n, onProgress: (p) => process.stderr.write(`  ${label} 계산 ${p}%\r`) });
    process.stderr.write('\n');
    got[label] = compact(res);
    log(compactLine(label, res.total, got[label]));
    log(`     가장 안된 3: ${res.worst.slice(0, 3).map((x) => `${x.names.join('·')} 연 ${pc(x.cagr)}% / −${pc(x.dd)}%`).join(' | ')} · 가장 잘된 3: ${res.best.slice(0, 3).map((x) => `${x.names.join('·')} 연 ${pc(x.cagr)}%`).join(' | ')} (${Math.round((Date.now() - t0) / 1000)}초)`);
  }
  const all = got[`전체 ${ranked.length}`];
  const better = (g) => g && all && g.cagrLow.every((v, j) => v > all.cagrLow[j]) && g.dd10 < all.dd10;
  const verdict = ['상위 30', '상위 20', '상위 50'].map((l) => `${l} ${better(got[l]) ? '나음' : '아님'}`);
  const pass = better(got['상위 30']) && better(got['상위 20']) && better(got['상위 50']);
  log(`  판정(docs/07 — 최악·1%·10% 연% 모두 높고 나쁜 쪽 10% 최대 손실이 작음): ${verdict.join(' · ')} → ${pass ? "채택 — '주식은 큰 회사(거래대금 상위)에서 고른다'" : "근거 부족 — '큰 회사' 문구를 되돌린다"}`);
  return { ranked, got, pass };
}

// --now: 지금 거래대금 순위(바이낸스 상장 미국 주식·ETF 확인된 것 전부, 최근 120 거래일)
function rankNow(dir, log, top = 50) {
  const metaPath = path.join(dir, 'tradfi', 'meta.json');
  if (!fs.existsSync(metaPath)) return log('주식 데이터 없음 — 서버에서 node server/backtest/fetch-tradfi.js 먼저');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const rows = [];
  let last = 0;
  for (const m of (meta.symbols || []).filter((x) => x.ok && x.yahoo)) {
    const p = path.join(dir, 'tradfi', `${m.yahoo}-1d.csv`);
    if (!fs.existsSync(p)) continue;
    const bars = E.parseCandleCsv(fs.readFileSync(p, 'utf8'));
    const dv = dollarVolume(bars, Infinity, 120);
    if (dv == null) continue;
    last = Math.max(last, bars[bars.length - 1].t);
    rows.push({ name: m.yahoo, type: String(m.type || '').toUpperCase(), full: String(m.name || '').slice(0, 28), dv });
  }
  rows.sort((a, b) => b.dv - a.dv);
  log(`지금 거래대금 순위 — 바이낸스 상장 미국 주식·ETF ${rows.length}개 · 최근 120 거래일 평균(주가 × 거래량) · 자료 끝 ${last ? dayStr(Math.floor(last / DAY)) : '-'}(새로 받기: node server/backtest/fetch-tradfi.js)`);
  log('대표님은 상위 30 안에서 3개(docs/08) — 업종이 겹치지 않게(반도체는 많아야 1개, 나누기는 SPY 로) · 최근 급등으로 들어온 곳보다 오래 큰 회사로. 레버리지·인버스 ETF는 이미 빠져 있다. 원자재처럼 움직이는 것(금광 GDX 등)도 뺀다.');
  rows.slice(0, top).forEach((r, k) => log(`  ${String(k + 1).padStart(2)}. ${r.name}${r.type === 'ETF' ? '(ETF)' : ''} ${r.full} · 하루 ${Math.round(r.dv / 1e6).toLocaleString()}백만 달러${k === 29 ? '\n  ── 여기까지 상위 30 ──' : ''}${k === 49 ? '\n  ── 여기까지 상위 50 ──' : ''}`));
  return rows;
}

const STOCK_RULES = Object.freeze([
  ['S0 지금 규칙(−10% · +30% · 두 선)', { ...LONG }],
  ['S1 익절 없음(−10% · 두 선)', { ...LONG, tp: 0 }],
  ['S2 200일선만(손절 −25% · 익절 없음)', { mode: 'long', stop: { k: 'pct', v: 25 }, tp: 0, trail: 'none', signalExit: true, holdDays: 0, fast: 200, slow: 200 }],
]);

// 조합마다 앞·뒤 기간 연%(연도별 수익을 곱해서) — splitYear 앞까지 / 그 해부터
function halvesMedian(res, d0, n, splitYear = 2022) {
  const yr = yearRanges(d0, n);
  const span = (pred) => yr.filter((y) => pred(y.y)).reduce((a, y) => a + (y.e - y.s + 1), 0);
  const s1 = span((y) => y < splitYear);
  const s2 = span((y) => y >= splitYear);
  const a = new Float64Array(res.total);
  const b = new Float64Array(res.total);
  for (let i = 0; i < res.total; i++) {
    let m1 = 1;
    let m2 = 1;
    res.years.forEach((y, j) => { if (y < splitYear) m1 *= 1 + res.yearly[j][i]; else m2 *= 1 + res.yearly[j][i]; });
    a[i] = Math.pow(m1, 365.25 / s1) - 1;
    b[i] = Math.pow(m2, 365.25 / s2) - 1;
  }
  return [quantiles(a)[5], quantiles(b)[5]];
}

// --stock-rules: 주식 칸 규칙만 바꿔 상위 30·50 × 코인 함께/현금 — 채택 기준은 docs/07
function stockRules({ stocks, coinG, startT, d0, n, log }) {
  const ranked = stocks.map((s) => ({ s, dv: dollarVolume(s.bars, startT) })).filter((x) => x.dv != null).sort((a, b) => b.dv - a.dv);
  const zero = coinG.map(() => new Float64Array(n));
  const variants = [...STOCK_RULES.map(([label, o]) => [label, (bars) => X.simulateExits(bars, o).days]), ['참고 H 그냥 들고 있기(손절 없음)', (bars) => U.holdDays(bars)]];
  const R = {};
  log(`\n■ 주식 규칙만 바꾸기 — 코인 규칙 그대로 · 2016 거래대금 상위 30·50 · 칸 20% · ${dayStr(d0)} ~ ${dayStr(d0 + n - 1)}`);
  for (const top of [30, 50]) {
    const pick = ranked.slice(0, Math.min(top, ranked.length));
    if (pick.length < 3) continue;
    log(`  [상위 ${top}]`);
    for (const [label, sim] of variants) {
      const grids = pick.map((x) => toGrid(sim(x.s.bars), d0, n));
      const names = pick.map((x) => x.s.name);
      const withCoin = runAll({ coinG, stockG: grids, names, w: 0.2, d0, n });
      const noCoin = runAll({ coinG: zero, stockG: grids, names, w: 0.2, d0, n });
      const k = { withCoin: compact(withCoin), noCoin: compact(noCoin), halves: halvesMedian(noCoin, d0, n) };
      R[`${top}|${label}`] = k;
      log(compactLine(`${label} · 코인이 못 벌 때`, noCoin.total, k.noCoin));
      log(`       코인이 못 벌 때 중간 연% 앞(~2021) ${pc(k.halves[0])}% · 뒤(2022~) ${pc(k.halves[1])}%`);
      log(compactLine(`${label} · 코인과 함께`, withCoin.total, k.withCoin));
    }
  }
  const base = (top) => R[`${top}|${STOCK_RULES[0][0]}`];
  const verdicts = STOCK_RULES.slice(1).map(([label]) => {
    const why = [];
    for (const top of [30, 50]) {
      const c = R[`${top}|${label}`];
      const b0 = base(top);
      if (!c || !b0) continue;
      if (!(c.noCoin.cagrMid > b0.noCoin.cagrMid && c.noCoin.cagrLow[2] > b0.noCoin.cagrLow[2])) why.push(`상위 ${top} 코인 없이 중간 ${pc(c.noCoin.cagrMid)} vs ${pc(b0.noCoin.cagrMid)} · 10% ${pc(c.noCoin.cagrLow[2])} vs ${pc(b0.noCoin.cagrLow[2])}`);
    }
    const c30 = R[`30|${label}`];
    const b30 = base(30);
    if (c30 && b30) {
      if (!(c30.withCoin.wyMid >= b30.withCoin.wyMid - 0.03 && c30.withCoin.ddMid <= b30.withCoin.ddMid + 0.05)) why.push(`코인과 함께 최악의 해 ${pc(c30.withCoin.wyMid)} vs ${pc(b30.withCoin.wyMid)} · 최대 손실 −${pc(c30.withCoin.ddMid)} vs −${pc(b30.withCoin.ddMid)}`);
      if (!(c30.halves[0] > b30.halves[0] && c30.halves[1] > b30.halves[1])) why.push(`앞·뒤 기간 ${pc(c30.halves[0])}/${pc(c30.halves[1])} vs ${pc(b30.halves[0])}/${pc(b30.halves[1])}`);
    }
    log(`  판정 ${label}: ${why.length ? `탈락 — ${why.join(' / ')}` : '통과'}`);
    return { label, ok: !why.length, mid: c30 ? c30.noCoin.cagrMid : -Infinity };
  });
  const pass = verdicts.filter((v) => v.ok).sort((a, b) => b.mid - a.mid);
  log(`  → 주식 칸 규칙: ${pass.length ? pass[0].label : `${STOCK_RULES[0][0]} 그대로(통과한 후보 없음)`}`);
  return { R, pass };
}

// 주식 칸 규칙 격자(docs/07 '주식 규칙 격자'): 들어가기(두 선 위 · 200일선 위) × 나오기(선 하나 · 200일선 · 두 선 모두) × 손절 10·15·25% × 익절 +30% · 없음
function gridVariants() {
  const out = [];
  const signals = [['두 선 위→선 하나 아래', { exitOn: 'either' }], ['두 선 위→200일선 아래', { exitOn: 'slow' }], ['두 선 위→두 선 모두 아래', { exitOn: 'both' }], ['200일선 위→아래', { fast: 200, slow: 200 }]];
  for (const [sl, so] of signals) for (const stop of [10, 15, 25]) for (const tp of [30, 0]) {
    out.push({ key: `${sl}|${stop}|${tp}`, label: `${sl} · 손절 −${stop}% · ${tp ? `익절 +${tp}%` : '익절 없음'}`, signal: sl, stop, tp, o: { mode: 'long', stop: { k: 'pct', v: stop }, tp: tp ? tp / stop : 0, trail: 'none', signalExit: true, holdDays: 0, ...so } });
  }
  return out;
}

// --stock-grid: 24개를 한 번에 → 가장 나쁜 값(앞·뒤 × 상위 30·50)으로 고르기
function stockGrid({ stocks, coinG, startT, d0, n, log }) {
  const ranked = stocks.map((s) => ({ s, dv: dollarVolume(s.bars, startT) })).filter((x) => x.dv != null).sort((a, b) => b.dv - a.dv);
  const pick50 = ranked.slice(0, Math.min(50, ranked.length));
  const zero = coinG.map(() => new Float64Array(n));
  const V = gridVariants();
  log(`\n■ 주식 규칙 격자 — ${V.length}개 · 코인 규칙 그대로 · 2016 거래대금 상위 30·50 · 칸 20% · ${dayStr(d0)} ~ ${dayStr(d0 + n - 1)}`);
  log('  표기: 고르는 값(코인이 못 벌 때 중간 연% 의 앞·뒤 × 상위 30·50 중 가장 나쁜 값) | 코인 없이 상위 30 중간 · 10% · 앞/뒤 | 코인과 함께 상위 30 중간 연% · 최대 손실 · 최악의 해');
  const rows = [];
  V.forEach((v, vi) => {
    const grids = pick50.map((x) => toGrid(X.simulateExits(x.s.bars, v.o).days, d0, n));
    const names = pick50.map((x) => x.s.name);
    const m = {};
    for (const top of [30, 50]) {
      const g = grids.slice(0, Math.min(top, grids.length));
      const nm = names.slice(0, g.length);
      const nc = runAll({ coinG: zero, stockG: g, names: nm, w: 0.2, d0, n, hist: false });
      const wc = top === 30 ? runAll({ coinG, stockG: g, names: nm, w: 0.2, d0, n, hist: false }) : null;
      m[top] = { nc: compact(nc), halves: halvesMedian(nc, d0, n), wc: wc ? compact(wc) : null };
    }
    const score = Math.min(m[30].halves[0], m[30].halves[1], m[50].halves[0], m[50].halves[1]);
    rows.push({ v, m, score });
    process.stderr.write(`  격자 ${vi + 1}/${V.length}\r`);
  });
  process.stderr.write('\n');
  const base = rows.find((r) => r.v.key === '두 선 위→선 하나 아래|10|30');
  const guard = (r) => r.m[30].wc.wyMid >= base.m[30].wc.wyMid - 0.03 && r.m[30].wc.ddMid <= base.m[30].wc.ddMid + 0.05;
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  for (const r of sorted) {
    const a = r.m[30];
    log(`  ${r.v.key === base.v.key ? '★' : ' '} ${r.v.label}: ${pc(r.score)}% | 코인 없이 ${pc(a.nc.cagrMid)}% · ${pc(a.nc.cagrLow[2])}% · ${pc(a.halves[0])}/${pc(a.halves[1])}% | 코인과 함께 ${pc(a.wc.cagrMid)}% · −${pc(a.wc.ddMid)}% · ${pc(a.wc.wyMid)}%${guard(r) ? '' : ' · 손실 기준 밖'}`);
  }
  // 이웃: 같은 들어가기·나오기·익절에서 손절 한 칸 위·아래도 기준보다 나아야(한 점만 좋은 건 우연)
  const stops = [10, 15, 25];
  const byKey = new Map(rows.map((r) => [r.v.key, r]));
  const neighborsOk = (r) => {
    const i = stops.indexOf(r.v.stop);
    return [stops[i - 1], stops[i + 1]].filter((x) => x != null).every((st) => { const nb = byKey.get(`${r.v.signal}|${st}|${r.v.tp}`); return nb && nb.score > base.score; });
  };
  const winner = sorted.find((r) => r !== base && guard(r) && neighborsOk(r) && r.score >= base.score + 0.01);
  log(`  기준(★ 지금 규칙) 고르는 값 ${pc(base.score)}% · 바꾸려면 손실 기준 안 · 이웃 손절도 기준보다 나음 · 1%p 넘게 나음`);
  log(`  → 주식 칸 규칙: ${winner ? `${winner.v.label}(고르는 값 ${pc(winner.score)}%)` : '지금 규칙 그대로(조건을 다 넘은 후보 없음)'}`);
  // 고른 것과 지금 규칙을 자세히(1·3년 뒤 마이너스 포함)
  for (const r of [base, winner].filter(Boolean)) {
    const g = pick50.slice(0, 30).map((x) => toGrid(X.simulateExits(x.s.bars, r.v.o).days, d0, n));
    const nm = pick50.slice(0, 30).map((x) => x.s.name);
    log(compactLine(`${r.v.label} · 코인과 함께(상위 30)`, (g.length * (g.length - 1) * (g.length - 2)) / 6, compact(runAll({ coinG, stockG: g, names: nm, w: 0.2, d0, n }))));
    log(compactLine(`${r.v.label} · 코인이 못 벌 때(상위 30)`, (g.length * (g.length - 1) * (g.length - 2)) / 6, compact(runAll({ coinG: zero, stockG: g, names: nm, w: 0.2, d0, n }))));
  }
  log(`  주의: 후보 ${V.length}개 중 고른 값이라 실제는 이보다 못할 수 있다(여럿 중 가장 좋은 것은 운이 섞인다) — 앞으로의 가격(가상 장부)으로 다시 본다.`);
  return { rows, base, winner };
}

// 대표님이 쓰는 주식 칸 규칙(docs/08, 2026-11-01): 두 선 위에서 사고 200일선 아래 마감이면 정리 · 손절 −25% · 익절 없음
const CHOSEN_STOCK = Object.freeze({ mode: 'long', stop: { k: 'pct', v: 25 }, tp: 0, trail: 'none', signalExit: true, holdDays: 0, exitOn: 'slow' });

// 종목끼리 하루 움직임이 얼마나 같이 가나 — 같은 날 종가 수익률의 상관계수 평균(1 이면 똑같이, 0 이면 상관없이)
function avgCorrelation(barsList, from) {
  const maps = barsList.map((bars) => {
    const m = new Map();
    for (let i = 1; i < bars.length; i++) if (bars[i].t >= from) m.set(Math.floor(bars[i].t / DAY), bars[i].c / bars[i - 1].c - 1);
    return m;
  });
  const cs = [];
  for (let i = 0; i < maps.length; i++) for (let j = i + 1; j < maps.length; j++) {
    const xs = [];
    const ys = [];
    for (const [k, v] of maps[i]) if (maps[j].has(k)) { xs.push(v); ys.push(maps[j].get(k)); }
    if (xs.length < 30) continue;
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let k = 0; k < xs.length; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; syy += (ys[k] - my) ** 2; }
    if (sxx > 0 && syy > 0) cs.push(sxy / Math.sqrt(sxx * syy));
  }
  return cs.length ? cs.reduce((a, b) => a + b, 0) / cs.length : null;
}

// --combo: 고른 조합끼리 같은 10년 · 모든 시작한 날
function compareCombos({ stocks, coinG, startT, d0, n, combos, log }) {
  const byName = new Map(stocks.map((s) => [s.name, s]));
  const zero = coinG.map(() => new Float64Array(n));
  log(`\n■ 조합 비교 — ${dayStr(d0)} ~ ${dayStr(d0 + n - 1)} · 칸 20% · 코인 두 선(−10% · +30%) + 주식 두 선 위 → 200일선 아래(−25% · 익절 없음)`);
  log('  ※ 지난 10년의 결과다 — NVDA 처럼 이 기간에 크게 오른 종목은 숫자가 부풀려져 보인다. 앞으로를 보려면 수익보다 최대 손실 · 최악의 해 · 1년 뒤 마이너스(흔들림)를 본다.');
  for (const combo of combos) {
    const picks = combo.map((nm) => byName.get(nm));
    if (picks.some((x) => !x) || picks.length !== 3) {
      log(`  ${combo.join('·')}: 데이터 없음(${combo.filter((nm) => !byName.has(nm)).join(' · ') || '3종목이 아님'})`);
      continue;
    }
    const runs = picks.map((x) => X.simulateExits(x.bars, CHOSEN_STOCK));
    const grids = runs.map((r) => toGrid(r.days, d0, n));
    log(`  [${combo.join(' · ')}]`);
    for (const [label, cg] of [['코인과 함께', coinG], ['코인이 못 벌 때', zero]]) {
      const res = runAll({ coinG: cg, stockG: grids, names: combo, w: 0.2, d0, n });
      const [H1, H3, H5] = res.hist;
      const pctH = (H) => (H.n ? `${p1((H.neg / H.n) * 100)}% · 최악 ${p1(H.min.v)}%` : '-');
      log(`    ${label}: 1년 평균 ${pc(res.cagr[0])}% · 1,000만 원 → ${Math.round(res.multiple[0] * 1000).toLocaleString()}만 · 최대 손실 −${pc(res.dd[0])}% · 최악의 해 ${pc(res.worstYear[0])}% · 마이너스 해 ${res.negYears[0]}/${res.years.length} · 다시 고점까지 최장 ${res.under[0]}일 | 1년 뒤 마이너스 ${pctH(H1)} · 3년 뒤 마이너스 ${pctH(H3)} · 5년 뒤 마이너스 ${pctH(H5)}`);
      log(`       연도별 ${res.years.map((y, j) => `${y} ${pc(res.yearly[j][0])}%`).join(' · ')}`);
    }
    const per = picks.map((x, i) => {
      const a = T.summarizeTrend(runs[i].days, { from: startT });
      const h = T.summarizeTrend(U.holdDays(x.bars), { from: startT });
      const tr = runs[i].trades.filter((t) => t.entryT >= startT);
      const win = tr.length ? Math.round((tr.filter((t) => t.pct > 0).length / tr.length) * 100) : null;
      return `${x.name} 규칙 ${a ? `${a.cagrPct}% / −${a.maxDrawdownPct}%` : '-'} · ${tr.length}번 · 이긴 비율 ${win ?? '-'}% (그냥 들고 있기 ${h ? `${h.cagrPct}% / −${h.maxDrawdownPct}%` : '-'})`;
    });
    log(`    종목 하나에 다 넣었을 때(1년 평균 / 최대 손실): ${per.join(' | ')}`);
    const corr = avgCorrelation(picks.map((x) => x.bars), startT);
    log(`    세 종목이 같이 움직이는 정도(하루 수익 상관 평균, 1 = 똑같이): ${corr == null ? '-' : Math.round(corr * 100) / 100}`);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : d);
  const dir = path.resolve(arg('--dir', path.join(__dirname, '..', '..', 'reports', 'backtest', 'data')));
  const out = [];
  const log = (s = '') => { console.log(s); out.push(s); };
  if (argv.includes('--now')) return rankNow(dir, log);
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
  const noCoin = argv.includes('--no-coin');
  const coinG = coinRuns.map((r) => (noCoin ? new Float64Array(n) : toGrid(r.days, d0, n)));
  if (noCoin) log('  ※ --no-coin: 코인 두 칸은 현금(0%)으로 둔다 — 코인이 아무것도 못 벌 때(대상승 없음) 주식 세 칸만의 몫');
  const names = stocks.map((s) => s.name);
  const stockG = stocks.map((s) => toGrid(X.simulateExits(s.bars, { ...LONG }).days, d0, n));
  // 참고: 코인 하나에 다 넣었을 때 해마다(2017 상승 · 2018 하락이 이번에 처음 들어간다)
  coins.forEach((c, i) => {
    const r = T.summarizeTrend(coinRuns[i].days, { from: startT });
    const h = T.summarizeTrend(U.holdDays(c.bars), { from: startT });
    if (r && h) log(`  참고 ${c.name} 규칙(한 종목에 다): 연 ${r.cagrPct}% · 최대 손실 −${r.maxDrawdownPct}% · 연도별 ${Object.entries(r.byYear).map(([y, v]) => `${y} ${v}%`).join(' · ')} | 그냥 들고 있기 연 ${h.cagrPct}% · −${h.maxDrawdownPct}%`);
  });
  const ci = argv.indexOf('--combo');
  if (ci >= 0) {
    const combos = argv.slice(ci + 1).filter((x) => !x.startsWith('--')).map((x) => x.split(',').map((y) => y.trim().toUpperCase()).filter(Boolean));
    compareCombos({ stocks, coinG, startT, d0, n, combos, log });
  } else if (argv.includes('--stock-grid')) {
    stockGrid({ stocks, coinG, startT, d0, n, log });
  } else if (argv.includes('--stock-rules')) {
    stockRules({ stocks, coinG, startT, d0, n, log });
  } else if (argv.includes('--big')) {
    bigCompanies({ stocks, stockG, coinG, startT, d0, n, log });
  } else for (const w of [0.2, 0.15]) {
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

module.exports = { toGrid, quantiles, Hist, equityStats, yearRanges, runAll, loadLongCoins, dollarVolume, compact, bigCompanies, rankNow, stockRules, halvesMedian, STOCK_RULES, gridVariants, stockGrid, compareCombos, avgCorrelation, CHOSEN_STOCK, HORIZONS };

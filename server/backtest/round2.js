'use strict';

// round2.js — 2차 탐색(docs/07-RESEARCH-PROTOCOL.md "2차", 2026-10-15): 손실 크기 대신 '복구'를 기준으로 월 3% 를 찾는다.
//   통과 = 만들기(2020~23)·시험(2024~) 두 구간 모두 월 3%(연 42.6%) 이상 · 가장 길게 물린 기간 ≤ 365일 · 최대 손실 ≤ 60% · 1배.
//   I 롱·숏 추세추종 · J 물타기(손절 없음) · K 그리드(손절 없음) · M 공격형 추세추종 · O 레버리지(참고만, 운용 불가)
//   L 바이낸스 미국 주식 + BTC·ETH 순환·전부 추세추종 — 서버에서 fetch-tradfi.js 로 받은 데이터가 있을 때만.
//   비교 기준: 그냥 들고 있기(BTC·ETH 반반). 비용: 시장가 한쪽 0.1%, 지정가 0.05%, 실제 펀딩(롱이 낸다, 숏이 받는다).
//   node server/backtest/round2.js
//   node server/backtest/fetch-tradfi.js && node server/backtest/round2.js     # 서버 — L 까지

const fs = require('fs');
const path = require('path');
const E = require('./engine');
const T = require('./trend');
const { parseFundingCsv } = require('./carry');
const { alignToCalendar, buildAssets, syntheticFunding } = require('./mix-trend');
const { simulateRotation } = require('./rotation');

const DATA = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data');
const OUT_DIR = path.join(DATA, '..', 'results');
const DAY = 86400000;
const Q = 15 * 60000;
const IS_END = Date.parse('2024-01-01T00:00:00Z');
const GOAL_MONTHLY = 3;

// 가장 길게 물린 기간(고점 → 다시 그 고점, 일) · 끝날 때 아직 물려 있는 기간
function underwater(days) {
  let eq = 1;
  let peak = 1;
  let peakT = days.length ? days[0].t : 0;
  let max = 0;
  for (const d of days) {
    eq *= 1 + d.ret;
    if (eq >= peak) {
      max = Math.max(max, (d.t - peakT) / DAY);
      peak = eq;
      peakT = d.t;
    }
  }
  const last = days.length ? days[days.length - 1].t : peakT;
  const nowDays = eq < peak ? (last - peakT) / DAY : 0;
  return { maxDays: Math.round(Math.max(max, nowDays)), nowDays: Math.round(nowDays) };
}

const monthlyOf = (cagrPct) => (cagrPct == null ? null : Math.round((Math.pow(1 + cagrPct / 100, 1 / 12) - 1) * 10000) / 100);

function evaluate(name, family, days) {
  const all = T.summarizeTrend(days);
  const is = T.summarizeTrend(days, { to: IS_END - 1 });
  const oos = T.summarizeTrend(days, { from: IS_END });
  if (!all || !is || !oos) return null;
  const uw = underwater(days);
  const r = {
    name,
    family,
    cagr: all.cagrPct,
    dd: all.maxDrawdownPct,
    uwDays: uw.maxDays,
    nowDays: uw.nowDays,
    mAll: monthlyOf(all.cagrPct),
    mIs: monthlyOf(is.cagrPct),
    mOos: monthlyOf(oos.cagrPct),
    worstYear: Math.min(...Object.values(all.byYear)),
  };
  r.pass = r.mIs >= GOAL_MONTHLY && r.mOos >= GOAL_MONTHLY && r.uwDays <= 365 && r.dd <= 60;
  return r;
}

// 날짜별 순자산(Map: UTC 날짜 → 순자산) 두 개를 반반 섞어(처음에 반씩 넣고 그대로) 하루 수익률로
function combineEquity(maps, weights) {
  const keys = [...maps[0].keys()].filter((k) => maps.every((m) => m.has(k))).sort((a, b) => a - b);
  const days = [];
  let prev = null;
  for (const k of keys) {
    const eq = maps.reduce((s, m, i) => s + weights[i] * m.get(k), 0);
    if (prev != null) days.push({ t: k, ret: eq / prev - 1 });
    prev = eq;
  }
  return days;
}

// 펀딩 기록 → Map(15분 칸 시작 → 비율), Map(UTC 날짜 → 그날 합)
function fundingMaps(list) {
  const at = new Map();
  const day = new Map();
  for (const f of list) {
    at.set(Math.floor(f.t / Q) * Q, (at.get(Math.floor(f.t / Q) * Q) || 0) + f.rate);
    const k = Math.floor(f.t / DAY) * DAY;
    day.set(k, (day.get(k) || 0) + f.rate);
  }
  return { at, day };
}

// J 물타기: 바퀴마다 순자산을 n 몫(같은 몫 또는 1·2·4·8… 두 배씩)으로 나눠 첫 몫은 시가에 산다.
// 마지막으로 산 값에서 stepPct% 떨어질 때마다 한 몫 더(지정가). 평균가 + tpPct% 에서 전부 판다(지정가). 손절 없음.
// 같은 15분 칸에서 사고 바로 팔지는 않는다(보수적). 1배: 몫을 다 써도 노출 ≤ 순자산.
function simulateDca(bars, fundAt, { stepPct = 10, tpPct = 5, n = 5, doubling = false, taker = 0.001, maker = 0.0005 } = {}) {
  let cash = 1;
  let qty = 0;
  let avg = 0;
  let lastBuy = 0;
  let filled = 0;
  let sizes = [];
  let cycles = 0;
  const eqByDay = new Map();
  const buy = (usdt, px, fee) => {
    const q = usdt / px;
    cash -= usdt * (1 + fee);
    avg = (avg * qty + px * q) / (qty + q);
    qty += q;
  };
  for (const b of bars) {
    const f = fundAt.get(b.t);
    if (f && qty > 0) cash -= qty * b.o * f;
    let bought = false;
    if (qty === 0) {
      const eq = cash / (1 + taker);
      const unit = doubling ? eq / (2 ** n - 1) : eq / n;
      sizes = Array.from({ length: n }, (_, j) => (doubling ? unit * 2 ** j : unit));
      buy(sizes[0], b.o, taker);
      filled = 1;
      lastBuy = b.o;
      bought = true;
      cycles += 1;
    }
    while (filled < n && b.l <= lastBuy * (1 - stepPct / 100)) {
      const px = Math.min(b.o, lastBuy * (1 - stepPct / 100));
      buy(sizes[filled], px, maker);
      filled += 1;
      lastBuy = px;
      bought = true;
    }
    if (!bought && qty > 0 && b.h >= avg * (1 + tpPct / 100)) {
      const px = Math.max(b.o, avg * (1 + tpPct / 100));
      cash += qty * px * (1 - maker);
      qty = 0;
      avg = 0;
      filled = 0;
    }
    eqByDay.set(Math.floor(b.t / DAY) * DAY, cash + qty * b.c);
  }
  return { eqByDay, cycles };
}

// K 그리드: 맨 위(top)에서 spacingPct% 간격으로 아래로 levels 칸. 칸에 닿으면 (순자산/levels) 만큼 사고(지정가),
// 한 칸 위에서 판다(지정가). 재고가 없고 값이 맨 위 + 한 칸을 넘으면 맨 위를 끌어올린다(그때 순자산으로 몫을 다시 정함). 손절 없음.
function simulateGrid(bars, fundAt, { spacingPct = 2, levels = 20, maker = 0.0005 } = {}) {
  const s = spacingPct / 100;
  let cash = 1;
  let top = null;
  let unit = 0;
  let qty = 0;
  let fills = 0;
  const inv = new Array(levels).fill(0);
  const eqByDay = new Map();
  for (const b of bars) {
    const f = fundAt.get(b.t);
    if (f && qty > 0) cash -= qty * b.o * f;
    if (top == null || (qty === 0 && b.o > top * (1 + s))) {
      top = b.o;
      unit = cash / levels / (1 + maker);
    }
    const now = new Set();
    for (let i = 1; i <= levels; i++) {
      const L = top * Math.pow(1 - s, i);
      if (!inv[i - 1] && b.l <= L) {
        const px = Math.min(b.o, L);
        const q = unit / px;
        cash -= unit * (1 + maker);
        inv[i - 1] = q;
        qty += q;
        now.add(i);
        fills += 1;
      }
    }
    for (let i = 1; i <= levels; i++) {
      if (!inv[i - 1] || now.has(i)) continue;
      const S = top * Math.pow(1 - s, i - 1);
      if (b.h >= S) {
        cash += inv[i - 1] * Math.max(b.o, S) * (1 - maker);
        qty -= inv[i - 1];
        inv[i - 1] = 0;
      }
    }
    if (qty < 1e-12) qty = 0;
    eqByDay.set(Math.floor(b.t / DAY) * DAY, cash + qty * b.c);
  }
  return { eqByDay, fills };
}

// I 롱·숏 추세추종(일봉): 어제 종가까지로 비중을 정해 오늘 시가에 맞춘다. 펀딩: 롱이 내고 숏이 받는다.
//   mode 'ensemble' — 비중 = (평균선 위 개수 − 아래 개수)/5 → −100% ~ +100%
//   mode 'shortAllBelow' — 롱은 지금 규칙(위 개수/5), 다섯 개 모두 아래면 숏 100%
function simulateLongShort(daily, fundDay, { smaGrid = T.SMA_GRID, cost = 0.001, mode = 'ensemble' } = {}) {
  const closes = [];
  const days = [];
  let prevF = 0;
  for (let d = 0; d < daily.length; d++) {
    const b = daily[d];
    let f = 0;
    if (closes.length) {
      const last = closes[closes.length - 1];
      let above = 0;
      let below = 0;
      for (const L of smaGrid) {
        if (closes.length < L) continue;
        let sum = 0;
        for (let i = closes.length - L; i < closes.length; i++) sum += closes[i];
        if (last > sum / L) above += 1;
        else below += 1;
      }
      if (mode === 'ensemble') f = (above - below) / smaGrid.length;
      else f = above > 0 ? above / smaGrid.length : below === smaGrid.length ? -1 : 0;
    }
    const gap = d > 0 ? b.o / daily[d - 1].c - 1 : 0;
    const intraday = b.c / b.o - 1;
    const fund = fundDay.get(Math.floor(b.t / DAY) * DAY) || 0;
    const ret = (1 + prevF * gap) * (1 + f * intraday) - 1 - Math.abs(f - prevF) * cost - f * fund;
    days.push({ t: b.t, ret });
    prevF = f;
    closes.push(b.c);
  }
  return days;
}

function loadCoin(sym) {
  const read = (f) => fs.readFileSync(path.join(DATA, f), 'utf8');
  return {
    d1: E.parseCandleCsv(read(`${sym}-1d.csv`)),
    m15: fs.existsSync(path.join(DATA, `${sym}-15m.csv`)) ? E.parseCandleCsv(read(`${sym}-15m.csv`)) : null,
    funding: parseFundingCsv(read(`${sym}-funding.csv`)),
  };
}

// L: fetch-tradfi.js 가 받은 바이낸스 미국 주식(일봉 + 실측 펀딩)
function loadTradfi(calendar) {
  const dir = path.join(DATA, 'tradfi');
  const metaPath = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const out = [];
  for (const m of meta.symbols || []) {
    const p = path.join(dir, `${m.yahoo}-1d.csv`);
    if (!m.ok || !fs.existsSync(p)) continue;
    const rows = E.parseCandleCsv(fs.readFileSync(p, 'utf8'));
    out.push({ ...m, rows, d: alignToCalendar(calendar, rows), funding: syntheticFunding(calendar, m.fundingAnnualPct || 0) });
  }
  return out;
}

function main() {
  const out = [];
  const log = (s = '') => { console.log(s); out.push(s); };
  const btc = loadCoin('BTCUSDT');
  const eth = loadCoin('ETHUSDT');
  const calendar = btc.d1.map((b) => b.t);
  const fB = fundingMaps(btc.funding);
  const fE = fundingMaps(eth.funding);
  const ethD = alignToCalendar(calendar, eth.d1);
  const rows = [];
  const add = (r) => { if (r) rows.push(r); };

  // 비교 기준: 그냥 들고 있기(현물, 반반)
  const hold = (d) => { const first = d.find(Boolean).c; return new Map(d.filter(Boolean).map((b) => [b.t, b.c / first])); };
  add(evaluate('들고 있기 BTC·ETH 반반', '기준', combineEquity([hold(btc.d1), hold(ethD)], [0.5, 0.5])));
  // 지금 운용 규칙(전부 넣었을 때)
  const P = { feePct: 0.1, slipPct: 0, stopPct: 25, breakerPct: 60 };
  const coins = buildAssets(calendar, { BTC: { daily: btc.d1, funding: btc.funding }, ETH: { daily: ethD, funding: eth.funding } });
  const base = T.simulatePortfolio(coins, P).days;
  add(evaluate('지금 규칙(전부 넣기)', '기준', base));

  // I 롱·숏
  for (const mode of ['ensemble', 'shortAllBelow']) {
    const a = simulateLongShort(btc.d1, fB.day, { mode });
    const b = simulateLongShort(ethD.filter(Boolean), fE.day, { mode });
    const label = mode === 'ensemble' ? '롱숏 (위−아래)/5' : '롱 k/5 + 전부 아래면 숏';
    add(evaluate(`${label} 반반`, 'I', T.blendDays([a, b])));
    add(evaluate(`${label} BTC만`, 'I-종목', a));
    add(evaluate(`${label} ETH만`, 'I-종목', b));
  }

  // M 공격형: 평균선 하나 위면 전부(둘이 반씩)
  for (const L of [50, 100, 200]) add(evaluate(`평균선 ${L}일 위면 전부`, 'M', T.simulatePortfolio(coins, { ...P, smaGrid: [L], allocPct: 100 }).days));

  // O 레버리지(참고만 — 하루 수익률을 그대로 키운 근사, 장중 청산 무시)
  for (const lev of [1.5, 2]) add(evaluate(`지금 규칙 × ${lev}배(참고·운용 불가)`, 'O', base.map((d) => ({ t: d.t, ret: d.ret * lev }))));

  // J 물타기 · K 그리드 (15분봉)
  if (btc.m15 && eth.m15) {
    for (const doubling of [false, true]) for (const n of doubling ? [5] : [5, 10]) for (const stepPct of [5, 10, 15]) for (const tpPct of [3, 5, 10]) {
      const a = simulateDca(btc.m15, fB.at, { stepPct, tpPct, n, doubling });
      const b = simulateDca(eth.m15, fE.at, { stepPct, tpPct, n, doubling });
      add(evaluate(`물타기 ${doubling ? '두 배씩' : '같은 몫'} ${n}번 −${stepPct}% 익절 +${tpPct}%`, 'J', combineEquity([a.eqByDay, b.eqByDay], [0.5, 0.5])));
    }
    for (const spacingPct of [1, 2, 3, 5]) for (const levels of [10, 20]) {
      const a = simulateGrid(btc.m15, fB.at, { spacingPct, levels });
      const b = simulateGrid(eth.m15, fE.at, { spacingPct, levels });
      add(evaluate(`그리드 ${spacingPct}% × ${levels}칸`, 'K', combineEquity([a.eqByDay, b.eqByDay], [0.5, 0.5])));
    }
  } else log('15분봉 없음 — J·K 건너뜀 (node server/backtest/fetch-data.js)');

  // L 바이낸스 미국 주식 + BTC·ETH
  const stocks = loadTradfi(calendar);
  if (stocks && stocks.length) {
    const toSeries = (sym, d, list) => ({ sym, d, fd: fundingMaps(list).day });
    const uni = [toSeries('BTC', alignToCalendar(calendar, btc.d1), btc.funding), toSeries('ETH', ethD, eth.funding), ...stocks.map((s) => toSeries(s.binance, s.d, s.funding))];
    log(`L 종목 ${uni.length}개: ${uni.map((s) => s.sym).join(' ')} — 지금 상장된 종목만이라 과거 성적이 부풀려진다(살아남은 종목 착시)`);
    for (const useTrend of [true, false]) for (const lookback of [20, 60, 120]) for (const topK of [1, 3, 5]) {
      const days = simulateRotation(uni, { lookback, topK, useTrend, rebalanceWeekday: 3 });
      add(evaluate(`순환 ${useTrend ? '추세필터' : '필터없음'} ${lookback}일 상위${topK}`, 'L', days));
    }
    const early = stocks.filter((s) => s.rows.length && s.rows[0].t <= Date.parse('2019-07-01'));
    const assets = { BTC: { daily: btc.d1, funding: btc.funding }, ETH: { daily: ethD, funding: eth.funding } };
    for (const s of early) assets[s.binance] = { daily: s.d, funding: s.funding, perYear: 252 };
    const trendAll = buildAssets(calendar, assets);
    for (const s of early) trendAll[s.binance].perYear = 252;
    log(`L 전부 추세추종 종목 ${Object.keys(trendAll).length}개(2019-07 전부터 기록 있는 것): ${Object.keys(trendAll).join(' ')}`);
    add(evaluate('전부 추세추종 같은 몫', 'L', T.simulatePortfolio(trendAll, P).days));
    add(evaluate('전부 추세추종 변동성30%', 'L', T.simulatePortfolio(trendAll, { ...P, volTarget: 0.3 }).days));
  } else log('L 데이터 없음 — 서버에서 node server/backtest/fetch-tradfi.js 먼저');

  const c = (v, w) => String(v == null ? '-' : v).padStart(w);
  log(`\n2차 탐색 — 통과: 만들기·시험 둘 다 월 ${GOAL_MONTHLY}% 이상 · 가장 길게 물린 기간 ≤ 365일 · 최대 손실 ≤ 60% · 2020-01 ~ ${new Date(calendar[calendar.length - 1]).toISOString().slice(0, 10)}`);
  log(`${'방식'.padEnd(34)}${'연%'.padStart(8)}${'최대손실'.padStart(9)}${'물림일'.padStart(7)}${'최악해%'.padStart(9)}${'월%전체'.padStart(8)}${'월%만들기'.padStart(9)}${'월%시험'.padStart(8)}  판정`);
  for (const r of rows) {
    const why = r.pass ? '✅ 통과' : [r.mIs < GOAL_MONTHLY || r.mOos < GOAL_MONTHLY ? '월3%미달' : null, r.uwDays > 365 ? '오래물림' : null, r.dd > 60 ? '손실>60' : null].filter(Boolean).join('·');
    log(`${r.name.padEnd(34)}${c(r.cagr, 8)}${c(-r.dd, 9)}${c(r.uwDays, 7)}${c(r.worstYear, 9)}${c(r.mAll, 8)}${c(r.mIs, 9)}${c(r.mOos, 8)}  ${r.family === '기준' || r.family === 'O' || r.family === 'I-종목' ? `(${r.family}) ` : ''}${why}`);
  }
  const tried = rows.filter((r) => !['기준', 'O', 'I-종목'].includes(r.family));
  const pass = tried.filter((r) => r.pass);
  for (const fam of [...new Set(tried.map((r) => r.family))]) {
    const f = tried.filter((r) => r.family === fam);
    log(`가족 ${fam}: ${f.length}개 · 통과 ${f.filter((r) => r.pass).length} · 전체 월 2% 이상 ${f.filter((r) => r.mAll >= 2).length}개(${Math.round((f.filter((r) => r.mAll >= 2).length / f.length) * 100)}%)`);
  }
  log(`\n시도 ${tried.length}개 · 통과 ${pass.length}개${pass.length ? ': ' + pass.map((r) => r.name).join(', ') : ''}`);
  log('읽는 법: 물림일 = 고점에서 떨어져 다시 그 고점을 회복할 때까지 걸린 가장 긴 날 수. 들고 있기보다 못하면 방식이 아니라 BTC 가 오른 덕이다.');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(OUT_DIR, `round2-${stamp}.md`), '```\n' + out.join('\n') + '\n```\n');
}

if (require.main === module) main();

module.exports = { underwater, monthlyOf, evaluate, combineEquity, fundingMaps, simulateDca, simulateGrid, simulateLongShort };

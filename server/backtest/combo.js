'use strict';

// combo.js — 가족 H(docs/07-RESEARCH-PROTOCOL.md): 조금이라도 효과가 있었던 것들을 합친다(2026-10-15).
//   바탕: 실제 운용 규칙 그대로(trend.simulatePortfolio — 평균선 20·50·100·150·200일 위 개수만큼, 재난 손절 −25%, 고점 대비 −60% 정지).
//   더하는 것: ① A 변동성 맞춤(volTarget 0.3 — 60일 실현 변동성이 연 30% 넘는 종목은 그만큼 줄인다, 1배 상한)
//             ② 위험 균등(weighting 'invVol' — 변동성 낮은 금·지수에 더 큰 몫)
//             ③ 금·지수 섞기(바이낸스 TradFi 실측 펀딩 포함, mix-trend.js)
//             ④ B 쉬는 돈 펀딩비 차익(addIdleCarry — BTC 현물 매수 + 선물 매도 1배, 켜고 끌 때 비용, 규모 조정 비용은 빠짐 → 상한)
//   비용 한쪽 0.1%(모든 종목). 2020~2023(만들기) / 2024~(시험).
//   마지막 칸: "최대 손실을 20%로 맞추면 월 몇 %인가"(비중을 줄여서만 — 1배를 넘겨 키우지 않는다)와
//              "월 3% 를 내려면 최대 손실을 얼마나 견뎌야 하나"(1배로 안 되면 '불가').
//   node server/backtest/fetch-stocks.js --from 2015 GC=F SPY QQQ && node server/backtest/combo.js

const fs = require('fs');
const path = require('path');
const E = require('./engine');
const T = require('./trend');
const { parseFundingCsv } = require('./carry');
const { alignToCalendar, buildAssets, syntheticFunding, TRADFI_FUNDING_PCT } = require('./mix-trend');
const { looksDaily } = require('./fetch-stocks');

const DATA = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data');
const OUT_DIR = path.join(DATA, '..', 'results');
const DAY = 86400000;
const IS_END = Date.parse('2024-01-01T00:00:00Z');

// 펀딩 기록 → Map(UTC 날짜 → 그날 펀딩 합)
function fundingByDay(list) {
  const m = new Map();
  for (const f of list || []) { const k = Math.floor(f.t / DAY) * DAY; m.set(k, (m.get(k) || 0) + f.rate); }
  return m;
}

// 쉬는 돈(1 − 전날 종가 노출)으로 BTC 펀딩비 차익. 지난 7일 평균 펀딩(8시간당)이 minPer8h 넘을 때만 켠다(그날 아침에 아는 값만).
// 돈의 절반은 현물, 절반은 선물 증거금(1배)이라 받는 펀딩 = 쉬는 돈 × 펀딩 ÷ 2. 켜고 끌 때 두 다리 × 절반 × 한쪽 비용 = 쉬는 돈 × 비용.
function addIdleCarry(days, btcFundingByDay, { minPer8h = 0.0001, costSide = 0.001 } = {}) {
  let on = false;
  return days.map((d, i) => {
    if (i === 0) return { ...d };
    let s = 0;
    let n = 0;
    for (let k = Math.max(0, i - 7); k < i; k++) {
      const v = btcFundingByDay.get(Math.floor(days[k].t / DAY) * DAY);
      if (v != null) { s += v; n++; }
    }
    const want = n >= 7 && s / n / 3 > minPer8h;
    const idle = Math.max(0, 1 - (days[i - 1].expo || 0));
    let ret = d.ret;
    if (want !== on) { ret -= idle * costSide; on = want; }
    if (on) ret += (idle * (btcFundingByDay.get(Math.floor(d.t / DAY) * DAY) || 0)) / 2;
    return { ...d, ret };
  });
}

function periodStats(days, opts = {}) {
  const s = T.summarizeTrend(days, opts);
  if (!s) return null;
  return { cagr: s.cagrPct, dd: s.maxDrawdownPct, calmar: s.maxDrawdownPct > 0 ? Math.round((s.cagrPct / s.maxDrawdownPct) * 100) / 100 : null };
}

const monthlyOf = (cagrPct) => (cagrPct == null ? null : Math.round((Math.pow(1 + cagrPct / 100, 1 / 12) - 1) * 10000) / 100);

// 비중을 줄여(남는 돈 0%) 최대 손실을 maxDD% 이하로 맞췄을 때 — 이미 그 아래면 그대로(1배 넘겨 키우지 않는다)
function atDrawdown(days, maxDD = 20, opts = {}) {
  const full = T.summarizeTrend(days, opts);
  if (!full) return null;
  if (full.maxDrawdownPct <= maxDD) return { alloc: 100, cagr: full.cagrPct, dd: full.maxDrawdownPct, monthly: monthlyOf(full.cagrPct) };
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < 30; it++) {
    const m = (lo + hi) / 2;
    if (T.summarizeTrend(days, { ...opts, alloc: m }).maxDrawdownPct <= maxDD) lo = m;
    else hi = m;
  }
  const s = T.summarizeTrend(days, { ...opts, alloc: lo });
  return { alloc: Math.round(lo * 100), cagr: s.cagrPct, dd: s.maxDrawdownPct, monthly: monthlyOf(s.cagrPct) };
}

// 월 monthlyPct% (복리)를 내려면 견뎌야 하는 최대 손실 — 1배로도 안 되면 null
function drawdownForMonthly(days, monthlyPct = 3, opts = {}) {
  const need = (Math.pow(1 + monthlyPct / 100, 12) - 1) * 100;
  const full = T.summarizeTrend(days, opts);
  if (!full || !(full.cagrPct >= need)) return null;
  let lo = 0;
  let hi = 1;
  for (let it = 0; it < 30; it++) {
    const m = (lo + hi) / 2;
    if (T.summarizeTrend(days, { ...opts, alloc: m }).cagrPct >= need) hi = m;
    else lo = m;
  }
  return { alloc: Math.round(hi * 100), dd: T.summarizeTrend(days, { ...opts, alloc: hi }).maxDrawdownPct };
}

const SIZINGS = [
  ['같은 몫', {}],
  ['변동성30%', { volTarget: 0.3 }],
  ['위험 균등', { weighting: 'invVol' }],
];

function main() {
  const out = [];
  const log = (s = '') => { console.log(s); out.push(s); };
  const read = (p) => E.parseCandleCsv(fs.readFileSync(p, 'utf8'));
  const readFunding = (p) => (fs.existsSync(p) ? parseFundingCsv(fs.readFileSync(p, 'utf8')) : []);
  const btc = read(path.join(DATA, 'BTCUSDT-1d.csv'));
  const calendar = btc.map((b) => b.t);
  const series = {
    BTC: { daily: btc, funding: readFunding(path.join(DATA, 'BTCUSDT-funding.csv')), perYear: 365 },
    ETH: { daily: alignToCalendar(calendar, read(path.join(DATA, 'ETHUSDT-1d.csv'))), funding: readFunding(path.join(DATA, 'ETHUSDT-funding.csv')), perYear: 365 },
  };
  for (const [key, name] of [['QQQ', '나스닥'], ['SPY', 'S&P'], ['GC=F', '금']]) {
    const p = path.join(DATA, 'stocks', `${key}-1d.csv`);
    const rows = fs.existsSync(p) ? read(p) : null;
    if (!rows || !looksDaily(rows)) { log(`${name}(${key}) 일봉 없음 — node server/backtest/fetch-stocks.js --from 2015 ${key}`); continue; }
    series[name] = { daily: alignToCalendar(calendar, rows), funding: syntheticFunding(calendar, TRADFI_FUNDING_PCT[key]), perYear: 252 };
  }
  const btcFd = fundingByDay(series.BTC.funding);
  const combos = [['코인'], ['코인', '금'], ['코인', 'S&P', '금'], ['코인', '나스닥', '금'], ['코인', 'S&P', '나스닥', '금']]
    .map((c) => ({ label: c.join('+'), keys: c.flatMap((x) => (x === '코인' ? ['BTC', 'ETH'] : [x])) }))
    .filter((c) => c.keys.every((k) => series[k]));
  const f = (x) => (x ? `${String(x.cagr).padStart(6)}%/${String(-x.dd).padStart(6)}% 칼마${String(x.calmar).padStart(5)}` : '-'.padEnd(27));
  log(`H 조합 — 실제 운용 규칙(손절 −25%·정지 −60%) + 변동성 맞춤·위험 균등 + 금·지수(실측 펀딩) + 쉬는 돈 펀딩비 차익 · 비용 한쪽 0.1% · ${new Date(calendar[0]).toISOString().slice(0, 10)} ~ ${new Date(calendar[calendar.length - 1]).toISOString().slice(0, 10)}`);
  log(`${'조합'.padEnd(26)} ${'전체'.padEnd(27)} │ ${'만들기 2020~23'.padEnd(27)} │ ${'시험 2024~'.padEnd(27)} │ 손실 20% 맞춤 월%(시험·전체) │ 월 3% 하려면 최대 손실(전체)`);
  const rows = [];
  for (const c of combos) for (const [sz, opt] of SIZINGS) for (const carry of [false, true]) {
    const sub = {};
    for (const k of c.keys) sub[k] = series[k];
    const assets = buildAssets(calendar, sub);
    for (const k of c.keys) assets[k].perYear = series[k].perYear;
    const r = T.simulatePortfolio(assets, { feePct: 0.1, slipPct: 0, stopPct: 25, breakerPct: 60, ...opt });
    const days = carry ? addIdleCarry(r.days, btcFd) : r.days;
    const name = `${c.label} ${sz}${carry ? '+차익' : ''}`;
    const row = {
      name,
      all: periodStats(days),
      is: periodStats(days, { to: IS_END - 1 }),
      oos: periodStats(days, { from: IS_END }),
      oos20: atDrawdown(days, 20, { from: IS_END }),
      all20: atDrawdown(days, 20),
      need3: drawdownForMonthly(days, 3),
      halted: r.halted,
    };
    rows.push(row);
    log(
      `${name.padEnd(26)} ${f(row.all)} │ ${f(row.is)} │ ${f(row.oos)} │ ${String(row.oos20 ? row.oos20.monthly : '-').padStart(5)}% · ${String(row.all20 ? row.all20.monthly : '-').padStart(5)}%` +
        `${row.all20 ? ` (비중 ${row.all20.alloc}%)` : ''} │ ${row.need3 ? `${row.need3.dd}% (비중 ${row.need3.alloc}%)` : '1배로 불가'}${r.halted ? `  ⚠ 정지 ${new Date(r.halted.t).toISOString().slice(0, 10)}` : ''}`
    );
  }
  const pass = rows.filter((r) => r.oos && r.is && r.oos.calmar >= 2.1 && r.oos.cagr > 0 && r.is.calmar >= 1);
  const best = rows.filter((r) => r.all20).sort((a, b) => b.all20.monthly - a.all20.monthly)[0];
  log(`\n시도 ${rows.length}개 · 기준(시험 칼마 ≥ 2.1 · 만들기 칼마 ≥ 1) 통과 ${pass.length}개${pass.length ? ': ' + pass.map((r) => r.name).join(', ') : ''}`);
  if (best) log(`최대 손실 20% 로 맞췄을 때 가장 높은 월 수익(전체 기간): ${best.name} 월 ${best.all20.monthly}% (연 ${best.all20.cagr}%, 비중 ${best.all20.alloc}%)`);
  log('읽는 법: "안전하게 월 3%" = 손실 20% 맞춤 월% 가 3 이상. 차익은 규모 조정 비용이 빠진 상한이다. 금·지수 펀딩은 3~5개월 실측 고정값이다.');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(OUT_DIR, `combo-${stamp}.md`), '```\n' + out.join('\n') + '\n```\n');
}

if (require.main === module) main();

module.exports = { fundingByDay, addIdleCarry, periodStats, monthlyOf, atDrawdown, drawdownForMonthly };

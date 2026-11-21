'use strict';

// leveraged-dca.js — '모든 걸 버리고 TQQQ 매달 20만 원 무지성 적립 · 하락장엔 더 많이'를 실제 가격으로 잰다(2026-11-21 오너 — 다른 대화방 제안).
// TQQQ(나스닥 100 의 하루 수익 × 3)는 2010-02 에 생겼다. 닷컴 붕괴(2000~02)를 보려면 QQQ(1999-03~) 하루 수익으로 '가짜 TQQQ'를 만든다:
//   가짜 TQQQ 하루 = 3 × QQQ 하루 수익 − 비용/252(비용 = 운용 보수 + 빌린 두 배 몫 이자, 기본 연 5% — --cost 로 바꾼다)
//   진짜 TQQQ 기록(2010~)이 있으면 같은 기간 가짜와 나란히 놓아 비용 가정이 맞는지 먼저 보인다.
// 적립: 매달 첫 거래일 종가에 20만 원(--monthly). '하락장엔 더 많이' = 그날 QQQ 가 200일선 아래면 두 배(--dip 2).
// 견주는 것: A TQQQ 적립 · B TQQQ 적립 + 하락장 두 배 · C QQQ 적립(레버리지 없음) · D QQQ 적립 + 하락장 두 배.
// 보는 것: 넣은 돈 대비 끝 금액(배수) · 넣은 돈 대비 가장 나빴던 때(계좌 ÷ 그때까지 넣은 돈의 최저) · 계좌 고점 대비 최대 하락.
// 시작한 달마다 10년(--years) 굴린 모든 경우의 최악 · 중간 + 정해 둔 세 구간(2000-01 · 2010-02 · 2021-11 시작 → 지금).
// --income [--monthly 250000] [--boost 400000]: 같은 월급으로 꾸준히 vs 아껴 두었다가 하락장에(하락장 기준 200일선 아래 · 고점 −20%) — 아래 incomeCompare
// 데이터(서버): node server/backtest/fetch-stocks.js --from 1995 QQQ TQQQ
// 세금 · 환율 · 매매 수수료는 빼고 본다(넷 모두 같은 조건). 연구용 — 레버리지 ETF 는 docs/08 '절대 하지 않는 것'에 있다.

const fs = require('fs');
const path = require('path');
const E = require('./engine');
const FS = require('./fetch-stocks');
const G = require('./ma-grid');

const DAY = 86400000;
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const man = (won) => `${Math.round(won / 10000).toLocaleString('en-US')}만`;
const p1 = (x) => (x == null || !Number.isFinite(x) ? '-' : `${Math.round(x * 10) / 10}`);

function load(dir, sym) {
  const p = path.join(dir, `${FS.fileKey(sym)}-1d.csv`);
  if (!fs.existsSync(p)) return null;
  const rows = E.parseCandleCsv(fs.readFileSync(p, 'utf8'));
  return FS.looksDaily(rows) ? rows : null;
}

// QQQ 일봉 → 같은 날짜의 가짜 3배 가격(첫날 1)
function synthLeveraged(bars, { mult = 3, costAnnual = 0.05 } = {}) {
  const out = [{ t: bars[0].t, c: 1 }];
  for (let i = 1; i < bars.length; i++) {
    const r = bars[i].c / bars[i - 1].c - 1;
    const prev = out[i - 1].c;
    out.push({ t: bars[i].t, c: Math.max(0, prev * (1 + mult * r - costAnnual / 252)) });
  }
  return out;
}

// 매달 첫 거래일 · 그날 QQQ 가 200일선 아래면 dip 배
function dca(prices, { from, to = Infinity, monthly = 200000, dip = 1, below = null } = {}) {
  let units = 0;
  let invested = 0;
  let lastMonth = null;
  let peak = 0;
  let maxDd = 0;
  let worstRatio = Infinity;
  let worstAt = null;
  let value = 0;
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    if (p.t < from || p.t > to) continue;
    const m = ymd(p.t).slice(0, 7);
    if (m !== lastMonth) {
      lastMonth = m;
      const amt = monthly * (dip > 1 && below && below[i] ? dip : 1);
      if (p.c > 0) {
        units += amt / p.c;
        invested += amt;
      }
    }
    value = units * p.c;
    if (invested > 0) {
      const ratio = value / invested;
      if (ratio < worstRatio) {
        worstRatio = ratio;
        worstAt = p.t;
      }
    }
    peak = Math.max(peak, value);
    if (peak > 0) maxDd = Math.max(maxDd, 1 - value / peak);
  }
  return { invested, value, multiple: invested > 0 ? value / invested : null, worstRatio: Number.isFinite(worstRatio) ? worstRatio : null, worstAt, maxDd };
}

function cagr(prices, from, to) {
  const xs = prices.filter((p) => p.t >= from && p.t <= to);
  if (xs.length < 2 || !(xs[0].c > 0)) return null;
  const yrs = (xs[xs.length - 1].t - xs[0].t) / (365.25 * DAY);
  return yrs > 0 ? (Math.pow(xs[xs.length - 1].c / xs[0].c, 1 / yrs) - 1) * 100 : null;
}

function maxDrawdown(prices, from, to) {
  let peak = 0;
  let dd = 0;
  for (const p of prices) {
    if (p.t < from || p.t > to) continue;
    peak = Math.max(peak, p.c);
    if (peak > 0) dd = Math.max(dd, 1 - p.c / peak);
  }
  return dd * 100;
}

function quantile(xs, q) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] : null;
}

function run({ qqq, tqqq = null, costAnnual = 0.05, monthly = 200000, dip = 2, years = 10, log }) {
  const lev = synthLeveraged(qqq, { costAnnual });
  const sma = G.maSeries(qqq.map((b) => b.c), 200);
  const below = qqq.map((b, i) => sma[i] != null && b.c < sma[i]);
  const qPrices = qqq.map((b) => ({ t: b.t, c: b.c }));
  const start0 = qqq[200].t; // 200일선이 생긴 뒤부터
  const end = qqq[qqq.length - 1].t;
  log(`■ TQQQ 무지성 적립 vs QQQ 적립 — 매달 ${man(monthly)} 원(하락장 = QQQ 가 200일선 아래인 달은 ${dip}배) · 가짜 TQQQ = QQQ 하루 × 3 − 연 ${p1(costAnnual * 100)}% 비용 · 세금·환율·수수료 없음`);
  if (tqqq && tqqq.length > 300) {
    const f = tqqq[0].t;
    log(`  비용 가정 확인(진짜 TQQQ ${ymd(f)} ~ ${ymd(end)}): 진짜 1년 평균 ${p1(cagr(tqqq.map((b) => ({ t: b.t, c: b.c })), f, end))}% · 최대 하락 −${p1(maxDrawdown(tqqq, f, end))}% / 가짜 ${p1(cagr(lev, f, end))}% · −${p1(maxDrawdown(lev, f, end))}% — 둘이 가까우면 2000 년대 가짜 값도 믿을 만하다`);
  } else log('  (진짜 TQQQ 기록 없음 — 비용 가정 확인은 fetch-stocks.js --from 2010 TQQQ 뒤에)');
  log(`  그냥 한 번에 샀다면(${ymd(start0)} ~ ${ymd(end)}): QQQ 1년 평균 ${p1(cagr(qPrices, start0, end))}% · 최대 하락 −${p1(maxDrawdown(qPrices, start0, end))}% / 가짜 TQQQ ${p1(cagr(lev, start0, end))}% · −${p1(maxDrawdown(lev, start0, end))}%`);
  const variants = [
    ['A TQQQ 적립', lev, 1],
    ['B TQQQ 적립 + 하락장 두 배', lev, dip],
    ['C QQQ 적립(레버리지 없음)', qPrices, 1],
    ['D QQQ 적립 + 하락장 두 배', qPrices, dip],
  ];
  const fixed = [['2000-01 시작(닷컴 붕괴 직전)', Date.parse('2000-01-03')], ['2010-02 시작(TQQQ 생긴 때)', Date.parse('2010-02-11')], ['2021-11 시작(최근 고점)', Date.parse('2021-11-01')]].filter(([, t]) => t >= start0);
  for (const [label, from] of fixed) {
    log(`  [${label} → ${ymd(end)}]`);
    for (const [name, prices, d] of variants) {
      const r = dca(prices, { from, monthly, dip: d, below });
      log(`    ${name}: 넣은 돈 ${man(r.invested)} → 지금 ${man(r.value)}(${p1(r.multiple)}배) · 넣은 돈 대비 가장 나빴던 때 ${p1((r.worstRatio - 1) * 100)}%(${r.worstAt ? ymd(r.worstAt) : '-'}) · 계좌 고점 대비 최대 하락 −${p1(r.maxDd * 100)}%`);
    }
  }
  // 시작한 달마다 years 년
  const starts = [];
  for (let t = start0; t + years * 365.25 * DAY <= end; ) {
    starts.push(t);
    const d = new Date(t);
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  log(`  [시작한 달마다 ${years}년 — ${starts.length}가지(${starts.length ? `${ymd(starts[0]).slice(0, 7)} ~ ${ymd(starts[starts.length - 1]).slice(0, 7)}` : '-'})]`);
  const out = {};
  for (const [name, prices, d] of variants) {
    const rs = starts.map((from) => dca(prices, { from, to: from + years * 365.25 * DAY, monthly, dip: d, below }));
    const mult = rs.map((r) => r.multiple);
    const worst = rs.map((r) => r.worstRatio);
    const loseEnd = rs.filter((r) => r.multiple < 1).length;
    out[name] = { mult, worst, loseEnd };
    if (!rs.length) continue;
    const wi = mult.indexOf(Math.min(...mult));
    log(`    ${name}: 끝에 넣은 돈의 최악 ${p1(Math.min(...mult))}배(${ymd(starts[wi]).slice(0, 7)} 시작) · 10% ${p1(quantile(mult, 0.1))}배 · 중간 ${p1(quantile(mult, 0.5))}배 · 최고 ${p1(Math.max(...mult))}배 | 끝에 넣은 돈보다 적었던 경우 ${loseEnd}/${rs.length} | 도중에 넣은 돈 대비 가장 나빴던 때 최악 ${p1((Math.min(...worst) - 1) * 100)}% · 중간 ${p1((quantile(worst, 0.5) - 1) * 100)}%`);
  }
  log('  읽는 법: 배수는 넣은 돈 전체 대비(1배 = 본전). \'도중에 가장 나빴던 때\'는 그때까지 넣은 돈 대비 계좌가 얼마나 빠져 있었나 — 그 순간에도 매달 사고 하락장엔 두 배로 살 수 있었을지 본다.');
  return out;
}

// --income(2026-11-21 오너 '매달 꾸준히 같은 금액이 좋을까? 하락장 기준은?'): 넣을 수 있는 돈이 정해져 있을 때 같은 월급으로 견준다.
//   꾸준히: 매달 월급 전부 · 아껴 두기: 평소 달은 절반만 사고 절반은 현금, 하락장 달엔 그달 월급 + 모아 둔 현금 전부.
//   하락장 기준 두 가지: ① QQQ 종가가 200일선 아래(신호에 이미 나옴) ② QQQ 가 그때까지 최고가에서 −20% 넘게 빠짐(흔히 말하는 약세장).
//   재는 것: 끝에 (주식 + 현금) ÷ 그때까지 받은 월급 합 · 도중에 가장 나빴던 때 · 하락장 달 수.
function incomePlan(prices, dipFlags, { from, to = Infinity, income = 250000, mode = 'steady' } = {}) {
  let units = 0;
  let cash = 0;
  let paid = 0;
  let lastMonth = null;
  let worst = Infinity;
  let wealth = 0;
  let dips = 0;
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    if (p.t < from || p.t > to) continue;
    const m = ymd(p.t).slice(0, 7);
    if (m !== lastMonth) {
      lastMonth = m;
      paid += income;
      let amt = income;
      if (mode === 'reserve') {
        if (dipFlags[i]) {
          amt = income + cash;
          cash = 0;
          dips += 1;
        } else {
          amt = income / 2;
          cash += income / 2;
        }
      }
      if (p.c > 0) units += amt / p.c;
      else cash += amt;
    }
    wealth = units * p.c + cash;
    if (paid > 0) worst = Math.min(worst, wealth / paid);
  }
  return { paid, wealth, cash, multiple: paid > 0 ? wealth / paid : null, worstRatio: Number.isFinite(worst) ? worst : null, dips };
}

function incomeCompare({ qqq, costAnnual = 0.05, income = 250000, years = 10, log }) {
  const lev = synthLeveraged(qqq, { costAnnual });
  const qPrices = qqq.map((b) => ({ t: b.t, c: b.c }));
  const sma = G.maSeries(qqq.map((b) => b.c), 200);
  const d200 = qqq.map((b, i) => sma[i] != null && b.c < sma[i]);
  let hi = 0;
  const dd20 = qqq.map((b) => {
    hi = Math.max(hi, b.c);
    return b.c <= hi * 0.8;
  });
  const start0 = qqq[200].t;
  const end = qqq[qqq.length - 1].t;
  const plans = [
    ['꾸준히 매달 전부 — TQQQ', lev, null, 'steady'],
    ['아껴 두기 · 하락장 = 200일선 아래 — TQQQ', lev, d200, 'reserve'],
    ['아껴 두기 · 하락장 = 고점 −20% — TQQQ', lev, dd20, 'reserve'],
    ['(참고) 꾸준히 매달 전부 — QQQ', qPrices, null, 'steady'],
  ];
  log(`\n■ 같은 월급(매달 ${man(income)} 원)으로 — 꾸준히 vs 아껴 두었다가 하락장에 · 끝 = (주식 + 현금) ÷ 받은 월급 합`);
  log(`  하락장 달 비율(${ymd(start0).slice(0, 7)} ~): 200일선 아래 ${p1((d200.filter((x, i) => i >= 200).filter(Boolean).length / (d200.length - 200)) * 100)}%(거래일) · 고점 −20% ${p1((dd20.filter((x, i) => i >= 200).filter(Boolean).length / (dd20.length - 200)) * 100)}%`);
  const fixed = [['2000-01 시작', Date.parse('2000-01-03')], ['2010-02 시작', Date.parse('2010-02-11')], ['2021-11 시작', Date.parse('2021-11-01')]].filter(([, t]) => t >= start0);
  for (const [label, from] of fixed) {
    log(`  [${label} → ${ymd(end)}]`);
    for (const [name, prices, flags, mode] of plans) {
      const r = incomePlan(prices, flags, { from, income, mode });
      log(`    ${name}: 받은 월급 ${man(r.paid)} → 지금 ${man(r.wealth)}(${p1(r.multiple)}배${r.cash > 0 ? ` · 그중 현금 ${man(r.cash)}` : ''}) · 도중에 가장 나빴던 때 ${p1((r.worstRatio - 1) * 100)}%${mode === 'reserve' ? ` · 하락장 달 ${r.dips}번` : ''}`);
    }
  }
  const starts = [];
  for (let t = start0; t + years * 365.25 * DAY <= end; ) {
    starts.push(t);
    const d = new Date(t);
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  log(`  [시작한 달마다 ${years}년 — ${starts.length}가지]`);
  const out = {};
  for (const [name, prices, flags, mode] of plans) {
    const rs = starts.map((from) => incomePlan(prices, flags, { from, to: from + years * 365.25 * DAY, income, mode }));
    const mult = rs.map((r) => r.multiple);
    const worst = rs.map((r) => r.worstRatio);
    out[name] = { mid: quantile(mult, 0.5), q10: quantile(mult, 0.1), min: Math.min(...mult), lose: rs.filter((r) => r.multiple < 1).length, worstMid: quantile(worst, 0.5), worstMin: Math.min(...worst) };
    const o = out[name];
    log(`    ${name}: 끝 최악 ${p1(o.min)}배 · 10% ${p1(o.q10)}배 · 중간 ${p1(o.mid)}배 | 받은 월급보다 적음 ${o.lose}/${rs.length} | 도중에 가장 나빴던 때 최악 ${p1((o.worstMin - 1) * 100)}% · 중간 ${p1((o.worstMid - 1) * 100)}%`);
  }
  // 미리 정한 고르는 법(docs/07): 아껴 두기는 꾸준히보다 중간과 10% 가 둘 다 높아야 채택 — 아니면 꾸준히(더 단순)
  const base = out[plans[0][0]];
  const ok = plans.slice(1, 3).map(([name]) => [name, out[name]]).filter(([, o]) => o.mid >= base.mid && o.q10 >= base.q10).sort((a, b) => b[1].mid - a[1].mid);
  log(`  판정(docs/07 — 아껴 두기가 꾸준히보다 10년 중간 · 10% 둘 다 높아야): ${ok.length ? `→ ${ok[0][0]}` : '→ 꾸준히 매달 전부(더 단순하고 더 나음)'}`);
  return out;
}

// 하락장엔 더 넣기(오너 2026-11-21 '고점 기준 −40% 밑이면 40만, 다시 위로 오면 25만'): 평소 base, 하락장 달엔 boost — 차이는 밖(저축)에서 가져온다.
//   넣은 돈이 달라지니 '넣은 돈 대비 배수'로 견주고, 밖에서 더 가져와야 했던 돈 · 하락장 달이 가장 길게 이어진 달 수도 적는다.
// ddSince: flags 대신 '산 뒤(이 구간 시작 뒤) 그 상품의 최고가'에서 ddSince 넘게 빠진 달 — 가짜 TQQQ 는 1999 년부터 이어 붙인 값이라
//   2000 년 고점을 끝내 다시 못 넘어 '처음부터 쌓은 최고가'로 재면 2010 년 이후도 늘 −40% 아래로 잡힌다(2026-11-21 첫 실행에서 발견 — 하락장 달 202/202).
//   진짜 TQQQ 는 2010 년에 새로 시작했으니, 산 뒤의 최고가로 재는 쪽이 실제로 대표님이 보는 값에 가깝다.
function boostPlan(prices, flags, { from, to = Infinity, base = 250000, boost = 400000, ddSince = null } = {}) {
  let hiSince = 0;
  let units = 0;
  let invested = 0;
  let months = 0;
  let boosted = 0;
  let run = 0;
  let maxRun = 0;
  let lastMonth = null;
  let worst = Infinity;
  let value = 0;
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    if (p.t < from || p.t > to) continue;
    hiSince = Math.max(hiSince, p.c);
    const m = ymd(p.t).slice(0, 7);
    if (m !== lastMonth) {
      lastMonth = m;
      months += 1;
      const deep = ddSince != null ? hiSince > 0 && p.c <= hiSince * (1 - ddSince) : !!(flags && flags[i]);
      if (deep) {
        boosted += 1;
        run += 1;
        maxRun = Math.max(maxRun, run);
      } else run = 0;
      const amt = deep ? boost : base;
      if (p.c > 0) units += amt / p.c;
      invested += amt;
    }
    value = units * p.c;
    if (invested > 0) worst = Math.min(worst, value / invested);
  }
  return { invested, value, multiple: invested > 0 ? value / invested : null, worstRatio: Number.isFinite(worst) ? worst : null, boosted, maxRun, months, extra: invested - base * months };
}

// 그때까지 최고가에서 dd 넘게 빠졌나(처음부터 쌓은 최고가)
function belowPeak(prices, dd) {
  let hi = 0;
  return prices.map((p) => {
    hi = Math.max(hi, p.c);
    return hi > 0 && p.c <= hi * (1 - dd);
  });
}

function boostCompare({ qqq, costAnnual = 0.05, base = 250000, boost = 400000, years = 10, log }) {
  const lev = synthLeveraged(qqq, { costAnnual });
  const qPrices = qqq.map((b) => ({ t: b.t, c: b.c }));
  const start0 = qqq[200].t;
  const end = qqq[qqq.length - 1].t;
  const plans = [
    ['꾸준히 매달 ' + man(base), null],
    ['TQQQ 가 (산 뒤) 고점 −40% 아래인 달 ' + man(boost), null, 0.4],
    ['QQQ 가 고점 −40% 아래인 달 ' + man(boost), belowPeak(qPrices, 0.4)],
    ['QQQ 가 고점 −20% 아래인 달 ' + man(boost), belowPeak(qPrices, 0.2)],
  ];
  log(`\n■ 하락장엔 더 넣기 — TQQQ 적립 · 평소 ${man(base)} · 하락장 달 ${man(boost)}(차이는 저축에서) · 넣은 돈 대비 배수로 견준다`);
  const fixed = [['2000-01 시작', Date.parse('2000-01-03')], ['2010-02 시작', Date.parse('2010-02-11')], ['2021-11 시작', Date.parse('2021-11-01')]].filter(([, t]) => t >= start0);
  for (const [label, from] of fixed) {
    log(`  [${label} → ${ymd(end)}]`);
    for (const [name, flags, ddSince] of plans) {
      const r = boostPlan(lev, flags, { from, base, boost, ddSince });
      log(`    ${name}: 넣은 돈 ${man(r.invested)} → 지금 ${man(r.value)}(${p1(r.multiple)}배) · 도중에 가장 나빴던 때 ${p1((r.worstRatio - 1) * 100)}%${flags || ddSince != null ? ` · 하락장 달 ${r.boosted}/${r.months}(가장 길게 ${r.maxRun}달 연속) · 저축에서 더 가져온 돈 ${man(r.extra)}` : ''}`);
    }
  }
  const starts = [];
  for (let t = start0; t + years * 365.25 * DAY <= end; ) {
    starts.push(t);
    const d = new Date(t);
    t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  log(`  [시작한 달마다 ${years}년 — ${starts.length}가지]`);
  const out = {};
  for (const [name, flags, ddSince] of plans) {
    const rs = starts.map((from) => boostPlan(lev, flags, { from, to: from + years * 365.25 * DAY, base, boost, ddSince }));
    const mult = rs.map((r) => r.multiple);
    const worst = rs.map((r) => r.worstRatio);
    const o = (out[name] = { mid: quantile(mult, 0.5), q10: quantile(mult, 0.1), min: Math.min(...mult), lose: rs.filter((r) => r.multiple < 1).length, worstMid: quantile(worst, 0.5), worstMin: Math.min(...worst), extraMax: Math.max(...rs.map((r) => r.extra)), runMax: Math.max(...rs.map((r) => r.maxRun)) });
    log(`    ${name}: 끝 최악 ${p1(o.min)}배 · 10% ${p1(o.q10)}배 · 중간 ${p1(o.mid)}배 | 넣은 돈보다 적음 ${o.lose}/${rs.length} | 도중에 가장 나빴던 때 최악 ${p1((o.worstMin - 1) * 100)}% · 중간 ${p1((o.worstMid - 1) * 100)}%${flags || ddSince != null ? ` | 10년 안에 저축에서 더 가져온 돈 최대 ${man(o.extraMax)} · 하락장 달 최장 ${o.runMax}달 연속` : ''}`);
  }
  const b = out[plans[0][0]];
  const ok = plans.slice(1).map(([name]) => [name, out[name]]).filter(([, o]) => o.mid >= b.mid && o.q10 >= b.q10).sort((x, y) => y[1].mid - x[1].mid);
  log(`  판정(docs/07 — 넣은 돈 대비 10년 중간 · 10% 둘 다 꾸준히 이상이어야): ${ok.length ? `→ ${ok[0][0]}(대신 저축에서 최대 ${man(ok[0][1].extraMax)} 필요)` : '→ 꾸준히(더 넣어도 넣은 돈 대비로는 나아지지 않음)'}`);
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : d);
  const dir = path.resolve(arg('--dir', FS.OUT_DIR));
  const qqq = load(dir, 'QQQ');
  if (!qqq || qqq.length < 400) return console.log('QQQ 일봉 없음 — 먼저 node server/backtest/fetch-stocks.js --from 1995 QQQ TQQQ');
  const log = (s = '') => console.log(s);
  if (argv.includes('--income')) {
    incomeCompare({ qqq, costAnnual: Number(arg('--cost', 5)) / 100, income: Number(arg('--monthly', 250000)), years: Number(arg('--years', 10)), log });
    boostCompare({ qqq, costAnnual: Number(arg('--cost', 5)) / 100, base: Number(arg('--monthly', 250000)), boost: Number(arg('--boost', 400000)), years: Number(arg('--years', 10)), log });
    return;
  }
  run({ qqq, tqqq: load(dir, 'TQQQ'), costAnnual: Number(arg('--cost', 5)) / 100, monthly: Number(arg('--monthly', 200000)), dip: Number(arg('--dip', 2)), years: Number(arg('--years', 10)), log });
}

if (require.main === module) main();

module.exports = { synthLeveraged, dca, cagr, maxDrawdown, run, incomePlan, incomeCompare, boostPlan, belowPeak, boostCompare };

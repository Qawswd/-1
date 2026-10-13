'use strict';

// backtest/trend.js — 일봉 추세추종(롱만) 백테스트. 2026-10-13 오너 승인, carry.js 와 함께 기계 전략 검증.
//
// 규칙: 일봉 종가가 N일 이동평균 위로 마감하면 다음 날 시가에 매수, 아래로 마감하면 다음 날 시가에 청산(현금).
// 무기한 선물 1배 롱으로 든다 — 수수료(테이커 0.05% + 슬리피지 0.02%, 한쪽)와 보유 중 펀딩비(양수면 롱이 낸다)를
// 실제 기록대로 뺀다. 숏은 하지 않는다(docs/04-BACKTEST.md: 숏은 근거가 없었다).
//
//   node server/backtest/trend.js
//   node server/backtest/trend.js --from 2024-01-01
//   node server/backtest/trend.js --stop 5          # 진입가 −5% 보호 손절 포함(실주문 조건)
//
// 비중: 계좌 전체를 넣으면 낙폭이 크다. 관문(최대 낙폭 ≤ 15%)을 지키려면 계좌의 몇 %만 넣어야 하는지와
// 그때의 연수익을 같이 보여준다(나머지는 현금).

const fs = require('fs');
const path = require('path');
const E = require('./engine');
const { parseFundingCsv } = require('./carry');

const DATA_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data');
const OUT_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'results');
const DAY = 86400000;
// hardStopPct: 진입가 대비 이만큼 내려가면 손절(실주문은 손절 필수 — exchange.js). null 이면 평균 이탈로만 나간다.
const DEFAULTS = Object.freeze({ sma: 100, feePct: 0.05, slipPct: 0.02, alloc: 1, hardStopPct: null });
const SMA_GRID = Object.freeze([20, 50, 100, 150, 200]);

// 하루 단위 수익률 목록을 만든다. 신호는 그날 종가까지만 보고(미래 안 봄), 체결은 다음 날 시가(UTC 00:00).
// 날마다: 진입일 = 시가→종가(수수료) · 보유일 = 전날 종가→종가 · 청산일 = 전날 종가→시가(수수료).
// 펀딩은 보유 중 정산분만 뺀다(00:00 정산은 그 시각에 들고 있던 쪽 — 진입일은 안 내고 청산일은 낸다).
// 반환: { days: [{t, ret}], trades: [{entryT, exitT, pct}], exposurePct }
function simulateTrend(daily, funding = [], params = {}) {
  const p = { ...DEFAULTS, ...params };
  const side = (p.feePct + p.slipPct) / 100;
  const fund = [...funding].sort((a, b) => a.t - b.t);
  // 날마다 펀딩 합(UTC 00:00 정산분과 나머지)을 미리 나눠 둔다
  const fundByDay = new Map();
  for (const f of fund) {
    const k = Math.floor(f.t / DAY) * DAY;
    const e = fundByDay.get(k) || { atOpen: 0, rest: 0 };
    if (f.t === k) e.atOpen += f.rate;
    else e.rest += f.rate;
    fundByDay.set(k, e);
  }
  const days = [];
  const trades = [];
  let pos = false; // 오늘(d) 들고 있는가 — 어제 종가 신호로 정해진다
  let sum = 0;
  let mul = 1;
  let entryT = null;
  let entryPx = null;
  let held = 0;
  const stopFrac = Number(p.hardStopPct) > 0 ? Number(p.hardStopPct) / 100 : null;
  for (let d = 0; d < daily.length; d++) {
    const b = daily[d];
    const fd = fundByDay.get(Math.floor(b.t / DAY) * DAY) || { atOpen: 0, rest: 0 };
    const prevPos = d > 0 ? days[d - 1].pos : false;
    let ret = 0;
    const stopPx = stopFrac != null && entryPx ? entryPx * (1 - stopFrac) : null;
    if (!prevPos && pos && stopFrac != null && b.l <= b.o * (1 - stopFrac)) {
      // 진입한 날 바로 손절: 시가에 사서 손절가에 판다(수수료 두 번)
      ret = (1 - stopFrac) * (1 - side) * (1 - side) - 1;
      trades.push({ entryT: b.t, exitT: b.t, pct: Math.round(ret * 10000) / 100, stop: true });
      pos = false;
    } else if (prevPos && pos && stopPx != null && b.l <= stopPx) {
      // 보유 중 손절. 시가부터 손절가 밑이면(갭) 시가에 나간다
      const px = Math.min(b.o, stopPx);
      ret = (px / daily[d - 1].c) * (1 - side) - 1 - fd.atOpen;
      mul *= 1 + ret;
      trades.push({ entryT, exitT: b.t, pct: Math.round((mul - 1) * 10000) / 100, stop: true });
      pos = false;
      held += 1;
    } else if (!prevPos && pos) {
      ret = (b.c / b.o) * (1 - side) - 1 - fd.rest;
      mul = 1 + ret;
      entryT = b.t;
      entryPx = b.o;
    } else if (prevPos && pos) {
      ret = b.c / daily[d - 1].c - 1 - fd.atOpen - fd.rest;
      mul *= 1 + ret;
    } else if (prevPos && !pos) {
      ret = (b.o / daily[d - 1].c) * (1 - side) - 1 - fd.atOpen;
      mul *= 1 + ret;
      trades.push({ entryT, exitT: b.t, pct: Math.round((mul - 1) * 10000) / 100 });
    }
    if (pos) held += 1;
    days.push({ t: b.t, ret, pos });
    // 오늘 종가로 내일 포지션을 정한다
    sum += b.c;
    if (d >= p.sma) sum -= daily[d - p.sma].c;
    pos = d >= p.sma - 1 ? b.c > sum / p.sma : false;
  }
  return {
    days: days.map(({ t, ret }) => ({ t, ret })),
    trades,
    exposurePct: daily.length ? Math.round((held / daily.length) * 1000) / 10 : 0,
  };
}

// 실제 운용 규칙 그대로(trend-follow.js 와 같은 정의) — BTC·ETH 가 한 계좌를 나눠 쓴다.
// 매일 UTC 00:00 직후(그날 시가): 어제까지 끝난 일봉 종가로 평균선 다섯 개 중 몇 개 위인지(k) 센다.
//   종목별 목표 노출 = 순자산 × allocPct% × 종목 비중(1/종목 수) × k/5.
//   k 가 바뀌었거나 지금 노출이 목표에서 (최대 노출 × bandPct%) 넘게 벗어났으면 시가에 목표로 맞춘다.
// 보호 손절: 종목마다 하나, 평균 진입가 × (1 − stopPct%). 당기기만 한다(추가 매수로 평균가가 내려가도 손절은 그대로).
//   저가가 닿으면 그 종목 전량 청산(갭이면 시가). 다음 날 시가에 다시 판단한다.
// 정지 장치: 순자산이 고점 대비 breakerPct% 빠지면 전량 청산하고 멈춘다(그 뒤로는 거래 없음).
// 반환: { days: [{t, ret}], trades, stops, halted: {t, ddPct}|null, maxGrossPct }
function simulatePortfolio(assets, params = {}) {
  const p = { smaGrid: SMA_GRID, allocPct: 95, stopPct: 5, bandPct: 20, breakerPct: 55, feePct: 0.05, slipPct: 0.02, ...params };
  const side = (p.feePct + p.slipPct) / 100;
  const names = Object.keys(assets);
  const w = 1 / names.length;
  // 날짜 맞추기: 모든 종목에 있는 날만
  const byT = names.map((n) => new Map(assets[n].daily.map((b) => [b.t, b])));
  const ts = assets[names[0]].daily.map((b) => b.t).filter((t) => byT.every((m) => m.has(t)));
  const fund = names.map((n) => {
    const m = new Map();
    for (const f of assets[n].funding || []) {
      const k = Math.floor(f.t / DAY) * DAY;
      m.set(k, (m.get(k) || 0) + f.rate);
    }
    return m;
  });
  const closes = names.map(() => []);
  const st = names.map(() => ({ qty: 0, avg: 0, stop: null }));
  let cash = 1;
  let peak = 1;
  const days = [];
  let trades = 0;
  let stops = 0;
  let halted = null;
  let prevEq = 1;
  let maxGross = 0;
  const kOf = (cl) => p.smaGrid.filter((n) => cl.length >= n && cl[cl.length - 1] > cl.slice(-n).reduce((a, b) => a + b, 0) / n).length;
  const lastK = names.map(() => 0);
  for (let d = 0; d < ts.length; d++) {
    const t = ts[d];
    const bars = byT.map((m) => m.get(t));
    // 1) 시가: 어제 종가까지로 목표를 정하고 맞춘다
    if (!halted && d > 0) {
      const eqOpen = cash + st.reduce((s, x, i) => s + x.qty * bars[i].o, 0);
      for (let i = 0; i < names.length; i++) {
        const k = kOf(closes[i]);
        const full = eqOpen * (p.allocPct / 100) * w;
        const target = full * (k / p.smaGrid.length);
        const cur = st[i].qty * bars[i].o;
        const need = k !== lastK[i] || Math.abs(target - cur) > full * (p.bandPct / 100) || (target === 0 && cur > 0);
        lastK[i] = k;
        if (!need) continue;
        const dq = target / bars[i].o - st[i].qty;
        if (Math.abs(dq) < 1e-12) continue;
        cash -= dq * bars[i].o + Math.abs(dq) * bars[i].o * side;
        trades += 1;
        if (dq > 0) {
          const newQty = st[i].qty + dq;
          st[i].avg = (st[i].avg * st[i].qty + bars[i].o * dq) / newQty;
          st[i].qty = newQty;
          const want = st[i].avg * (1 - p.stopPct / 100);
          st[i].stop = st[i].stop == null ? want : Math.max(st[i].stop, want);
        } else {
          st[i].qty += dq;
          if (st[i].qty <= 1e-12) { st[i].qty = 0; st[i].avg = 0; st[i].stop = null; }
        }
      }
    }
    // 2) 장중: 손절
    for (let i = 0; i < names.length; i++) {
      if (st[i].qty > 0 && st[i].stop != null && bars[i].l <= st[i].stop) {
        const px = Math.min(bars[i].o, st[i].stop);
        cash += st[i].qty * px * (1 - side);
        st[i] = { qty: 0, avg: 0, stop: null };
        stops += 1;
        trades += 1;
      }
    }
    // 3) 펀딩(롱이 낸다) — 들고 있는 동안. 단순화: 그날 펀딩 합 × 그날 종가 노출
    for (let i = 0; i < names.length; i++) {
      if (st[i].qty > 0) cash -= st[i].qty * bars[i].c * (fund[i].get(Math.floor(t / DAY) * DAY) || 0);
    }
    // 4) 종가: 순자산·정지 장치
    const gross = st.reduce((s, x, i) => s + x.qty * bars[i].c, 0);
    let eq = cash + gross;
    if (eq > 0 && gross / eq > maxGross) maxGross = gross / eq;
    if (eq > peak) peak = eq;
    if (!halted && eq <= peak * (1 - p.breakerPct / 100)) {
      for (let i = 0; i < names.length; i++) if (st[i].qty > 0) { cash += st[i].qty * bars[i].c * (1 - side); st[i] = { qty: 0, avg: 0, stop: null }; }
      eq = cash;
      halted = { t, ddPct: Math.round((1 - eq / peak) * 1000) / 10 };
    }
    days.push({ t, ret: eq / prevEq - 1 });
    prevEq = eq;
    for (let i = 0; i < names.length; i++) closes[i].push(bars[i].c);
  }
  return { days, trades, stops, halted, maxGrossPct: Math.round(maxGross * 1000) / 10 };
}

// 하루 수익률 → 성적. alloc = 계좌 중 이 전략에 넣는 비율(나머지 현금, 이자 0).
function summarizeTrend(days, { alloc = 1, from = -Infinity, to = Infinity } = {}) {
  const dd = days.filter((d) => d.t >= from && d.t <= to);
  if (dd.length < 2) return null;
  const r2 = (x) => Math.round(x * 100) / 100;
  let eq = 1;
  let peak = 1;
  let mdd = 0;
  const months = new Map();
  const years = new Map();
  for (const d of dd) {
    const before = eq;
    eq *= 1 + alloc * d.ret;
    if (eq > peak) peak = eq;
    if ((peak - eq) / peak > mdd) mdd = (peak - eq) / peak;
    const dt = new Date(d.t);
    const mk = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
    const m = months.get(mk) || { start: before, end: before };
    m.end = eq;
    months.set(mk, m);
    const yk = mk.slice(0, 4);
    const y = years.get(yk) || { start: before, end: before };
    y.end = eq;
    years.set(yk, y);
  }
  const mret = [...months.values()].map((m) => (m.end / m.start - 1) * 100);
  const yrs = (dd[dd.length - 1].t - dd[0].t) / (365.25 * DAY);
  const pos = mret.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const neg = Math.abs(mret.filter((x) => x < 0).reduce((a, b) => a + b, 0));
  return {
    cagrPct: yrs > 0 ? r2((Math.pow(eq, 1 / yrs) - 1) * 100) : null,
    totalPct: r2((eq - 1) * 100),
    maxDrawdownPct: r2(mdd * 100),
    positiveMonthsPct: r2((mret.filter((x) => x > 0).length / mret.length) * 100),
    worstMonthPct: r2(Math.min(...mret)),
    monthlyPF: neg > 0 ? r2(pos / neg) : null,
    byYear: Object.fromEntries([...years.entries()].map(([k, v]) => [k, r2((v.end / v.start - 1) * 100)])),
  };
}

// 최대 낙폭이 maxDD% 이하가 되는 가장 큰 비중(5% 단위)
function allocForDrawdown(days, maxDD = 15, opts = {}) {
  for (let a = 1; a > 0.001; a -= 0.05) {
    const s = summarizeTrend(days, { ...opts, alloc: a });
    if (s && s.maxDrawdownPct <= maxDD) return { alloc: Math.round(a * 100), ...s };
  }
  return null;
}

// 여러 일 수익률 목록을 같은 비중으로 섞는다(날짜가 같은 날끼리 평균 — 매일 비중을 맞추는 포트폴리오).
// 가장 좋았던 평균 하나를 고르면 운이 섞이므로, 20~200일 다섯 개를 다 같이 쓰는 앙상블로 본다.
function blendDays(lists) {
  const by = new Map();
  for (const list of lists) for (const d of list) {
    const e = by.get(d.t) || { t: d.t, sum: 0, n: 0 };
    e.sum += d.ret;
    e.n += 1;
    by.set(d.t, e);
  }
  const need = lists.length;
  return [...by.values()].filter((e) => e.n === need).sort((a, b) => a.t - b.t).map((e) => ({ t: e.t, ret: e.sum / e.n }));
}

function buyHoldDays(daily) {
  return daily.map((b, i) => ({ t: b.t, ret: i ? b.c / daily[i - 1].c - 1 : 0 }));
}

function tradeStats(trades) {
  const w = trades.filter((t) => t.pct > 0);
  const l = trades.filter((t) => t.pct <= 0);
  const gw = w.reduce((s, t) => s + t.pct, 0);
  const gl = Math.abs(l.reduce((s, t) => s + t.pct, 0));
  return { n: trades.length, winRate: trades.length ? Math.round((w.length / trades.length) * 1000) / 10 : null, pf: gl > 0 ? Math.round((gw / gl) * 100) / 100 : null };
}

function main() {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--from');
  const fromMs = fi >= 0 ? Date.parse(`${args[fi + 1]}T00:00:00Z`) : -Infinity;
  const OOS = Date.parse('2024-01-01T00:00:00Z');
  const si = args.indexOf('--stop');
  const hardStopPct = si >= 0 ? Number(args[si + 1]) || null : null;
  const out = [];
  const log = (s = '') => { console.log(s); out.push(s); };
  if (hardStopPct) log(`보호 손절: 진입가 −${hardStopPct}%`);
  log('일봉 추세추종(롱만) — 종가가 N일 평균 위면 다음 날 시가 매수, 아래면 청산. 선물 1배, 수수료·펀딩 반영');
  const ensembles = {};
  const c = (v, w) => String(v == null ? '-' : v).padStart(w);
  const row = (label, days, extra = '') => {
    const s = summarizeTrend(days);
    const fit = allocForDrawdown(days, 15);
    const oos = summarizeTrend(days, { from: OOS });
    log(`${label.padEnd(6)}${c(s.cagrPct, 8)}${c(s.maxDrawdownPct, 8)}${c(s.positiveMonthsPct, 9)}${c(s.worstMonthPct, 8)}${c(s.monthlyPF, 6)}${extra}  │ ${fit ? `${fit.alloc}% → 연 ${fit.cagrPct}%` : '-'}   │ ${oos ? `${oos.cagrPct} · ${oos.maxDrawdownPct}` : '-'}`);
    log(`      연도별: ${Object.entries(s.byYear).map(([y, x]) => `${y} ${x}%`).join(' · ')}`);
    if (fit) log(`      비중 ${fit.alloc}% 일 때 연도별: ${Object.entries(fit.byYear).map(([y, x]) => `${y} ${x}%`).join(' · ')} · 플러스월 ${fit.positiveMonthsPct}% · 최악월 ${fit.worstMonthPct}%`);
  };
  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    const dp = path.join(DATA_DIR, `${sym}-1d.csv`);
    if (!fs.existsSync(dp)) { log(`\n${sym}: 일봉 없음 — node server/backtest/fetch-data.js 먼저`); continue; }
    const daily = E.parseCandleCsv(fs.readFileSync(dp, 'utf8')).filter((b) => b.t >= fromMs);
    const fp = path.join(DATA_DIR, `${sym}-funding.csv`);
    const funding = fs.existsSync(fp) ? parseFundingCsv(fs.readFileSync(fp, 'utf8')) : [];
    const bh = summarizeTrend(buyHoldDays(daily));
    const bhOos = summarizeTrend(buyHoldDays(daily), { from: OOS });
    log(`\n== ${sym} (${new Date(daily[0].t).toISOString().slice(0, 10)} ~ ${new Date(daily[daily.length - 1].t).toISOString().slice(0, 10)})`);
    log(`그냥 들고 있기: 연 ${bh.cagrPct}% · 최대 낙폭 ${bh.maxDrawdownPct}%  |  2024년 이후 연 ${bhOos ? bhOos.cagrPct : '-'}% · 낙폭 ${bhOos ? bhOos.maxDrawdownPct : '-'}%`);
    log(`${'평균'.padEnd(6)}${'연%'.padStart(8)}${'낙폭%'.padStart(8)}${'플러스월%'.padStart(9)}${'최악월%'.padStart(8)}${'월PF'.padStart(6)}${'거래'.padStart(5)}${'승률%'.padStart(7)}${'보유%'.padStart(7)}  │ 낙폭 15% 맞춤: 비중 → 연%   │ 2024~ 연% · 낙폭%`);
    const subs = [];
    for (const n of SMA_GRID) {
      const sim = simulateTrend(daily, funding, { sma: n, hardStopPct });
      subs.push(sim.days);
      const ts = tradeStats(sim.trades);
      row(`${n}일`, sim.days, `${c(ts.n, 5)}${c(ts.winRate, 7)}${c(sim.exposurePct, 7)}`);
    }
    ensembles[sym] = blendDays(subs);
    row('앙상블', ensembles[sym], '  (20~200일 다섯 개를 똑같이 나눠 든 것)');
  }
  if (ensembles.BTCUSDT && ensembles.ETHUSDT) {
    log('\n== BTC + ETH 반반 앙상블');
    row('반반', blendDays([ensembles.BTCUSDT, ensembles.ETHUSDT]));
  }
  log('\n읽는 법: 연% = 복리 연수익(계좌 전체를 넣었을 때). 낙폭 15% 맞춤 = 최대 낙폭이 15% 이하가 되도록 계좌 일부만 넣었을 때의 비중과 연수익.');
  log('관문(docs/00-CEO-PLAN.md): 월PF ≥ 1.3 · 최대 낙폭 ≤ 15% · 2024년 이후에도 플러스 · 이웃 평균(20~200일) 대부분이 같은 결론이어야 우연이 아니다.');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(OUT_DIR, `trend-${stamp}.md`), '```\n' + out.join('\n') + '\n```\n');
}

if (require.main === module) main();

module.exports = { DEFAULTS, SMA_GRID, simulateTrend, summarizeTrend, allocForDrawdown, buyHoldDays, tradeStats, blendDays, simulatePortfolio };

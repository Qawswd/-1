'use strict';

// toss-rules.js — 토스로만(실제 주식·ETF, 현금, 롱만, 펀딩 없음) 할 규칙을 수십 년 지수 기록으로 고른다(2026-10-31, 오너 '너가 생각한 최선의 규칙 토스로만 할 때').
// 후보와 통과 기준은 결과를 보기 전에 docs/07 '토스 전용 규칙'에 적었다 — 여기서 바꾸지 않는다.
//   T0 들고 있기 · T1 월말 10개월선(Faber 2007 — 2007년 이후는 발표 뒤) · T2 일봉 200일선 · T3 지금 규칙(50·200 · −10%/+30%) 한 칸 100% · T4 반반(T0 + T1)
//   비용 한쪽 0.1% · 현금 이자 0% · 신호는 그날 종가, 체결은 다음 날 시가(한국 17:30 주문 → 미국 장 시가)
//   node server/backtest/toss-rules.js [--dir reports/backtest/data/stocks]   # 데이터: node server/backtest/fetch-stocks.js --from 1950 ^GSPC ^IXIC SPY QQQ

const fs = require('fs');
const path = require('path');
const E = require('./engine');
const T = require('./trend');
const X = require('./exits');
const FS = require('./fetch-stocks');
const { afterTax } = require('./stock-universe');

const DAY = 86400000;
const COST = 0.001;
const SPLIT = Date.parse('2007-01-01T00:00:00Z');
const SYMBOLS = ['^GSPC', '^IXIC', 'SPY', 'QQQ'];
const LONG = { mode: 'long', stop: { k: 'pct', v: 10 }, tp: 3, trail: 'none', signalExit: true, holdDays: 0 };

const month = (t) => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };

// 신호일: 'end' = 그달 마지막 거래일(다음 봉이 다음 달인 봉 — 데이터 끝의 덜 끝난 달은 빼고) · 'mid' = 그달 15일 이후 첫 거래일
function signalDays(bars, day = 'end') {
  const out = new Set();
  for (let i = 0; i < bars.length; i++) {
    if (day === 'end') {
      if (i + 1 < bars.length && month(bars[i + 1].t) !== month(bars[i].t)) out.add(i);
    } else {
      const d = new Date(bars[i].t).getUTCDate();
      const prev = i > 0 ? bars[i - 1] : null;
      if (d >= 15 && (!prev || month(prev.t) !== month(bars[i].t) || new Date(prev.t).getUTCDate() < 15)) out.add(i);
    }
  }
  return out;
}

// 들어감/나감 전환 — wantIn(i) 가 true/false 면 다음 봉 시가에 그렇게 바꾼다(null 은 그대로). 한쪽 비용 cost.
function simulateSwitch(bars, wantIn, { cost = COST } = {}) {
  const days = [];
  let inMkt = false;
  let pending = null;
  let trades = 0;
  let daysIn = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i > 0) {
      const prevC = bars[i - 1].c;
      let ret = 0;
      if (pending != null && pending !== inMkt) {
        if (pending) {
          ret = b.c / b.o - 1 - cost;
          trades++;
        } else ret = b.o / prevC - 1 - cost;
        inMkt = pending;
      } else if (inMkt) ret = b.c / prevC - 1;
      pending = null;
      days.push({ t: b.t, ret });
      if (inMkt) daysIn++;
    }
    const w = wantIn(i);
    if (w === true || w === false) pending = w;
  }
  return { days, trades, exposurePct: bars.length > 1 ? Math.round((daysIn / (bars.length - 1)) * 1000) / 10 : null };
}

// T1: 신호일 종가가 최근 n 개 신호일 종가 평균 위면 보유
function monthlySma(bars, { months = 10, day = 'end', cost = COST } = {}) {
  const sig = signalDays(bars, day);
  const closes = [];
  return simulateSwitch(bars, (i) => {
    if (!sig.has(i)) return null;
    closes.push(bars[i].c);
    if (closes.length < months) return null;
    const avg = closes.slice(-months).reduce((a, b) => a + b, 0) / months;
    return bars[i].c > avg;
  }, { cost });
}

// T2: 매일 종가가 n일선 위면 보유
function dailySma(bars, { n = 200, cost = COST } = {}) {
  let sum = 0;
  return simulateSwitch(bars, (i) => {
    sum += bars[i].c;
    if (i >= n) sum -= bars[i - n].c;
    return i >= n - 1 ? bars[i].c > sum / n : null;
  }, { cost });
}

function hold(bars, { cost = COST } = {}) {
  return { days: bars.slice(1).map((b, i) => ({ t: b.t, ret: b.c / bars[i].c - 1 - (i === 0 ? cost : 0) })), trades: 1, exposurePct: 100 };
}

// T4: 두 몫을 from 에서 반씩 넣고 따로 굴린다(다시 맞추지 않음) → 합친 하루 수익
function halfHalf(a, b, from) {
  const bm = new Map(b.filter((d) => d.t >= from).map((d) => [d.t, d.ret]));
  let ea = 0.5;
  let eb = 0.5;
  const out = [];
  for (const d of a.filter((x) => x.t >= from)) {
    const before = ea + eb;
    ea *= 1 + d.ret;
    eb *= 1 + (bm.get(d.t) || 0);
    out.push({ t: d.t, ret: (ea + eb) / before - 1 });
  }
  return out;
}

// 고점에서 다시 고점까지 가장 긴 날(달력) — 끝까지 회복 못 했으면 끝날까지
function longestUnderwater(days, from = -Infinity, to = Infinity) {
  const xs = days.filter((d) => d.t >= from && d.t <= to);
  let eq = 1;
  let peak = 1;
  let peakT = xs.length ? xs[0].t : 0;
  let worst = 0;
  for (const d of xs) {
    eq *= 1 + d.ret;
    if (eq >= peak) {
      peak = eq;
      peakT = d.t;
    } else worst = Math.max(worst, Math.round((d.t - peakT) / DAY));
  }
  return worst;
}

function stats(days, from, to, trades) {
  const s = T.summarizeTrend(days, { from, to });
  if (!s) return null;
  const yrs = (Math.min(to, days[days.length - 1].t) - Math.max(from, days[0].t)) / (365.25 * DAY);
  const years = Object.values(s.byYear);
  return {
    cagr: s.cagrPct,
    dd: s.maxDrawdownPct,
    calmar: s.maxDrawdownPct > 0 ? Math.round((s.cagrPct / s.maxDrawdownPct) * 100) / 100 : null,
    under: longestUnderwater(days, from, to),
    worstYear: years.length ? Math.min(...years) : null,
    tradesPerYear: trades != null && yrs > 0 ? Math.round((trades / yrs) * 10) / 10 : null,
  };
}

// 통과 기준(docs/07): ① 최대 손실 ≤ 들고 있기의 2/3 ② 칼마 > 들고 있기 ③ 연% ≥ 들고 있기 − 3%p
function judge(rule, base) {
  if (!rule || !base) return ['데이터 없음'];
  const why = [];
  if (!(rule.dd <= (base.dd * 2) / 3)) why.push(`손실 −${rule.dd}% > 들고 있기 −${base.dd}%의 2/3`);
  if (!(rule.calmar > base.calmar)) why.push(`칼마 ${rule.calmar} ≤ ${base.calmar}`);
  if (!(rule.cagr >= base.cagr - 3)) why.push(`연 ${rule.cagr}% < ${base.cagr}% − 3`);
  return why;
}

function load(dir, sym) {
  const p = path.join(dir, `${FS.fileKey(sym)}-1d.csv`);
  if (!fs.existsSync(p)) return null;
  const rows = E.parseCandleCsv(fs.readFileSync(p, 'utf8'));
  return FS.looksDaily(rows) ? rows : null;
}

function runSymbol(bars) {
  const from = bars[Math.min(bars.length - 1, 260)].t; // 200일선 · 12개월 평균이 다 생긴 뒤부터 같은 날에 잰다
  const t1 = monthlySma(bars);
  const t0 = hold(bars);
  const rules = {
    T0: t0,
    T1: t1,
    T2: dailySma(bars),
    T3: (() => { const r = X.simulateExits(bars, { ...LONG, cost: COST }); return { days: r.days, trades: r.trades.length, exposurePct: null }; })(),
    T4: { days: halfHalf(t0.days, t1.days, from), trades: t1.trades, exposurePct: null }, // 절반 몫이 T1 과 같은 날 사고판다
  };
  const neighbors = [];
  for (const months of [8, 10, 12]) for (const day of ['end', 'mid']) neighbors.push({ months, day, r: monthlySma(bars, { months, day }) });
  const periods = [['전체', from, Infinity], ['~2006', from, SPLIT - 1], ['2007~', SPLIT, Infinity]];
  const out = {};
  for (const [k, r] of Object.entries(rules)) out[k] = Object.fromEntries(periods.map(([p, a, b]) => [p, stats(r.days, a, b, r.trades)]));
  out.neighbors = neighbors.map((n) => ({ months: n.months, day: n.day, ...Object.fromEntries(periods.map(([p, a, b]) => [p, stats(n.r.days, a, b, n.r.trades)])) }));
  out.from = from;
  out.exposureT1 = t1.exposurePct;
  out.exposureT2 = rules.T2.exposurePct;
  out.days = { T0: t0.days, T1: t1.days };
  return out;
}

const NAMES = { T0: 'T0 들고 있기', T1: 'T1 월말 10개월선', T2: 'T2 일봉 200일선', T3: 'T3 지금 규칙(50·200)', T4: 'T4 반반(T0+T1)' };

function main() {
  const argv = process.argv.slice(2);
  const dir = path.resolve(argv.indexOf('--dir') >= 0 ? argv[argv.indexOf('--dir') + 1] : FS.OUT_DIR);
  const out = [];
  const log = (s = '') => { console.log(s); out.push(s); };
  const res = {};
  for (const sym of SYMBOLS) {
    const bars = load(dir, sym);
    if (bars && bars.length > 600) res[sym] = runSymbol(bars);
  }
  if (!Object.keys(res).length) return log('지수 일봉 없음 — node server/backtest/fetch-stocks.js --from 1950 ^GSPC ^IXIC SPY QQQ 먼저');
  const miss = SYMBOLS.filter((s) => !res[s]);
  log(`토스 전용 규칙 — 지수 ${Object.keys(res).length}개${miss.length ? ` (없음: ${miss.join(' ')} — 통과 판정 못 함)` : ''} · 비용 한쪽 0.1% · 현금 이자 0% · 다음 날 시가 체결`);
  log('표기: 연% / 최대 손실 / 칼마 / 가장 길게 물린 날 / 최악의 해 / 1년 매매 수');
  const f = (s) => (s ? `${s.cagr}% / −${s.dd}% / ${s.calmar} / ${s.under}일 / ${s.worstYear}% / ${s.tradesPerYear ?? '-'}번` : '-');
  for (const [sym, r] of Object.entries(res)) {
    log(`\n${FS.labelOf(FS.fileKey(sym))} — ${new Date(r.from).toISOString().slice(0, 10)}~ · 시장에 있던 날 T1 ${r.exposureT1}% · T2 ${r.exposureT2}%`);
    for (const k of Object.keys(NAMES)) log(`  ${NAMES[k]}: 전체 ${f(r[k]['전체'])} | ~2006 ${f(r[k]['~2006'])} | 2007~ ${f(r[k]['2007~'])}`);
    log(`  T1 이웃(연% / 최대 손실, 전체 · 2007~): ${r.neighbors.map((n) => `${n.months}개월 ${n.day === 'end' ? '월말' : '15일'} ${n['전체'] ? `${n['전체'].cagr}/−${n['전체'].dd}` : '-'} · ${n['2007~'] ? `${n['2007~'].cagr}/−${n['2007~'].dd}` : '-'}`).join(' | ')}`);
  }
  // 판정 — 네 지수 × 두 기간(~2006 · 2007~)
  log('\n판정(docs/07 통과 기준 — 네 지수 × ~2006·2007~ 모두):');
  const passed = [];
  for (const k of ['T1', 'T4', 'T2', 'T3']) {
    const fails = [];
    if (miss.length) fails.push(`데이터 없음 ${miss.join(' ')}`);
    for (const [sym, r] of Object.entries(res)) for (const p of ['~2006', '2007~']) {
      const why = judge(r[k][p], r.T0[p]);
      if (why.length) fails.push(`${FS.labelOf(FS.fileKey(sym))} ${p}: ${why.join(', ')}`);
      if (r[k][p] && r[k][p].tradesPerYear > 4) fails.push(`${FS.labelOf(FS.fileKey(sym))} ${p}: 1년 ${r[k][p].tradesPerYear}번 > 4`);
    }
    if (k === 'T1') for (const [sym, r] of Object.entries(res)) for (const n of r.neighbors) for (const p of ['~2006', '2007~']) {
      const why = judge(n[p], r.T0[p]);
      if (why.length) fails.push(`${FS.labelOf(FS.fileKey(sym))} 이웃 ${n.months}개월 ${n.day === 'end' ? '월말' : '15일'} ${p}: ${why.join(', ')}`);
    }
    if (!fails.length) passed.push(k);
    log(`  ${NAMES[k]}: ${fails.length ? `탈락 — ${fails.length}곳. 예) ${fails.slice(0, 4).join(' · ')}` : '통과'}`);
  }
  log(`  → 토스 규칙: ${passed.length ? NAMES[passed[0]] : 'T0 지수 사서 들고 있기(매달 같은 금액 사기) — 통과한 규칙 없음'}`);
  // 세금(참고, 2007~, 시작 1,000만·3,000만 원): 들고 있기는 마지막에 한 번 팔 때, T1 은 해마다(안 판 것 포함 근사)
  for (const sym of ['SPY', 'QQQ']) {
    const r = res[sym];
    if (!r) continue;
    const parts = [];
    for (const k of [1e7, 3e7]) {
      const h = T.summarizeTrend(r.days.T0, { from: SPLIT });
      const xs = r.days.T0.filter((d) => d.t >= SPLIT);
      const yrs = (xs[xs.length - 1].t - xs[0].t) / (365.25 * DAY);
      const end = k * (1 + h.totalPct / 100);
      const holdAfter = Math.round((Math.pow((end - Math.max(0, end - k - 2.5e6) * 0.22) / k, 1 / yrs) - 1) * 1000) / 10;
      const t1 = afterTax(r.days.T1, SPLIT, k);
      parts.push(`시작 ${k / 1e4}만 원 들고 있기 ${holdAfter}% · T1 ${t1 ? t1.cagrPct : '-'}%`);
    }
    log(`  세후 연%(2007~, 참고) ${sym}: ${parts.join(' | ')}`);
  }
  if (!process.env.NODE_TEST_CONTEXT) {
    fs.mkdirSync(path.join(__dirname, '..', '..', 'reports', 'backtest', 'results'), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.writeFileSync(path.join(__dirname, '..', '..', 'reports', 'backtest', 'results', `toss-rules-${stamp}.md`), '```\n' + out.join('\n') + '\n```\n');
  }
}

if (require.main === module) main();

module.exports = { signalDays, simulateSwitch, monthlySma, dailySma, hold, halfHalf, longestUnderwater, judge, runSymbol };

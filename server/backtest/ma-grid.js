'use strict';

// ma-grid.js — 이평선 두 개 '신호등' 규칙의 설정값 비교(2026-10-23, 오너 "꼭 50·200이어야 해? 60·240 등 분석해서 알려줘").
// 규칙(오너 단타 방향 필터): 마감된 일봉 종가가 두 선 모두 위 → 다음 날 롱, 모두 아래 → 숏, 사이 → 쉼(1배).
// 비용: 비중이 바뀐 만큼 한쪽 0.05% · 코인은 실제 펀딩(롱이 내고 숏이 받는다), 주식은 펀딩 없음.
// 보는 것: 연%·최대 손실·칼마(연%÷최대 손실) — 전체 / 만들기(2020~23) / 시험(2024~), 시장에 있던 비율,
//          신호 다음 7일 수익(단타 1주일 기준): 초록(롱) 신호 평균과 빨강(숏) 신호 평균.
// 한 조합만 좋은 건 우연 — 이웃 조합이 다 비슷한지(넓은 고원)를 본다.
//   node server/backtest/ma-grid.js                 # BTC·ETH (로컬 데이터)
//   node server/backtest/ma-grid.js --type ema      # 선 종류: sma(기본) · ema · smma
//   node server/backtest/ma-grid.js --stocks SPY QQQ NVDA   # 서버: reports/backtest/data/stocks 또는 tradfi 의 일봉

const fs = require('fs');
const path = require('path');
const E = require('./engine');
const T = require('./trend');
const { parseFundingCsv } = require('./carry');

const DATA = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data');
const OUT_DIR = path.join(DATA, '..', 'results');
const DAY = 86400000;
const IS_END = Date.parse('2024-01-01T00:00:00Z');
const FAST = [10, 20, 30, 40, 50, 60, 80, 100];
const SLOW = [100, 120, 150, 180, 200, 240, 300];

// 이동평균 시리즈(i 번째 = i 번째 종가까지). 모자라면 null.
function maSeries(closes, n, type = 'sma') {
  const out = new Array(closes.length).fill(null);
  if (type === 'sma') {
    let s = 0;
    for (let i = 0; i < closes.length; i++) {
      s += closes[i];
      if (i >= n) s -= closes[i - n];
      if (i >= n - 1) out[i] = s / n;
    }
    return out;
  }
  // ema: α = 2/(n+1), smma(와일더): α = 1/n — 첫 값은 앞 n 개의 단순 평균
  const a = type === 'smma' ? 1 / n : 2 / (n + 1);
  let v = null;
  for (let i = 0; i < closes.length; i++) {
    if (i === n - 1) v = closes.slice(0, n).reduce((x, y) => x + y, 0) / n;
    else if (i >= n) v = v + a * (closes[i] - v);
    out[i] = v;
  }
  return out;
}

// 신호등 규칙 하루 수익률. bars: [{t,c}] 시간순, fundDay: Map(UTC 날짜 → 그날 펀딩 합)
function simulateLights(bars, fast, slow, { type = 'sma', cost = 0.0005, fundDay = null, longOnly = false } = {}) {
  const closes = bars.map((b) => b.c);
  const f = maSeries(closes, fast, type);
  const s = maSeries(closes, slow, type);
  const days = [];
  const fwd = { green: [], red: [] };
  let pos = 0;
  for (let i = 1; i < bars.length; i++) {
    const r = closes[i] / closes[i - 1] - 1;
    const fund = fundDay ? fundDay.get(Math.floor(bars[i].t / DAY) * DAY) || 0 : 0;
    // 어제 종가로 정한 pos 가 오늘 수익을 받는다
    let ret = pos * r - pos * fund;
    // 오늘 종가로 내일 비중을 정한다
    let next = 0;
    if (f[i] != null && s[i] != null) {
      if (closes[i] > f[i] && closes[i] > s[i]) next = 1;
      else if (closes[i] < f[i] && closes[i] < s[i]) next = longOnly ? 0 : -1;
      const ahead = i + 7 < bars.length ? closes[i + 7] / closes[i] - 1 : null;
      if (ahead != null && next === 1) fwd.green.push(ahead);
      if (ahead != null && closes[i] < f[i] && closes[i] < s[i]) fwd.red.push(ahead);
    }
    ret -= Math.abs(next - pos) * cost;
    pos = next;
    days.push({ t: bars[i].t, ret, inMarket: pos !== 0 });
  }
  return { days, fwd };
}

// 그냥 들고 있기(항상 롱 1배) — 첫날 비용 한 번, 코인은 펀딩을 낸다. 이걸 못 이기면 선은 필요 없다.
function simulateHold(bars, { cost = 0.0005, fundDay = null } = {}) {
  const days = [];
  for (let i = 1; i < bars.length; i++) {
    const fund = fundDay ? fundDay.get(Math.floor(bars[i].t / DAY) * DAY) || 0 : 0;
    days.push({ t: bars[i].t, ret: bars[i].c / bars[i - 1].c - 1 - fund - (i === 1 ? cost : 0), inMarket: true });
  }
  return days;
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

function stats(days, from = -Infinity, to = Infinity) {
  const s = T.summarizeTrend(days, { from, to });
  if (!s) return null;
  return { cagr: s.cagrPct, dd: s.maxDrawdownPct, calmar: s.maxDrawdownPct > 0 ? r2(s.cagrPct / s.maxDrawdownPct) : null };
}

function loadCoins() {
  const out = [];
  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    const p = path.join(DATA, `${sym}-1d.csv`);
    if (!fs.existsSync(p)) continue;
    const bars = E.parseCandleCsv(fs.readFileSync(p, 'utf8'));
    const fp = path.join(DATA, `${sym}-funding.csv`);
    const fundDay = new Map();
    if (fs.existsSync(fp)) for (const x of parseFundingCsv(fs.readFileSync(fp, 'utf8'))) { const k = Math.floor(x.t / DAY) * DAY; fundDay.set(k, (fundDay.get(k) || 0) + x.rate); }
    out.push({ name: sym.replace('USDT', ''), bars, fundDay });
  }
  return out;
}

function loadStocks(keys) {
  const out = [];
  for (const k of keys) {
    const cands = [path.join(DATA, 'stocks', `${k}-1d.csv`), path.join(DATA, 'tradfi', `${k}-1d.csv`)];
    const p = cands.find((x) => fs.existsSync(x));
    if (!p) continue;
    out.push({ name: k, bars: E.parseCandleCsv(fs.readFileSync(p, 'utf8')).filter((b) => b.t >= Date.parse('2015-01-01')), fundDay: null });
  }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const ti = argv.indexOf('--type');
  const type = ti >= 0 ? argv[ti + 1] : 'sma';
  const si = argv.indexOf('--stocks');
  const assets = si >= 0 ? loadStocks(argv.slice(si + 1).filter((x) => !x.startsWith('--')).map((x) => x.toUpperCase())) : loadCoins();
  const out = [];
  const log = (s = '') => { console.log(s); out.push(s); };
  if (!assets.length) return log('데이터 없음');
  const isStock = si >= 0;
  const cost = 0.0005;
  log(`이평선 신호등(두 선 모두 위 롱 · 모두 아래 숏 · 사이 쉼) · 선 ${type.toUpperCase()} · ${assets.map((a) => a.name).join('·')} 같은 몫 · 비용 한쪽 ${cost * 100}%${isStock ? '' : ' + 실제 펀딩'}`);
  const rows = [];
  for (const fast of FAST) for (const slow of SLOW) {
    if (fast >= slow) continue;
    for (const longOnly of [false, true]) {
      const per = assets.map((a) => simulateLights(a.bars, fast, slow, { type, cost, fundDay: a.fundDay, longOnly }));
      const days = T.blendDays(per.map((x) => x.days));
      const green = avg(per.flatMap((x) => x.fwd.green));
      const red = avg(per.flatMap((x) => x.fwd.red));
      const inMkt = avg(per.map((x) => x.days.filter((d) => d.inMarket).length / x.days.length));
      rows.push({ fast, slow, longOnly, all: stats(days), is: stats(days, -Infinity, IS_END - 1), oos: stats(days, IS_END), green: r2(green * 100), red: r2(red * 100), inMkt: r2(inMkt * 100) });
    }
  }
  const pick = (lo) => rows.filter((r) => r.longOnly === lo);
  for (const lo of [false, true]) {
    log(`\n[${lo ? '롱만(아래면 쉼)' : '롱·숏'}] 칼마 — 행: 짧은 선, 열: 긴 선 · 칸 = 전체 / 만들기 / 시험`);
    log(`짧은\\긴 ${SLOW.map((s) => String(s).padStart(16)).join('')}`);
    for (const fast of FAST) {
      const cells = SLOW.map((slow) => {
        const r = pick(lo).find((x) => x.fast === fast && x.slow === slow);
        return r ? `${r.all.calmar}/${r.is.calmar}/${r.oos.calmar}`.padStart(16) : ''.padStart(16);
      });
      log(`${String(fast).padStart(7)} ${cells.join('')}`);
    }
  }
  log('\n신호 다음 7일 수익 평균(%) — 초록(롱 신호) / 빨강(숏 신호, 음수일수록 숏에 유리) · 시장에 있던 비율(롱·숏)');
  log(`짧은\\긴 ${SLOW.map((s) => String(s).padStart(18)).join('')}`);
  for (const fast of FAST) {
    const cells = SLOW.map((slow) => {
      const r = pick(false).find((x) => x.fast === fast && x.slow === slow);
      return r ? `${r.green}/${r.red}·${Math.round(r.inMkt)}%`.padStart(18) : ''.padStart(18);
    });
    log(`${String(fast).padStart(7)} ${cells.join('')}`);
  }
  const warm = Math.max(...SLOW);
  const base = avg(assets.flatMap((a) => a.bars.slice(warm, -7).map((b, i) => a.bars[warm + i + 7].c / b.c - 1)));
  log(`기준: 아무 날이나 7일 들고 있었을 때 평균 ${r2(base * 100)}%`);
  const best =(lo, key) => [...pick(lo)].sort((a, b) => (b[key].calmar ?? -9) - (a[key].calmar ?? -9))[0];
  for (const lo of [false, true]) {
    const bIs = best(lo, 'is');
    const ref = pick(lo).find((x) => x.fast === 50 && x.slow === 200);
    log(`\n${lo ? '롱만' : '롱·숏'}: 만들기 구간 최고 = ${bIs.fast}·${bIs.slow} (만들기 칼마 ${bIs.is.calmar} → 시험 ${bIs.oos.calmar}) · 50·200 = 전체 ${ref.all.calmar} / 만들기 ${ref.is.calmar} / 시험 ${ref.oos.calmar} · 연 ${ref.all.cagr}% / 최대 손실 −${ref.all.dd}%`);
  }
  // 같은 출발선(가장 긴 선이 다 찬 뒤)에서 그냥 들고 있기와 비교 — 종목별로도
  const start = Math.max(...assets.map((a) => a.bars[Math.min(a.bars.length - 1, warm)].t));
  const cal = (s) => (s ? s.calmar : '-');
  const row = (name, days) => {
    const s = stats(days, start);
    log(`  ${name.padEnd(12)} ${s ? `연 ${s.cagr}% · 최대 손실 −${s.dd}% · 칼마 ${s.calmar}` : '데이터 없음'} | 만들기 ${cal(stats(days, start, IS_END - 1))} / 시험 ${cal(stats(days, Math.max(start, IS_END)))}`);
  };
  log(`\n그냥 들고 있기와 비교 — ${new Date(start).toISOString().slice(0, 10)}부터 같은 출발선`);
  const groups = [{ name: '같은 몫 섞기', list: assets }, ...(assets.length > 1 ? assets.map((a) => ({ name: a.name, list: [a] })) : [])];
  for (const g of groups) {
    log(`[${g.name}]`);
    const run = (fn) => T.blendDays(g.list.map(fn));
    row('그냥 들고 있기', run((a) => simulateHold(a.bars, { cost, fundDay: a.fundDay })));
    row('50·200 롱만', run((a) => simulateLights(a.bars, 50, 200, { type, cost, fundDay: a.fundDay, longOnly: true }).days));
    row('50·200 롱·숏', run((a) => simulateLights(a.bars, 50, 200, { type, cost, fundDay: a.fundDay }).days));
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(OUT_DIR, `ma-grid-${type}-${stamp}.md`), '```\n' + out.join('\n') + '\n```\n');
}

if (require.main === module) main();

module.exports = { maSeries, simulateLights, simulateHold, loadCoins, loadStocks };

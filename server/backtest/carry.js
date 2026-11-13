'use strict';

// backtest/carry.js — 펀딩비 차익(현물 매수 + 무기한 선물 같은 수량 매도) 백테스트. 2026-10-13 대표이사 제안,
// 오너 승인. AI 판정이 성적표에서 우위를 못 보여(17건 2승 15패) "손실 거의 0" 조건에 가장 가까운 구조부터 본다.
//
// 구조: 가격이 오르면 현물이 벌고 선물 숏이 같은 만큼 잃는다(반대도 같다) → 방향 손익은 상쇄.
// 남는 것: 펀딩비(양수면 숏이 받는다) − 진입·청산 수수료 − 베이시스(현물·선물 가격 차) 변화.
// 레버리지 1배 고정(exchange.HARD_LEVERAGE)이라 선물 증거금 = 명목가 → 자본 2 로 명목 1 을 든다.
// 그래서 자본 대비 수익은 명목 대비 펀딩 수익의 절반이다(지어내지 않고 그대로 보여준다).
//
//   node server/backtest/carry.js                 # BTC·ETH, 항상 보유 + 켜고 끄기 변형들
//   node server/backtest/carry.js --from 2024-01-01
//
// 한계: 현물 가격 기록이 없어 베이시스 변화는 0 으로 둔다(펀딩이 높을 때 들어가 낮을 때 나오면 보통 이득 쪽이라
// 켜고 끄기 변형에는 보수적인 가정). 펀딩비 자체가 미래에도 이 수준이라는 보장은 없다.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data');
const OUT_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'results');

// 수수료(%, 한쪽): 현물 테이커 0.10 · 선물 테이커 0.05 · 슬리피지 다리마다 0.02.
// 진입 = 현물 매수 + 선물 매도, 청산 = 반대 → 왕복 (0.12 + 0.07) × 2 = 0.38% (명목 대비)
const DEFAULTS = Object.freeze({
  spotFeePct: 0.1,
  perpFeePct: 0.05,
  slipPct: 0.02,
  capitalPerNotional: 2, // 1배: 현물 1 + 선물 증거금 1
  mode: 'always', // 'always' | 'switch'
  lookbackEvents: 9, // 켜고 끄기 판단에 쓰는 직전 펀딩 횟수(9 = 3일)
  enterAvgPct: 0.01, // 직전 평균 펀딩(8시간당 %)이 이 이상이면 진입
  exitAvgPct: 0, // 직전 평균이 이 이하로 내려가면 청산
});

const VARIANTS = Object.freeze([
  { name: '항상 보유', mode: 'always' },
  { name: '켜고끄기 3일 평균 ≥0.01%', mode: 'switch', lookbackEvents: 9, enterAvgPct: 0.01, exitAvgPct: 0 },
  { name: '켜고끄기 3일 평균 ≥0.02%', mode: 'switch', lookbackEvents: 9, enterAvgPct: 0.02, exitAvgPct: 0.005 },
  { name: '켜고끄기 7일 평균 ≥0.01%', mode: 'switch', lookbackEvents: 21, enterAvgPct: 0.01, exitAvgPct: 0 },
  { name: '켜고끄기 7일 평균 ≥0.02%', mode: 'switch', lookbackEvents: 21, enterAvgPct: 0.02, exitAvgPct: 0.005 },
]);

// "t,rate" CSV → [{t, rate}] (rate 는 소수, 0.0001 = 0.01%). 깨진 줄은 건너뛴다.
function parseFundingCsv(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line || /^t\s*,/.test(line)) continue;
    const [t, r] = line.split(',');
    const row = { t: Number(t), rate: Number(r) };
    if (Number.isFinite(row.t) && Number.isFinite(row.rate)) out.push(row);
  }
  out.sort((a, b) => a.t - b.t);
  return out.filter((r, i) => i === 0 || r.t !== out[i - 1].t);
}

function monthKey(t) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// 펀딩 기록을 시간순으로 걷는다. 판단은 그 시각 전까지의 기록만 쓴다(미래를 보지 않는다).
// 진입은 펀딩 i 직후(그 다음 펀딩부터 받는다), 청산도 펀딩 i 를 받은 직후.
// 반환: 자본 대비 % 로 적은 사건 목록 [{t, kind:'funding'|'cost', pct}] 와 진입 횟수.
function simulateCarry(funding, params = {}) {
  const p = { ...DEFAULTS, ...params };
  const legCost = p.spotFeePct + p.perpFeePct + 2 * p.slipPct; // 한 번 진입(또는 청산)에 명목 대비 %
  const toCap = 1 / p.capitalPerNotional;
  const events = [];
  let inPos = false;
  let entries = 0;
  let heldEvents = 0;
  const avgBefore = (i) => {
    const from = Math.max(0, i - p.lookbackEvents);
    if (i - from < p.lookbackEvents) return null;
    let s = 0;
    for (let k = from; k < i; k++) s += funding[k].rate;
    return (s / (i - from)) * 100;
  };
  for (let i = 0; i < funding.length; i++) {
    const f = funding[i];
    if (inPos) {
      events.push({ t: f.t, kind: 'funding', pct: f.rate * 100 * toCap });
      heldEvents += 1;
      if (p.mode === 'switch') {
        const a = avgBefore(i + 1);
        if (a != null && a <= p.exitAvgPct) {
          events.push({ t: f.t, kind: 'cost', pct: -legCost * toCap });
          inPos = false;
        }
      }
    } else {
      const go = p.mode === 'always' ? true : (() => { const a = avgBefore(i + 1); return a != null && a >= p.enterAvgPct; })();
      if (go) {
        events.push({ t: f.t, kind: 'cost', pct: -legCost * toCap });
        inPos = true;
        entries += 1;
      }
    }
  }
  // 기간 끝에 들고 있으면 청산 비용까지 반영해 끝낸다(좋게만 보이지 않게)
  if (inPos && funding.length) events.push({ t: funding[funding.length - 1].t, kind: 'cost', pct: -legCost * toCap });
  return { events, entries, timeInMarketPct: funding.length ? Math.round((heldEvents / funding.length) * 1000) / 10 : 0 };
}

// 사건 목록 → 성적. 수익은 단리(명목을 처음 자본 기준으로 고정)로 더한다 — 복리로 부풀리지 않는다.
function summarizeCarry(events, { from = -Infinity, to = Infinity } = {}) {
  const ev = events.filter((e) => e.t >= from && e.t <= to);
  const r2 = (x) => Math.round(x * 100) / 100;
  if (!ev.length) return null;
  let cum = 0;
  let peak = 0;
  let dd = 0;
  const months = new Map();
  const years = new Map();
  for (const e of ev) {
    cum += e.pct;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
    const mk = monthKey(e.t);
    months.set(mk, (months.get(mk) || 0) + e.pct);
    const yk = mk.slice(0, 4);
    years.set(yk, (years.get(yk) || 0) + e.pct);
  }
  // 포지션이 없던 달도 0% 로 넣는다(빠뜨리면 켜고 끄기 변형의 월평균이 부풀려진다)
  const [fy, fm] = monthKey(ev[0].t).split('-').map(Number);
  const [ly, lm] = monthKey(ev[ev.length - 1].t).split('-').map(Number);
  for (let y = fy, m = fm; y < ly || (y === ly && m <= lm); m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    if (!months.has(k)) months.set(k, 0);
  }
  const mv = [...months.values()];
  const pos = mv.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const neg = Math.abs(mv.filter((x) => x < 0).reduce((a, b) => a + b, 0));
  const spanYears = (ev[ev.length - 1].t - ev[0].t) / (365.25 * 86400000) || null;
  return {
    totalPct: r2(cum),
    annualPct: spanYears ? r2(cum / spanYears) : null,
    monthlyAvgPct: r2(cum / mv.length),
    months: mv.length,
    positiveMonthsPct: r2((mv.filter((x) => x > 0).length / mv.length) * 100),
    worstMonthPct: r2(Math.min(...mv)),
    bestMonthPct: r2(Math.max(...mv)),
    monthlyPF: neg > 0 ? r2(pos / neg) : null,
    maxDrawdownPct: r2(dd),
    byYear: Object.fromEntries([...years.entries()].map(([k, v]) => [k, r2(v)])),
  };
}

// 1배 선물 숏이 청산되려면 가격이 대략 2배가 돼야 한다. 그 전에 현물 일부를 팔아 선물 증거금으로 옮기고 숏을
// 같은 만큼 줄여(헤지 유지) 맞춰야 한다. N일 안에 가장 크게 오른 비율로 "얼마나 자주 맞춰야 하나"를 본다.
// 청산은 마지막 체결가가 아니라 마크가격 기준이라 순간 꼬리(예: 2020-03-13 ETH 선물 고가 323, 종가 134)
// 대신 일봉 종가로 잰다.
function maxRiseWithin(daily, days = 30) {
  let worst = 0;
  for (let i = 0; i < daily.length; i++) {
    const base = daily[i].c;
    let hi = base;
    for (let k = i + 1; k < Math.min(daily.length, i + 1 + days); k++) if (daily[k].c > hi) hi = daily[k].c;
    const rise = ((hi - base) / base) * 100;
    if (rise > worst) worst = rise;
  }
  return Math.round(worst * 10) / 10;
}

function fundingStats(funding, from = -Infinity) {
  const f = funding.filter((x) => x.t >= from);
  if (!f.length) return null;
  const avg = (f.reduce((s, x) => s + x.rate, 0) / f.length) * 100;
  const negPct = (f.filter((x) => x.rate < 0).length / f.length) * 100;
  return { n: f.length, avgPct: Math.round(avg * 10000) / 10000, negativePct: Math.round(negPct * 10) / 10 };
}

function renderRow(name, s) {
  if (!s) return `${name.padEnd(22)} 데이터 없음`;
  const c = (v, w) => String(v == null ? '-' : v).padStart(w);
  return `${name.padEnd(22)}${c(s.annualPct, 7)}${c(s.monthlyAvgPct, 7)}${c(s.positiveMonthsPct, 7)}${c(s.worstMonthPct, 7)}${c(s.maxDrawdownPct, 7)}${c(s.monthlyPF, 7)}`;
}

function main() {
  const args = process.argv.slice(2);
  const fi = args.indexOf('--from');
  const fromMs = fi >= 0 ? Date.parse(`${args[fi + 1]}T00:00:00Z`) : -Infinity;
  const E = require('./engine');
  const OOS = Date.parse('2024-01-01T00:00:00Z');
  const out = [];
  const log = (s = '') => { console.log(s); out.push(s); };
  log('펀딩비 차익 백테스트 — 현물 매수 + 선물 같은 수량 매도, 레버리지 1배(자본 2 로 명목 1)');
  log('수익은 자본 대비 %, 단리. 비용: 왕복 0.38%(명목 대비). 베이시스 변화는 기록이 없어 0 으로 둠');
  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    const fp = path.join(DATA_DIR, `${sym}-funding.csv`);
    if (!fs.existsSync(fp)) { log(`\n${sym}: 펀딩 기록 없음(${fp}) — node server/backtest/fetch-data.js 먼저`); continue; }
    const funding = parseFundingCsv(fs.readFileSync(fp, 'utf8')).filter((x) => x.t >= fromMs);
    const dp = path.join(DATA_DIR, `${sym}-1d.csv`);
    const daily = fs.existsSync(dp) ? E.parseCandleCsv(fs.readFileSync(dp, 'utf8')).filter((x) => x.t >= fromMs) : [];
    const fs1 = fundingStats(funding);
    const fs2 = fundingStats(funding, OOS);
    log(`\n== ${sym} (${new Date(funding[0].t).toISOString().slice(0, 10)} ~ ${new Date(funding[funding.length - 1].t).toISOString().slice(0, 10)}, 펀딩 ${fs1.n}회)`);
    log(`펀딩 평균 8시간당 ${fs1.avgPct}% · 음수 비율 ${fs1.negativePct}%  |  2024년 이후 ${fs2 ? `${fs2.avgPct}% · 음수 ${fs2.negativePct}%` : '-'}`);
    if (daily.length) {
      log(`종가 기준 최대 상승: 하루 ${maxRiseWithin(daily, 1)}% · 7일 ${maxRiseWithin(daily, 7)}% · 30일 ${maxRiseWithin(daily, 30)}% ` +
        `(1배 숏은 약 +100% 에서 청산 — 상승이 +30% 를 넘을 때마다 증거금을 맞추면 여유)`);
    }
    log(`${'변형'.padEnd(22)}${'연%'.padStart(7)}${'월평균%'.padStart(7)}${'플러스월%'.padStart(7)}${'최악월%'.padStart(7)}${'최대낙폭%'.padStart(7)}${'월PF'.padStart(7)}`);
    for (const v of VARIANTS) {
      const sim = simulateCarry(funding, v);
      const all = summarizeCarry(sim.events);
      const oos = summarizeCarry(sim.events, { from: OOS });
      log(renderRow(`${v.name}`, all) + `   진입 ${sim.entries}회 · 보유 ${sim.timeInMarketPct}%`);
      log(renderRow('  └ 2024년 이후', oos));
      log(`    연도별: ${Object.entries(all.byYear).map(([y, x]) => `${y} ${x}%`).join(' · ')}`);
    }
  }
  log('\n읽는 법: 연% = 자본 대비 1년 수익(단리). 플러스월% = 수익 난 달의 비율. 월PF = 수익 난 달 합 ÷ 손실 난 달 합.');
  log('관문(docs/00-CEO-PLAN.md): 월PF ≥ 1.3 · 최대 낙폭 ≤ 15% · 2024년 이후에도 플러스.');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(OUT_DIR, `carry-${stamp}.md`), '```\n' + out.join('\n') + '\n```\n');
}

if (require.main === module) main();

module.exports = { DEFAULTS, VARIANTS, parseFundingCsv, simulateCarry, summarizeCarry, maxRiseWithin, fundingStats, monthKey };

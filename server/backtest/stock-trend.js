'use strict';

// stock-trend.js — 코인과 같은 일봉 추세추종 규칙을 미국 주식(바이낸스 주식 선물 후보)의 긴 기록에 돌린다(2026-10-13).
//   ① 롱만(실제 운용 규칙 그대로 — trend.simulatePortfolio: 평균선 위 개수 k/5 만큼, 재난 손절 −25%, 고점 대비 −60% 정지)
//   ② 롱·숏(오너 질문 "롱 숏 다"): 비중 = (위 개수 − 아래 개수)/5 → −100% ~ +100%. 다음 날 시가 체결.
// 종목별(전체 기록)과 바구니(같은 날짜가 있는 기간)로 본다. 비용: 한쪽 0.10%(주식 선물은 호가가 얇아 코인보다 크게).
// 한계: 바이낸스 주식 선물의 펀딩비 기록이 짧아 반영하지 않는다. 미국 장이 닫힌 밤·주말 가격은 일봉에 없다.
//   node server/backtest/fetch-stocks.js && node server/backtest/stock-trend.js

const fs = require('fs');
const path = require('path');
const E = require('./engine');
const T = require('./trend');

const DATA_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data', 'stocks');
const OUT_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'results');
const COST_SIDE_PCT = 0.1;

// 롱·숏: 어제 종가까지로 정한 비중을 오늘 시가에 맞춘다. 밤사이 갭은 어제 비중, 시가→종가는 새 비중.
function simulateLongShort(daily, { smaGrid = T.SMA_GRID, costPct = COST_SIDE_PCT } = {}) {
  const n = smaGrid.length;
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
        let s = 0;
        for (let i = closes.length - L; i < closes.length; i++) s += closes[i];
        if (last > s / L) above += 1;
        else below += 1;
      }
      f = (above - below) / n;
    }
    const gap = d > 0 ? b.o / daily[d - 1].c - 1 : 0;
    const intraday = b.c / b.o - 1;
    const ret = prevF * gap + f * intraday - Math.abs(f - prevF) * (costPct / 100);
    days.push({ t: b.t, ret, f });
    prevF = f;
    closes.push(b.c);
  }
  return days;
}

function load(sym) {
  const p = path.join(DATA_DIR, `${sym}-1d.csv`);
  return fs.existsSync(p) ? E.parseCandleCsv(fs.readFileSync(p, 'utf8')) : null;
}

function row(label, s, extra = '') {
  if (!s) return `${label.padEnd(16)} 데이터 부족`;
  const c = (v, w) => String(v == null ? '-' : v).padStart(w);
  return `${label.padEnd(16)}${c(s.cagrPct, 8)}${c(s.maxDrawdownPct, 8)}${c(s.monthlyPF, 7)}${c(s.positiveMonthsPct, 9)}${c(s.worstMonthPct, 8)}${extra}`;
}

function main() {
  const syms = fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('-1d.csv')).map((f) => f.replace('-1d.csv', '')) : [];
  const out = [];
  const log = (s = '') => { console.log(s); out.push(s); };
  if (!syms.length) return log('주식 일봉 없음 — node server/backtest/fetch-stocks.js 먼저');
  const S2020 = Date.parse('2020-01-01');
  const S2024 = Date.parse('2024-01-01');
  log(`주식 추세추종 — 평균선 20·50·100·150·200일, 비용 한쪽 ${COST_SIDE_PCT}%, 펀딩 미반영`);
  log(`${'종목·방식'.padEnd(16)}${'연%'.padStart(8)}${'낙폭%'.padStart(8)}${'월PF'.padStart(7)}${'플러스월%'.padStart(9)}${'최악월%'.padStart(8)}   2020~ 연%·낙폭%   2024~ 연%·낙폭%`);
  const assets = {};
  for (const sym of syms) {
    const daily = load(sym);
    if (!daily || daily.length < 260) { log(`${sym}: 기록 부족`); continue; }
    assets[sym] = { daily, funding: [] };
    const span = `${new Date(daily[0].t).toISOString().slice(0, 4)}~`;
    const sub = (days) => {
      const a = T.summarizeTrend(days, { from: S2020 });
      const b = T.summarizeTrend(days, { from: S2024 });
      return `   ${a ? `${a.cagrPct}·${a.maxDrawdownPct}` : '-'}   ${b ? `${b.cagrPct}·${b.maxDrawdownPct}` : '-'}`;
    };
    const bh = T.buyHoldDays(daily);
    log(row(`${sym} 보유(${span})`, T.summarizeTrend(bh), sub(bh)));
    const lo = T.simulatePortfolio({ [sym]: { daily, funding: [] } }, { feePct: COST_SIDE_PCT, slipPct: 0, stopPct: 25, breakerPct: 60 });
    log(row(`${sym} 롱만`, T.summarizeTrend(lo.days), sub(lo.days) + (lo.halted ? `  ⚠ ${new Date(lo.halted.t).toISOString().slice(0, 10)} 정지(−${lo.halted.ddPct}%)` : '')));
    const ls = simulateLongShort(daily);
    log(row(`${sym} 롱·숏`, T.summarizeTrend(ls), sub(ls)));
  }
  const names = Object.keys(assets);
  const basket = (list, label) => {
    if (list.length < 2) return;
    const sub = Object.fromEntries(list.map((k) => [k, assets[k]]));
    const r = T.simulatePortfolio(sub, { feePct: COST_SIDE_PCT, slipPct: 0, stopPct: 25, breakerPct: 60 });
    const s = T.summarizeTrend(r.days);
    const a = T.summarizeTrend(r.days, { from: S2024 });
    log(`\n바구니 ${label} (${list.join('·')}, ${new Date(r.days[0].t).toISOString().slice(0, 10)}~, 롱만 같은 규칙)`);
    log(row('  바구니 롱만', s, `   2024~ ${a ? `${a.cagrPct}·${a.maxDrawdownPct}` : '-'}${r.halted ? `  ⚠ 정지 ${new Date(r.halted.t).toISOString().slice(0, 10)}` : ''}`));
    if (s) log(`  연도별: ${Object.entries(s.byYear).map(([y, x]) => `${y} ${x}%`).join(' · ')}`);
  };
  basket(names, '전체');
  if (names.includes('COIN')) basket(names.filter((x) => x !== 'COIN'), 'COIN 뺀 것(기록이 긴 기간)');
  log('\n읽는 법: 롱만이 "보유"보다 낙폭이 훨씬 작고 연%가 크게 뒤지지 않으면 쓸 만하다. 롱·숏이 롱만보다 나아야 숏을 넣을 이유가 있다.');
  log('관문(docs/00-CEO-PLAN.md): 월PF ≥ 1.3 · 2024년 이후에도 플러스 · 종목 대부분에서 같은 결론. 그다음 바이낸스 데모에서 한국 계정 주문 가능 여부 확인.');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(OUT_DIR, `stock-trend-${stamp}.md`), '```\n' + out.join('\n') + '\n```\n');
}

if (require.main === module) main();

module.exports = { simulateLongShort, COST_SIDE_PCT };

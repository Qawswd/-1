'use strict';

// mix-trend.js — 코인(BTC·ETH)에 지수(QQQ·SPY)·금(GC=F)을 섞으면 같은 규칙에서 손실 폭 대비 수익이 나아지는지(2026-10-14).
// 바이낸스에 SPY·QQQ·XAU(금) 무기한이 실제로 있다(ops/stock-order-test.js 목록). 규칙은 실제 운용과 같다
// (trend.simulatePortfolio: 평균선 20·50·100·150·200일 위 개수만큼, 종목마다 같은 몫, 재난 손절 −25%, 고점 대비 −60% 정지).
// 날짜: 코인 달력(UTC 하루)에 맞추고, 주식·금이 쉬는 날은 직전 종가로 채워 '쉬는 날'로 표시한다(그날은 거래·평균선 계산 없음).
// 비용: 모든 종목 한쪽 0.1%(코인만 볼 때도 같은 비용으로 다시 돌려 공정하게 비교). 주식·금 선물 펀딩은 기록이 없어 빠진다.
//   node server/backtest/fetch-stocks.js --from 2015 GC=F SPY QQQ && node server/backtest/mix-trend.js

const fs = require('fs');
const path = require('path');
const E = require('./engine');
const T = require('./trend');
const { parseFundingCsv } = require('./carry');
const { looksDaily } = require('./fetch-stocks');

const DATA = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data');
const OUT_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'results');
const DAY = 86400000;
const LABEL = { BTCUSDT: 'BTC', ETHUSDT: 'ETH', QQQ: '나스닥100', SPY: 'S&P500', 'GC=F': '금' };

// 다른 시장 일봉을 코인 달력(UTC 00:00 하루 단위)에 맞춘다. 그 날짜에 거래가 없으면 직전 종가로 채우고 stale 표시.
// 첫 거래일 전은 null(그 종목이 아직 없던 기간) — 호출부가 공통 구간만 쓴다.
function alignToCalendar(calendar, bars) {
  const byDay = new Map();
  for (const b of bars) byDay.set(Math.floor(b.t / DAY) * DAY, b);
  const out = [];
  let prev = null;
  for (const t of calendar) {
    const b = byDay.get(t);
    if (b) {
      out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
      prev = b.c;
    } else if (prev != null) {
      out.push({ t, o: prev, h: prev, l: prev, c: prev, v: 0, stale: true });
    } else {
      out.push(null);
    }
  }
  return out;
}

function loadCrypto(sym) {
  const d = path.join(DATA, `${sym}-1d.csv`);
  const f = path.join(DATA, `${sym}-funding.csv`);
  if (!fs.existsSync(d)) return null;
  return { daily: E.parseCandleCsv(fs.readFileSync(d, 'utf8')), funding: fs.existsSync(f) ? parseFundingCsv(fs.readFileSync(f, 'utf8')) : [] };
}

function loadOther(key) {
  const p = path.join(DATA, 'stocks', `${key}-1d.csv`);
  if (!fs.existsSync(p)) return null;
  const rows = E.parseCandleCsv(fs.readFileSync(p, 'utf8'));
  return looksDaily(rows) ? rows : null;
}

// 여러 종목을 공통 구간(모두 존재하는 날부터)으로 잘라 simulatePortfolio 입력으로 만든다
function buildAssets(calendar, series) {
  const names = Object.keys(series);
  let start = 0;
  for (const n of names) {
    const i = series[n].daily.findIndex((b) => b);
    if (i > start) start = i;
  }
  const assets = {};
  for (const n of names) assets[n] = { daily: series[n].daily.slice(start), funding: series[n].funding || [] };
  return assets;
}

function main() {
  const btc = loadCrypto('BTCUSDT');
  const eth = loadCrypto('ETHUSDT');
  const out = [];
  const log = (s = '') => { console.log(s); out.push(s); };
  if (!btc || !eth) return log('코인 일봉 없음 — node server/backtest/fetch-data.js 먼저');
  const calendar = btc.daily.map((b) => b.t);
  const series = {
    BTCUSDT: { daily: btc.daily, funding: btc.funding },
    ETHUSDT: { daily: alignToCalendar(calendar, eth.daily), funding: eth.funding },
  };
  for (const key of ['QQQ', 'SPY', 'GC=F']) {
    const rows = loadOther(key);
    if (rows) series[key] = { daily: alignToCalendar(calendar, rows), funding: [] };
    else log(`${LABEL[key]}(${key}) 일봉 없음 — node server/backtest/fetch-stocks.js --from 2015 ${key}`);
  }
  const combos = [
    ['코인만', ['BTCUSDT', 'ETHUSDT']],
    ['코인+금', ['BTCUSDT', 'ETHUSDT', 'GC=F']],
    ['코인+나스닥', ['BTCUSDT', 'ETHUSDT', 'QQQ']],
    ['코인+나스닥+금', ['BTCUSDT', 'ETHUSDT', 'QQQ', 'GC=F']],
    ['코인+S&P+나스닥+금', ['BTCUSDT', 'ETHUSDT', 'SPY', 'QQQ', 'GC=F']],
    ['나스닥+금(코인 없이)', ['QQQ', 'GC=F']],
  ].filter(([, list]) => list.every((k) => series[k]));
  const OOS = Date.parse('2024-01-01');
  const dayInt = Math.pow(1.03, 1 / 365) - 1;
  log(`코인·지수·금 섞기 — 같은 추세추종 규칙(종목마다 같은 몫), 비용 한쪽 0.1%, ${new Date(calendar[0]).toISOString().slice(0, 10)} ~ ${new Date(calendar[calendar.length - 1]).toISOString().slice(0, 10)}`);
  log(`${'조합'.padEnd(18)}${'연%'.padStart(7)}${'최대손실%'.padStart(9)}${'월PF'.padStart(6)}${'최악해%'.padStart(8)}${'최악월%'.padStart(8)}   2024~ 연%·손실%   │ 전체 돈 1/4(+예금 3%): 연% · 최대손실% · 최악해%`);
  for (const [label, list] of combos) {
    const sub = {};
    for (const k of list) sub[k] = series[k];
    const r = T.simulatePortfolio(buildAssets(calendar, sub), { feePct: 0.1, slipPct: 0, stopPct: 25, breakerPct: 60 });
    const s = T.summarizeTrend(r.days);
    const o = T.summarizeTrend(r.days, { from: OOS });
    const q = T.summarizeTrend(r.days.map((d) => ({ t: d.t, ret: 0.25 * d.ret + 0.75 * dayInt })));
    if (!s) continue;
    const worstY = Math.min(...Object.values(s.byYear));
    const c = (v, w) => String(v == null ? '-' : v).padStart(w);
    log(
      `${label.padEnd(18)}${c(s.cagrPct, 7)}${c(-s.maxDrawdownPct, 9)}${c(s.monthlyPF, 6)}${c(worstY, 8)}${c(s.worstMonthPct, 8)}   ${o ? `${o.cagrPct}·${-o.maxDrawdownPct}` : '-'}` +
        `   │ ${q ? `${q.cagrPct} · ${-q.maxDrawdownPct} · ${Math.min(...Object.values(q.byYear))}` : '-'}${r.halted ? `  ⚠ 정지 ${new Date(r.halted.t).toISOString().slice(0, 10)}` : ''}`
    );
    log(`      연도별: ${Object.entries(s.byYear).map(([y, x]) => `${y} ${x}%`).join(' · ')}`);
  }
  log('\n읽는 법: 섞은 조합이 "코인만"보다 최대 손실이 작으면서 연%가 크게 줄지 않으면 분산 효과가 있다.');
  log('주의: 2020~2026 한 번의 기간뿐이다. 주식·금 선물은 펀딩비가 빠져 있다. 바이낸스 주식·금 선물은 TradFi 약관 동의가 있어야 주문된다(-4411).');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(OUT_DIR, `mix-trend-${stamp}.md`), '```\n' + out.join('\n') + '\n```\n');
}

if (require.main === module) main();

module.exports = { alignToCalendar, buildAssets };

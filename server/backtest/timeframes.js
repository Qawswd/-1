'use strict';

// timeframes.js — 대표님 규칙을 봉 길이만 바꿔서(15분·1시간·4시간·일봉) BTC·ETH 에 그대로(2026-10-25, 오너 "15분봉으로 비트 롱숏 똑같이 하면?")
// 규칙은 docs/08 그대로: SMA 50·200 신호등 · 롱 손절 −10% · 익절 +30%(3R) · 선 하나라도 아래 마감이면 정리
//   숏: 두 선 아래 + 하락 배열 + 200선이 20봉 전보다 낮을 때 · 손절 +4% · 익절 없음 · 선 위 마감이면 정리
//   비용 한쪽 0.07% · 실제 펀딩(하루 펀딩을 그날 봉 수로 나눠 봉마다). 봉 단위 수익을 하루로 묶어 같은 잣대(연%·최대 손실)로 본다.
//   node server/backtest/timeframes.js     # 15분봉 파일이 없으면 먼저 node server/backtest/fetch-data.js

const fs = require('fs');
const path = require('path');
const E = require('./engine');
const T = require('./trend');
const X = require('./exits');
const G = require('./ma-grid');

const DATA = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data');
const DAY = 86400000;
const M15 = 900000;
const IS_END = Date.parse('2024-01-01T00:00:00Z');
const LONG = { mode: 'long', stop: { k: 'pct', v: 10 }, tp: 3, trail: 'none', signalExit: true, holdDays: 0 };
const SHORT = { mode: 'shortOnly', stop: { k: 'pct', v: 4 }, tp: 0, trail: 'none', signalExit: true, holdDays: 0, slopeDays: 20 };

// 15분봉 n 개를 한 봉으로(시각 칸 기준)
function resample(m15, n) {
  if (n === 1) return m15;
  const out = [];
  let cur = null;
  for (const b of m15) {
    const k = Math.floor(b.t / (n * M15));
    if (!cur || cur.k !== k) {
      if (cur) out.push(cur);
      cur = { k, t: k * n * M15, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  if (cur) out.push(cur);
  return out.map(({ k, ...b }) => b);
}

// 봉 단위 수익 → 하루 단위(곱해서)
function toDaily(days) {
  const by = new Map();
  for (const d of days) {
    const k = Math.floor(d.t / DAY) * DAY;
    by.set(k, (by.has(k) ? by.get(k) : 1) * (1 + d.ret));
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, m]) => ({ t, ret: m - 1 }));
}

function main() {
  const coins = G.loadCoins();
  const ok = coins.filter((c) => fs.existsSync(path.join(DATA, `${c.name}USDT-15m.csv`)));
  if (!ok.length) return console.log('15분봉 데이터 없음 — 먼저 node server/backtest/fetch-data.js (몇 분 걸림)');
  const from = Date.parse('2020-07-19T00:00:00Z'); // 일봉 200선이 처음 생기는 날 — 모든 봉 길이를 같은 날부터 잰다
  console.log('대표님 규칙 × 봉 길이 — 같은 규칙(50·200선 · 롱 −10%/+30% · 숏 +4%/익절 없음) · 비용 한쪽 0.07% · 실제 펀딩 · 2020-07-19부터');
  for (const c of ok) {
    const m15 = E.parseCandleCsv(fs.readFileSync(path.join(DATA, `${c.name}USDT-15m.csv`), 'utf8'));
    console.log(`\n${c.name}`);
    for (const [name, n] of [['15분봉', 1], ['1시간봉', 4], ['4시간봉', 16], ['일봉', 96]]) {
      const bars = n === 96 ? c.bars : resample(m15, n);
      const fund = new Map([...c.fundDay].map(([k, v]) => [k, v / (96 / n)]));
      for (const [lab, list] of [['롱만', [LONG]], ['롱+숏', [LONG, SHORT]]]) {
        const runs = list.map((o) => X.simulateExits(bars, { ...o, fundDay: fund }));
        const daily = toDaily(X.combine(runs.map((r) => r.days), 1));
        const s = T.summarizeTrend(daily, { from });
        const i = T.summarizeTrend(daily, { from, to: IS_END - 1 });
        const o = T.summarizeTrend(daily, { from: IS_END });
        const tr = runs.flatMap((r) => r.trades.filter((t) => t.entryT >= from));
        const yrs = (daily[daily.length - 1].t - from) / (365.25 * DAY);
        const win = tr.length ? Math.round((tr.filter((t) => t.pct > 0).length / tr.length) * 100) : null;
        const avg = tr.length ? Math.round((tr.reduce((x, t) => x + t.pct, 0) / tr.length) * 100) / 100 : null;
        console.log(`  ${name} ${lab}: 연 ${s ? s.cagrPct : '-'}% · 최대 손실 −${s ? s.maxDrawdownPct : '-'}% · 2020~23 ${i ? i.cagrPct : '-'}% · 2024~ ${o ? o.cagrPct : '-'}% · 1년 ${Math.round(tr.length / yrs)}번 · 이긴 비율 ${win}% · 한 번 평균 ${avg}% · 1년 왕복 수수료 약 ${Math.round((tr.length / yrs) * 0.14)}%`);
      }
    }
  }
}

if (require.main === module) main();

module.exports = { resample, toDaily };

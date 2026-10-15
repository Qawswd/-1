'use strict';

// rotation.js — 가족 G(docs/07-RESEARCH-PROTOCOL.md): 여러 코인 중 최근 가장 강한 코인으로 갈아타기(상대 강도),
// 선택: 자기 추세 필터(종가가 N일 평균 위일 때만 — 절대 강도). 정한 날마다 상위 K개를 같은 몫으로 든다(나머지 현금).
// 수익: 종가→종가, 롱이 펀딩을 낸다(실제 기록), 비용은 바꾼 비중 × 한쪽 0.1%(알트는 호가가 얇아 코인 둘보다 크게).
// 2020~2023(만들기) / 2024~(시험)로 나눠 연수익·최대 손실·칼마(연수익÷최대 손실)를 본다.
//   node server/backtest/fetch-alts.js && node server/backtest/rotation.js

const fs = require('fs');
const path = require('path');
const E = require('./engine');
const T = require('./trend');
const { parseFundingCsv } = require('./carry');
const { alignToCalendar } = require('./mix-trend');

const DATA = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data');
const OUT_DIR = path.join(DATA, '..', 'results');
const DAY = 86400000;
const IS_END = Date.parse('2024-01-01T00:00:00Z');

// series: [{ sym, d: 달력에 맞춘 일봉(상장 전 null), fd: Map(UTC 날짜 → 그날 펀딩 합) }]
function simulateRotation(series, opts = {}) {
  const o = { lookback: 60, topK: 3, rebalanceDays: 7, trendSma: 100, useTrend: true, cost: 0.001, alloc: 0.95, ...opts };
  const n = series.length ? series[0].d.length : 0;
  const w = new Map(); // sym → 비중
  const days = [];
  const ok = (b) => b && !b.stale;
  for (let i = 1; i < n; i++) {
    let ret = 0;
    for (const s of series) {
      const wt = w.get(s.sym) || 0;
      if (!wt) continue;
      const b = s.d[i];
      const p = s.d[i - 1];
      if (!b || !p) continue;
      ret += wt * (b.c / p.c - 1 - (s.fd.get(Math.floor(b.t / DAY) * DAY) || 0));
    }
    if (i % o.rebalanceDays === 0) {
      const scored = [];
      for (const s of series) {
        const b = s.d[i];
        const back = s.d[i - o.lookback];
        if (!ok(b) || !back) continue;
        const score = b.c / back.c - 1;
        if (!(score > 0)) continue; // 절대 강도 — 최근에 떨어진 코인은 상위여도 안 산다
        if (o.useTrend) {
          if (i < o.trendSma) continue;
          let sum = 0;
          let cnt = 0;
          for (let k = i - o.trendSma + 1; k <= i; k++) if (s.d[k]) { sum += s.d[k].c; cnt++; }
          if (cnt < o.trendSma * 0.9 || !(b.c > sum / cnt)) continue;
        }
        scored.push({ sym: s.sym, score });
      }
      scored.sort((a, b) => b.score - a.score);
      const next = new Map(scored.slice(0, o.topK).map((x) => [x.sym, o.alloc / o.topK]));
      let turn = 0;
      for (const sym of new Set([...w.keys(), ...next.keys()])) turn += Math.abs((next.get(sym) || 0) - (w.get(sym) || 0));
      ret -= turn * o.cost;
      w.clear();
      for (const [k, v] of next) w.set(k, v);
    }
    days.push({ t: series[0].d[i] ? series[0].d[i].t : null, ret });
  }
  return days.filter((x) => x.t != null);
}

function calmarStats(days, from = -Infinity, to = Infinity) {
  const s = T.summarizeTrend(days.filter((x) => x.t >= from && x.t < to));
  if (!s) return null;
  return { cagr: s.cagrPct, dd: s.maxDrawdownPct, calmar: s.maxDrawdownPct > 0 ? Math.round((s.cagrPct / s.maxDrawdownPct) * 100) / 100 : null };
}

function loadCoin(dir, sym, calendar) {
  const dp = path.join(dir, `${sym}-1d.csv`);
  if (!fs.existsSync(dp)) return null;
  const d = alignToCalendar(calendar, E.parseCandleCsv(fs.readFileSync(dp, 'utf8')));
  const fp = path.join(dir, `${sym}-funding.csv`);
  const fd = new Map();
  if (fs.existsSync(fp)) for (const f of parseFundingCsv(fs.readFileSync(fp, 'utf8'))) { const k = Math.floor(f.t / DAY) * DAY; fd.set(k, (fd.get(k) || 0) + f.rate); }
  return { sym, d, fd };
}

function main() {
  const out = [];
  const log = (s = '') => { console.log(s); out.push(s); };
  const btc = E.parseCandleCsv(fs.readFileSync(path.join(DATA, 'BTCUSDT-1d.csv'), 'utf8'));
  const calendar = btc.map((b) => b.t);
  const altDir = path.join(DATA, 'alts');
  const series = [loadCoin(DATA, 'BTCUSDT', calendar), loadCoin(DATA, 'ETHUSDT', calendar)];
  if (fs.existsSync(altDir)) for (const f of fs.readdirSync(altDir).filter((x) => x.endsWith('-1d.csv'))) series.push(loadCoin(altDir, f.replace('-1d.csv', ''), calendar));
  const uni = series.filter(Boolean);
  if (uni.length < 5) return log('코인이 5개 미만 — node server/backtest/fetch-alts.js 먼저');
  log(`코인 ${uni.length}개 · ${new Date(calendar[0]).toISOString().slice(0, 10)} ~ ${new Date(calendar[calendar.length - 1]).toISOString().slice(0, 10)} · 비용 한쪽 0.1% · 펀딩 실제`);
  const f = (x) => (x ? `${String(x.cagr).padStart(7)}%/${String(-x.dd).padStart(7)}% 칼마${String(x.calmar).padStart(6)}` : '-');
  const rows = [];
  for (const useTrend of [true, false]) for (const lookback of [20, 60, 120]) for (const topK of [1, 3, 5]) {
    const days = simulateRotation(uni, { lookback, topK, useTrend });
    const r = { name: `${useTrend ? '추세필터' : '필터없음'} 기간${lookback} 상위${topK}`, all: calmarStats(days), is: calmarStats(days, -Infinity, IS_END), oos: calmarStats(days, IS_END) };
    rows.push(r);
    log(`${r.name.padEnd(22)} 전체 ${f(r.all)} │ 만들기 ${f(r.is)} │ 시험 ${f(r.oos)}`);
  }
  const pass = rows.filter((r) => r.oos && r.is && r.oos.calmar >= 2.1 && r.oos.cagr > 0 && r.is.calmar >= 1);
  const oosPos = rows.filter((r) => r.oos && r.oos.cagr > 0).length;
  log(`\n시도 ${rows.length}개 · 시험 구간 플러스 ${oosPos}개 · 기준(시험 칼마 ≥ 2.1 · 만들기 칼마 ≥ 1) 통과 ${pass.length}개${pass.length ? ': ' + pass.map((r) => r.name).join(', ') : ''}`);
  log('비교(같은 기간·같은 방식으로 본 BTC·ETH 추세추종): 전체 칼마 0.83 · 만들기 1.07 · 시험 0.78 (docs/07 연구 기록)');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(OUT_DIR, `rotation-${stamp}.md`), '```\n' + out.join('\n') + '\n```\n');
}

if (require.main === module) main();

module.exports = { simulateRotation, calmarStats };

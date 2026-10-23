'use strict';

// stock-universe.js — 대표님 규칙을 '바이낸스 상장 미국 주식 전체'로 재기(2026-10-23, 오너 "주식 다른 것도 할 거야 — 저것만 보기엔 의미 없어").
// QQQ·NVDA·TSLA 세 종목으로 낸 숫자는 그 종목들 덕일 수 있다. 결과를 보기 전에 정한 것:
//   종목: fetch-tradfi.js 가 받아 둔 바이낸스 TRADIFI 미국 주식·ETF 전부(meta.json ok) 중 2020-01-01 전부터 일봉이 있는 것
//         (코인 시험 기간 2020-07~ 를 다 덮어야 2022 하락장이 들어간다 — 짧은 종목 수는 따로 적는다)
//   규칙: 롱만 · 두 선(SMA 50·200) 위 마감 → 다음 날 진입 · 손절 −10% · 익절 +30% · 선 하나라도 아래 마감이면 정리
//         비용 한쪽 0.07% · 바이낸스 실측 롱 보유 비용(펀딩, 연%)을 매일 고르게 뺀다(측정은 상장 뒤라 그 전에도 같다고 본다)
//   ① 종목마다: 규칙 vs 그냥 들고 있기(연% · 최대 손실)
//   ② 아무 주식 3개 + BTC·ETH(코인 숏 포함, docs/08)를 300번 무작위로 골라(씨앗 고정) 칸 10·15·20% × 다섯 다/한 번에 4개 계좌:
//      연% · 최대 손실 · 대결 90일(시작 금액 대비 −15%) 도달 비율 · 90일 최악 · 1년 뒤 마이너스 비율 — 300개 조합의 중간값과 나쁜 쪽 10%
//   주의: 바이낸스는 2025~26 년에 이미 크게 오른 종목을 골라 상장했다(docs/07 2차 L) — 롱 규칙이 실제보다 좋아 보일 수 있다.
//   node server/backtest/stock-universe.js [--sets 300] [--dir reports/backtest/data]

const fs = require('fs');
const path = require('path');
const E = require('./engine');
const T = require('./trend');
const X = require('./exits');
const { parseFundingCsv } = require('./carry');

const DAY = 86400000;
const COVER_FROM = Date.parse('2020-01-01T00:00:00Z');
const LONG = { mode: 'long', stop: { k: 'pct', v: 10 }, tp: 3, trail: 'none', signalExit: true, holdDays: 0 };
const SHORT = { mode: 'shortOnly', stop: { k: 'pct', v: 4 }, tp: 0, trail: 'none', signalExit: true, holdDays: 0, slopeDays: 20 };

// 씨앗 고정 난수(mulberry32) — 다시 돌려도 같은 조합
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickK(n, k, rand) {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, k);
}

const quant = (arr, q) => {
  const v = arr.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  return v.length ? Math.round(v[Math.min(v.length - 1, Math.floor(q * (v.length - 1) + 0.5))] * 10) / 10 : null;
};

// 롱 보유 비용(연%) → 그 종목 일봉 날짜마다 같은 비율(펀딩 Map 모양: UTC 날짜 → 그날 비율)
function flatFunding(bars, annualPct) {
  const m = new Map();
  if (!(Number(annualPct) > 0) && !(Number(annualPct) < 0)) return m;
  for (const b of bars) m.set(Math.floor(b.t / DAY) * DAY, Number(annualPct) / 100 / 365);
  return m;
}

function loadUniverse(dir) {
  const tdir = path.join(dir, 'tradfi');
  const metaPath = path.join(tdir, 'meta.json');
  if (!fs.existsSync(metaPath)) return { stocks: [], short: [], missing: true };
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const stocks = [];
  const short = [];
  for (const m of (meta.symbols || []).filter((x) => x.ok && x.yahoo)) {
    const p = path.join(tdir, `${m.yahoo}-1d.csv`);
    if (!fs.existsSync(p)) continue;
    const bars = E.parseCandleCsv(fs.readFileSync(p, 'utf8')).filter((b) => b.t >= Date.parse('2015-01-01'));
    if (!bars.length || bars[0].t > COVER_FROM) {
      short.push(m.yahoo);
      continue;
    }
    stocks.push({ name: m.yahoo, type: m.type || null, bars, fundDay: flatFunding(bars, m.fundingAnnualPct), fundingAnnualPct: m.fundingAnnualPct ?? null });
  }
  return { stocks, short };
}

function loadCoins(dir) {
  const out = [];
  for (const sym of ['BTCUSDT', 'ETHUSDT']) {
    const p = path.join(dir, `${sym}-1d.csv`);
    if (!fs.existsSync(p)) continue;
    const bars = E.parseCandleCsv(fs.readFileSync(p, 'utf8'));
    const fp = path.join(dir, `${sym}-funding.csv`);
    const fundDay = new Map();
    if (fs.existsSync(fp)) for (const x of parseFundingCsv(fs.readFileSync(fp, 'utf8'))) { const k = Math.floor(x.t / DAY) * DAY; fundDay.set(k, (fundDay.get(k) || 0) + x.rate); }
    const p15 = path.join(dir, `${sym}-15m.csv`);
    const minutes = fs.existsSync(p15) ? X.minutesByDay(E.parseCandleCsv(fs.readFileSync(p15, 'utf8'))) : null;
    out.push({ name: sym.replace('USDT', ''), bars, fundDay, minutes });
  }
  return out;
}

function holdDays(bars, cost = 0.0007, fundDay = null) {
  return bars.slice(1).map((b, i) => ({ t: b.t, ret: b.c / bars[i].c - 1 - (fundDay ? fundDay.get(Math.floor(b.t / DAY) * DAY) || 0 : 0) - (i === 0 ? cost : 0) }));
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k, d) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : d);
  const dir = path.resolve(arg('--dir', path.join(__dirname, '..', '..', 'reports', 'backtest', 'data')));
  const nSets = Math.max(10, Math.min(2000, Number(arg('--sets', 300)) || 300));
  const out = [];
  const log = (s = '') => { console.log(s); out.push(s); };
  const U = loadUniverse(dir);
  if (U.missing) return log('주식 데이터 없음 — 서버에서 node server/backtest/fetch-tradfi.js 먼저');
  const coins = loadCoins(dir);
  if (coins.length < 2) return log('BTC·ETH 일봉 없음 — node server/backtest/fetch-data.js 먼저');
  const start = Math.max(...coins.map((a) => a.bars[200].t));
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
  log(`대표님 규칙 × 바이낸스 상장 미국 주식 전체 — ${U.stocks.length}종목(2020 전부터 기록) · 짧아서 뺀 것 ${U.short.length}종목 · ${new Date(start).toISOString().slice(0, 10)}부터`);

  // ① 종목마다
  const per = U.stocks.map((s) => {
    const r = X.simulateExits(s.bars, { ...LONG, fundDay: s.fundDay });
    const a = T.summarizeTrend(r.days, { from: start });
    const h = T.summarizeTrend(holdDays(s.bars, 0.0007, s.fundDay), { from: start });
    return { s, r, a, h };
  }).filter((x) => x.a && x.h);
  const pos = per.filter((x) => x.a.cagrPct > 0).length;
  const beatRet = per.filter((x) => x.a.cagrPct > x.h.cagrPct).length;
  const lessDd = per.filter((x) => x.a.maxDrawdownPct < x.h.maxDrawdownPct).length;
  const cal = (x) => (x.maxDrawdownPct > 0 ? x.cagrPct / x.maxDrawdownPct : null);
  log(`\n[1] 종목마다(롱 규칙, 한 종목에 다 넣었을 때) — ${per.length}종목`);
  log(`  규칙이 플러스 ${pos}종목(${Math.round((pos / per.length) * 100)}%) · 그냥 들고 있기보다 더 번 종목 ${beatRet}(${Math.round((beatRet / per.length) * 100)}%) · 최대 손실이 더 작은 종목 ${lessDd}(${Math.round((lessDd / per.length) * 100)}%)`);
  log(`  연% 중간값 규칙 ${quant(per.map((x) => x.a.cagrPct), 0.5)} vs 들고 있기 ${quant(per.map((x) => x.h.cagrPct), 0.5)} · 최대 손실 중간값 −${quant(per.map((x) => x.a.maxDrawdownPct), 0.5)} vs −${quant(per.map((x) => x.h.maxDrawdownPct), 0.5)} · 칼마 중간값 ${quant(per.map((x) => cal(x.a)), 0.5)} vs ${quant(per.map((x) => cal(x.h)), 0.5)}`);
  const sorted = [...per].sort((a, b) => a.a.cagrPct - b.a.cagrPct);
  const line = (x) => `${x.s.name} 규칙 ${x.a.cagrPct}%/−${x.a.maxDrawdownPct}% · 들고 있기 ${x.h.cagrPct}%/−${x.h.maxDrawdownPct}%`;
  log(`  가장 나쁜 5: ${sorted.slice(0, 5).map(line).join(' | ')}`);
  log(`  가장 좋은 5: ${sorted.slice(-5).reverse().map(line).join(' | ')}`);

  // ② 무작위 3종목 + BTC·ETH(롱 + 코인 숏)
  const coinLong = coins.map((c) => X.simulateExits(c.bars, { ...LONG, fundDay: c.fundDay, minutes: c.minutes }));
  const coinShort = coins.map((c) => X.simulateExits(c.bars, { ...SHORT, fundDay: c.fundDay, minutes: c.minutes }));
  const rand = rng(20261023);
  const sets = Array.from({ length: nSets }, () => pickK(per.length, 3, rand));
  const named = ['QQQ', 'NVDA', 'TSLA'].map((n) => per.findIndex((x) => x.s.name === n));
  if (named.every((i) => i >= 0)) sets.unshift(named); // 지금까지 쓴 조합이 전체에서 어디쯤인지
  log(`\n[2] 아무 주식 3개 + BTC·ETH(롱 + 코인 숏) — 조합 ${sets.length}개 · 값 = 중간값 [나쁜 쪽 10%]`);
  for (const w of [0.1, 0.15, 0.2]) for (const cap of [0, 4]) {
    const rows = sets.map((ix) => {
      const lists = [...coinLong, ...ix.map((i) => per[i].r), ...coinShort];
      const days = cap ? X.capCombine(lists, w, cap) : X.combine(lists.map((l) => l.days), w);
      const s = T.summarizeTrend(days, { from: start });
      const c90 = X.contestWindows(days, start, { len: 90 });
      const y1 = X.contestWindows(days, start, { len: 365 });
      return s && c90 && y1 ? { cagr: s.cagrPct, dd: s.maxDrawdownPct, hit: c90.hitPct, worst90: c90.worst, neg1y: y1.negPct, y2025: s.byYear['2025'] ?? null } : null;
    });
    const ok = rows.filter(Boolean);
    const anyHit = ok.filter((r) => r.hit > 0).length;
    log(`  칸 ${w * 100}% · ${cap ? `한 번에 ${cap}개` : '다 듦'}: 연 ${quant(ok.map((r) => r.cagr), 0.5)}% [${quant(ok.map((r) => r.cagr), 0.1)}] · 최대 손실 −${quant(ok.map((r) => r.dd), 0.5)}% [−${quant(ok.map((r) => r.dd), 0.9)}] · 90일 최악 ${quant(ok.map((r) => r.worst90), 0.5)}% [${quant(ok.map((r) => r.worst90), 0.1)}] · 90일 안에 −15% 찍은 조합 ${Math.round((anyHit / ok.length) * 100)}% · 1년 뒤 마이너스 ${quant(ok.map((r) => r.neg1y), 0.5)}% [${quant(ok.map((r) => r.neg1y), 0.9)}] · 2025 ${quant(ok.map((r) => r.y2025), 0.5)}%${named.every((i) => i >= 0) ? ` · QQQ·NVDA·TSLA 는 연 ${ok[0].cagr}%/−${ok[0].dd}%` : ''}`);
  }
  fs.mkdirSync(path.join(dir, '..', 'results'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(dir, '..', 'results', `stock-universe-${stamp}.md`), '```\n' + out.join('\n') + '\n```\n');
}

if (require.main === module) main();

module.exports = { rng, pickK, quant, flatFunding, loadUniverse, holdDays };

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
//   ③ 주식 숏(2026-10-23 오너 '코인베이스는 숏 왜 아닌데'): 코인과 같은 새 숏 조건(두 선 아래 + 하락 배열 + 200일선이 20일 전보다 낮을 때 ·
//      손절 4% · 익절 없음 · 선 위로 마감하면 정리)을 종목마다 — 플러스 종목 비율 · 2020~23 / 2024~ · 전 종목 같은 몫 숏 바구니
//   ②-3(--five, 2026-10-30 오너 '토스는 세금 22%, 바이낸스는 비과세 — 주식으로 5종목 하면?'): 무작위 주식 5종목 200조합으로
//      바이낸스(주식 선물 · 펀딩 냄 · 세금 0) vs 토스(실제 주식 · 펀딩 없음 · 해외주식 양도세: 해마다 250만 원 넘는 이익의 22%)
//      세금은 해마다 순자산 증가분(안 판 것 포함 — 근사)에 매기고 손실 이월 없음. 시작 금액별로 세후 연%를 따로 본다.
//   ②-4(--why, 2026-10-30 오너 '왜 이렇게 차이 나는지 모르겠어'): [2c] 의 차이를 한 가지씩 바꿔 나눈다 —
//      바이낸스 지금 방식 → 코인 숏 뺌 → 코인 롱 펀딩 뺌(현물) → 주식 펀딩 뺌(= 토스+업비트), 그리고 종목 하나에 다 넣었을 때 성적
//   ②-5(--toss, 2026-10-30 오너 '코인이 없다면? 토스로만 할 수 있는 규칙은?'): 실제 주식만(펀딩 없음) —
//      QQQ·SPY 사서 들고 있기 vs 같은 지수에 50·200 규칙(한 칸 100%) vs 주식 5종목 규칙(칸 15%·20%) vs QQQ 들고 있기 반 + 주식 5종목 규칙 반
//   ②-6(--stocks-only, 2026-10-31 오너 '난 지수로 이기기 싫어'): 개별 주식만(토스 · 펀딩 없음) — 지금 규칙 칸 15% vs 칸 20%
//      vs + QQQ 시장 신호등(사지 않고 보기만)으로 들어가기 vs + 신호등으로 정리, 참고로 같은 5종목 들고 있기. 기준은 docs/07 에 먼저 적었다
//   ②-7(--coins, 2026-10-31 오너 '그냥 코인만 하는 게 수익이 더 높은 거 아냐?'): 업비트 현물 BTC·ETH 롱만(펀딩 없음) 칸 15·20·25·50%
//      vs 토스 주식 3칸 + 업비트 코인 2칸(칸 15%, [2c] 와 같은 조합) — 같은 규칙, 크기만 다르다(새 규칙 찾기 아님)
//   ②-8(--many, 2026-10-31 오너 '주식만 하고 싶다 · 1년 뒤 정산 때 수익이거나 조금 손실 · 결국 우상향'): 같은 규칙에 종목 수만 바꾼다 —
//      돈을 N 등분(3·5·10·20종목, 칸 1/N, 칸 제한 없음)해 종목마다 지금 규칙, 그리고 전 종목 같은 몫. 해마다 정산(연도별)·1년 뒤 마이너스·최악의 해
//   ②-9(--plan, 2026-10-31 오너 '지수 포함해도 되니 마음대로 짜봐'): 주식 20종목 × 5% vs 지수 칸(SPY 들고 있기·SPY 규칙·QQQ 규칙) + 주식 20종목,
//      목표(최악의 해 ≥ −10% · 나쁜 쪽 −15% · 마이너스 해 ≤ 1) 안에서 연% 가 가장 높은 것을 고른다(docs/07 '토스 계획 짜기')
//   주의: 바이낸스는 2025~26 년에 이미 크게 오른 종목을 골라 상장했다(docs/07 2차 L) — 롱 규칙이 실제보다 좋아 보이고, 숏은 나빠 보일 수 있다.
//   node server/backtest/stock-universe.js [--sets 300] [--dir reports/backtest/data] [--five] [--why] [--toss] [--stocks-only] [--coins] [--many] [--plan]

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

// 해외주식 양도세 근사: 해마다(달력 연도) 순자산 증가분에서 공제 250만 원을 뺀 만큼 × 22% 를 그해 마지막 날 뺀다(손실 이월 없음)
function afterTax(days, from, startKrw, { deduct = 2500000, rate = 0.22 } = {}) {
  const xs = days.filter((d) => d.t >= from);
  if (!xs.length || !(startKrw > 0)) return null;
  let eq = startKrw;
  let yStart = eq;
  let taxPaid = 0;
  const settle = () => {
    const tax = Math.max(0, eq - yStart - deduct) * rate;
    eq -= tax;
    taxPaid += tax;
  };
  for (let i = 0; i < xs.length; i++) {
    eq *= 1 + xs[i].ret;
    const y = new Date(xs[i].t).getUTCFullYear();
    if (i === xs.length - 1 || new Date(xs[i + 1].t).getUTCFullYear() !== y) {
      settle();
      yStart = eq;
    }
  }
  const yrs = (xs[xs.length - 1].t - xs[0].t) / (365.25 * DAY);
  return { cagrPct: Math.round((Math.pow(eq / startKrw, 1 / yrs) - 1) * 1000) / 10, taxPaid: Math.round(taxPaid), endKrw: Math.round(eq) };
}

// ②-3 주식 5종목 vs 지금 방식, 바이낸스 vs 토스(+업비트)
function fiveStocks({ per, coins, start, log, nSets }) {
  const rand = rng(20261030);
  const sets = Array.from({ length: Math.min(200, nSets) }, () => pickK(per.length, 5, rand));
  const noFund = per.map((x) => X.simulateExits(x.s.bars, { ...LONG })); // 실제 주식 — 펀딩 없음
  const coinLongF = coins.map((c) => X.simulateExits(c.bars, { ...LONG, fundDay: c.fundDay, minutes: c.minutes }));
  const coinShortF = coins.map((c) => X.simulateExits(c.bars, { ...SHORT, fundDay: c.fundDay, minutes: c.minutes }));
  const coinSpot = coins.map((c) => X.simulateExits(c.bars, { ...LONG, minutes: c.minutes })); // 현물 롱 — 펀딩 없음, 숏 없음
  const tag = (r, cls) => ({ ...r, cls });
  const plans = [
    ['바이낸스 · 지금 방식(주식 3칸까지 + BTC·ETH 롱·숏)', (ix) => [...coinLongF.map((r) => tag(r, 'coin')), ...coinShortF.map((r) => tag(r, 'coin')), ...ix.slice(0, 3).map((i) => tag(per[i].r, 'stock'))], { stock: 3 }],
    ['바이낸스 · 주식 5종목만(주식 선물, 펀딩 냄)', (ix) => ix.map((i) => tag(per[i].r, 'stock')), null],
    ['토스 · 주식 5종목만(실제 주식, 펀딩 없음)', (ix) => ix.map((i) => tag(noFund[i], 'stock')), null, true],
    ['토스 주식 3칸 + 업비트 BTC·ETH 롱만(현물, 숏 없음)', (ix) => [...coinSpot.map((r) => tag(r, 'coin')), ...ix.slice(0, 3).map((i) => tag(noFund[i], 'stock'))], { stock: 3 }],
  ];
  const KRW = [5e6, 1e7, 3e7, 1e8];
  log(`\n[2c] 주식 5종목 vs 지금 방식 · 바이낸스 vs 토스 — 무작위 주식 5종목 ${sets.length}조합(지금 방식·토스+업비트는 그중 앞 3종목) · 칸 15% · 한 번에 5칸 · 세전 · 중간값 [나쁜 쪽 10%]`);
  for (const [label, build, classCaps, taxed] of plans) {
    const rows = sets.map((ix) => {
      const days = X.capCombine(build(ix), 0.15, 5, classCaps);
      const s2 = T.summarizeTrend(days, { from: start });
      const c90 = X.contestWindows(days, start, { len: 90 });
      const y1 = X.contestWindows(days, start, { len: 365 });
      if (!s2 || !c90 || !y1) return null;
      return { cagr: s2.cagrPct, dd: s2.maxDrawdownPct, worst90: c90.worst, hit: c90.hitPct, neg1y: y1.negPct, y2022: s2.byYear['2022'] ?? null, tax: taxed ? KRW.map((k) => afterTax(days, start, k)) : null };
    }).filter(Boolean);
    log(`  ${label}: 연 ${quant(rows.map((r) => r.cagr), 0.5)}% [${quant(rows.map((r) => r.cagr), 0.1)}] · 최대 손실 −${quant(rows.map((r) => r.dd), 0.5)}% [−${quant(rows.map((r) => r.dd), 0.9)}] · 90일 최악 ${quant(rows.map((r) => r.worst90), 0.5)}% [${quant(rows.map((r) => r.worst90), 0.1)}] · 90일 안에 −15% 찍은 조합 ${Math.round((rows.filter((r) => r.hit > 0).length / rows.length) * 100)}% · 1년 뒤 마이너스 ${quant(rows.map((r) => r.neg1y), 0.5)}% · 2022 ${quant(rows.map((r) => r.y2022), 0.5)}%`);
    if (taxed) log(`    세후(해외주식 양도세) 연%: ${KRW.map((k, j) => `시작 ${k >= 1e8 ? `${k / 1e8}억` : `${k / 1e4}만`} 원 ${quant(rows.map((r) => r.tax[j] && r.tax[j].cagrPct), 0.5)}%`).join(' · ')}`);
  }
  log('  (토스+업비트 줄의 세금은 주식 몫에만 붙는다 — 세후는 세전과 토스 5종목 세후 사이. 코인 과세는 2027-01 예정, 유예 논의 중)');
}

// ②-4 [2c] 차이 나누기 — 같은 200조합(씨앗 20261030, 앞 3종목)에서 한 가지씩 바꾼다
function whyGap({ per, coins, start, log, nSets }) {
  const rand = rng(20261030);
  const sets = Array.from({ length: Math.min(200, nSets) }, () => pickK(per.length, 5, rand)).map((ix) => ix.slice(0, 3));
  const noFund = per.map((x) => X.simulateExits(x.s.bars, { ...LONG }));
  const cl = coins.map((c) => X.simulateExits(c.bars, { ...LONG, fundDay: c.fundDay, minutes: c.minutes }));
  const cs = coins.map((c) => X.simulateExits(c.bars, { ...SHORT, fundDay: c.fundDay, minutes: c.minutes }));
  const spot = coins.map((c) => X.simulateExits(c.bars, { ...LONG, minutes: c.minutes }));
  const tag = (r, cls) => ({ ...r, cls });
  const steps = [
    ['① 바이낸스 지금 방식(주식 3칸 + 코인 롱·숏, 펀딩 냄)', (ix) => [...cl.map((r) => tag(r, 'coin')), ...cs.map((r) => tag(r, 'coin')), ...ix.map((i) => tag(per[i].r, 'stock'))]],
    ['② ①에서 코인 숏만 뺌', (ix) => [...cl.map((r) => tag(r, 'coin')), ...ix.map((i) => tag(per[i].r, 'stock'))]],
    ['③ ②에서 코인 롱 펀딩 뺌(업비트 현물)', (ix) => [...spot.map((r) => tag(r, 'coin')), ...ix.map((i) => tag(per[i].r, 'stock'))]],
    ['④ ③에서 주식 펀딩 뺌(토스 실제 주식) = 토스+업비트', (ix) => [...spot.map((r) => tag(r, 'coin')), ...ix.map((i) => tag(noFund[i], 'stock'))]],
  ];
  log(`\n[2d] 차이 나누기 — [2c] 와 같은 ${sets.length}조합 · 칸 15% · 5칸 · 주식 3칸까지 · 한 가지씩 바꿈 · 중간값`);
  let prev = null;
  for (const [label, build] of steps) {
    const rows = sets.map((ix) => T.summarizeTrend(X.capCombine(build(ix), 0.15, 5, { stock: 3 }), { from: start })).filter(Boolean);
    const med = quant(rows.map((r) => r.cagrPct), 0.5);
    const years = Object.keys(rows[0].byYear);
    log(`  ${label}: 연 ${med}%${prev == null ? '' : ` (앞 줄보다 ${med - prev >= 0 ? '+' : ''}${Math.round((med - prev) * 10) / 10}%p)`} · 최대 손실 −${quant(rows.map((r) => r.maxDrawdownPct), 0.5)}%`);
    log(`     연도별 ${years.map((y) => `${y} ${quant(rows.map((r) => r.byYear[y]), 0.5)}%`).join(' · ')}`);
    prev = med;
  }
  // 종목 하나에 다 넣었을 때(칸 하나의 힘) — 코인 vs 주식
  const one = (r) => T.summarizeTrend(r.days, { from: start });
  const tradeStat = (rs) => {
    const tr = rs.flatMap((r) => r.trades.filter((t) => t.entryT >= start));
    return tr.length ? `거래 ${tr.length}번 · 이긴 비율 ${Math.round((tr.filter((t) => t.pct > 0).length / tr.length) * 100)}% · 한 번 평균 ${Math.round((tr.reduce((x, t) => x + t.pct, 0) / tr.length) * 10) / 10}%` : '거래 없음';
  };
  log(`\n  종목 하나에 다 넣었을 때(규칙대로, ${new Date(start).toISOString().slice(0, 10)}~):`);
  coins.forEach((c, i) => {
    const a = one(cl[i]);
    const b2 = one(spot[i]);
    const sh = one(cs[i]);
    log(`    ${c.name} 롱: 선물(펀딩 냄) 연 ${a ? a.cagrPct : '-'}% · 현물 연 ${b2 ? b2.cagrPct : '-'}% → 펀딩으로 연 ${a && b2 ? Math.round((b2.cagrPct - a.cagrPct) * 10) / 10 : '-'}%p · ${tradeStat([cl[i]])} | 숏: 연 ${sh ? sh.cagrPct : '-'}% · ${tradeStat([cs[i]])}`);
  });
  const sF = per.map((x) => one(x.r)).filter(Boolean);
  const sN = noFund.map((r) => one(r)).filter(Boolean);
  log(`    주식 ${per.length}종목 롱(종목마다): 연% 중간값 선물 ${quant(sF.map((x) => x.cagrPct), 0.5)} · 실제 주식 ${quant(sN.map((x) => x.cagrPct), 0.5)} · 좋은 쪽 10% ${quant(sN.map((x) => x.cagrPct), 0.9)} · 나쁜 쪽 10% ${quant(sN.map((x) => x.cagrPct), 0.1)} · ${tradeStat(noFund)}`);
}

// ②-5 토스로만(실제 주식, 펀딩 없음) — 지수 들고 있기 · 지수 규칙 · 주식 5종목 규칙 · 반반
function tossOnly({ per, start, log, nSets }) {
  const noFund = per.map((x) => X.simulateExits(x.s.bars, { ...LONG }));
  const stat = (days) => {
    const s2 = T.summarizeTrend(days, { from: start });
    const c90 = X.contestWindows(days, start, { len: 90 });
    const y1 = X.contestWindows(days, start, { len: 365 });
    return s2 && c90 && y1 ? { cagr: s2.cagrPct, dd: s2.maxDrawdownPct, worst90: c90.worst, neg1y: y1.negPct, y2022: s2.byYear['2022'] ?? null } : null;
  };
  const one = (r) => (r ? `연 ${r.cagr}% · 최대 손실 −${r.dd}% · 90일 최악 ${r.worst90}% · 1년 뒤 마이너스 ${r.neg1y}% · 2022 ${r.y2022}%` : '데이터 없음');
  const many = (rows) => `연 ${quant(rows.map((r) => r.cagr), 0.5)}% [${quant(rows.map((r) => r.cagr), 0.1)}] · 최대 손실 −${quant(rows.map((r) => r.dd), 0.5)}% [−${quant(rows.map((r) => r.dd), 0.9)}] · 90일 최악 ${quant(rows.map((r) => r.worst90), 0.5)}% [${quant(rows.map((r) => r.worst90), 0.1)}] · 1년 뒤 마이너스 ${quant(rows.map((r) => r.neg1y), 0.5)}% · 2022 ${quant(rows.map((r) => r.y2022), 0.5)}%`;
  log(`\n[2e] 토스로만(실제 주식 · 펀딩 없음 · 세전) — ${new Date(start).toISOString().slice(0, 10)}~ · 여러 조합은 중간값 [나쁜 쪽 10%]`);
  const holdQ = {};
  for (const name of ['QQQ', 'SPY']) {
    const i = per.findIndex((x) => x.s.name === name);
    if (i < 0) continue;
    holdQ[name] = holdDays(per[i].s.bars, 0.0007, null);
    log(`  ${name} 사서 들고 있기(100%): ${one(stat(holdQ[name]))}`);
    log(`  ${name} 50·200 규칙(한 칸 100% · 손절 −10% · 익절 +30%): ${one(stat(noFund[i].days))}`);
  }
  const rand = rng(20261030);
  const sets = Array.from({ length: Math.min(200, nSets) }, () => pickK(per.length, 5, rand));
  for (const [label, w] of [['주식 5종목 규칙 · 칸 15%(최대 75%)', 0.15], ['주식 5종목 규칙 · 칸 20%(다 차면 100%)', 0.2]]) {
    log(`  ${label}: ${many(sets.map((ix) => stat(X.capCombine(ix.map((i) => noFund[i]), w, 5))).filter(Boolean))}`);
  }
  if (holdQ.QQQ) {
    const half = holdQ.QQQ.map((d) => ({ t: d.t, ret: d.ret * 0.5 }));
    log(`  QQQ 들고 있기 50% + 주식 5종목 규칙 칸 10%(매일 반반 근사): ${many(sets.map((ix) => stat(X.combine([half, X.capCombine(ix.map((i) => noFund[i]), 0.1, 5)], 1))).filter(Boolean))}`);
  }
  log('  (들고 있기는 팔 때만 세금 — 해마다 내는 규칙 매매보다 세금이 늦다. 이 기간은 미국 주식 강세장이라 들고 있기가 좋게 나온다)');
}

// ②-6 개별 주식만 — QQQ 는 사지 않고 시장 신호등으로만(docs/07 '토스 개별 주식 규칙')
function stocksOnly({ per, start, log, nSets }) {
  const q = per.find((x) => x.s.name === 'QQQ');
  if (!q) return log('QQQ 일봉 없음 — 시장 신호등을 못 만든다(서버에서 fetch-tradfi.js)');
  const G = require('./ma-grid');
  const qc = q.s.bars.map((b) => b.c);
  const f50 = G.maSeries(qc, 50);
  const s200 = G.maSeries(qc, 200);
  const up = new Set();
  const down = new Set();
  q.s.bars.forEach((b, k) => {
    if (f50[k] == null || s200[k] == null) return;
    const d = Math.floor(b.t / DAY);
    if (qc[k] > f50[k] && qc[k] > s200[k]) up.add(d);
    if (qc[k] < f50[k] || qc[k] < s200[k]) down.add(d);
  });
  const longGate = (t) => up.has(Math.floor(t / DAY));
  const exitGate = (t) => down.has(Math.floor(t / DAY));
  const pool = per.filter((x) => String(x.s.type || '').toUpperCase() !== 'ETF' && x.s.name !== 'QQQ' && x.s.name !== 'SPY'); // 개별 주식만(Yahoo instrumentType)
  const base = pool.map((x) => X.simulateExits(x.s.bars, { ...LONG }));
  const gIn = pool.map((x) => X.simulateExits(x.s.bars, { ...LONG, longGate }));
  const gBoth = pool.map((x) => X.simulateExits(x.s.bars, { ...LONG, longGate, exitGate }));
  const holds = pool.map((x) => holdDays(x.s.bars, 0.0007, null));
  const rand = rng(20261030);
  const sets = Array.from({ length: Math.min(200, nSets) }, () => pickK(pool.length, 5, rand));
  const IS_END = Date.parse('2024-01-01T00:00:00Z');
  const plans = [
    ['S0 지금 규칙 · 칸 15%', (ix) => X.capCombine(ix.map((i) => base[i]), 0.15, 5)],
    ['S1 칸 20%', (ix) => X.capCombine(ix.map((i) => base[i]), 0.2, 5)],
    ['S2 칸 20% + QQQ 신호등으로 들어가기', (ix) => X.capCombine(ix.map((i) => gIn[i]), 0.2, 5)],
    ['S3 칸 20% + QQQ 신호등으로 들어가고 정리', (ix) => X.capCombine(ix.map((i) => gBoth[i]), 0.2, 5)],
    ['참고 H 같은 5종목 같은 몫 들고 있기', (ix) => X.combine(ix.map((i) => holds[i]), 0.2)],
  ];
  const cal = (z) => (z && z.maxDrawdownPct > 0 ? z.cagrPct / z.maxDrawdownPct : null);
  log(`\n[2f] 개별 주식만(토스 · 펀딩 없음) — 주식 ${pool.length}종목에서 무작위 5종목 ${sets.length}조합 · 중간값 [나쁜 쪽 10%] · QQQ 는 사지 않고 신호등으로만`);
  const res = {};
  for (const [label, build] of plans) {
    const rows = sets.map((ix) => {
      const days = build(ix);
      const all = T.summarizeTrend(days, { from: start });
      const is = T.summarizeTrend(days, { from: start, to: IS_END - 1 });
      const oos = T.summarizeTrend(days, { from: IS_END });
      const c90 = X.contestWindows(days, start, { len: 90 });
      return all && is && oos && c90 ? { all, is, oos, c90 } : null;
    }).filter(Boolean);
    if (!rows.length) {
      log(`  ${label}: 데이터 부족(2024년 이후까지 이어진 조합 없음)`);
      res[label] = null;
      continue;
    }
    const m = (fn, q2 = 0.5) => quant(rows.map(fn), q2);
    const r = { calIs: m((x) => cal(x.is)), calOos: m((x) => cal(x.oos)), calAll: m((x) => cal(x.all)), lowIs: m((x) => x.is.cagrPct, 0.1), lowOos: m((x) => x.oos.cagrPct, 0.1) };
    res[label] = r;
    log(`  ${label}: 연 ${m((x) => x.all.cagrPct)}% [${m((x) => x.all.cagrPct, 0.1)}] · 최대 손실 −${m((x) => x.all.maxDrawdownPct)}% [−${m((x) => x.all.maxDrawdownPct, 0.9)}] · 90일 최악 ${m((x) => x.c90.worst)}% · 90일 안에 −15% 찍은 조합 ${Math.round((rows.filter((x) => x.c90.hitPct > 0).length / rows.length) * 100)}% · 2022 ${m((x) => x.all.byYear['2022'] ?? null)}%`);
    log(`     2020~23 연 ${m((x) => x.is.cagrPct)}% [${r.lowIs}] · 칼마 ${r.calIs} | 2024~ 연 ${m((x) => x.oos.cagrPct)}% [${r.lowOos}] · 칼마 ${r.calOos} | 전체 칼마 ${r.calAll}`);
  }
  const s0 = res[plans[0][0]];
  const pass = plans.slice(1, 4).map(([label]) => {
    const r = res[label];
    const why = [];
    if (!r || !s0) {
      log(`  판정 ${label}: 못 함 — 데이터 부족`);
      return { label, ok: false, cal: null };
    }
    if (!(r.calIs > s0.calIs && r.calOos > s0.calOos)) why.push(`칼마 2020~23 ${r.calIs} vs ${s0.calIs} · 2024~ ${r.calOos} vs ${s0.calOos}`);
    if (!(r.lowIs > s0.lowIs && r.lowOos > s0.lowOos)) why.push(`나쁜 쪽 10% 연% 2020~23 ${r.lowIs} vs ${s0.lowIs} · 2024~ ${r.lowOos} vs ${s0.lowOos}`);
    log(`  판정 ${label}: ${why.length ? `탈락 — ${why.join(' / ')}` : '통과'}`);
    return { label, ok: !why.length, cal: r.calAll };
  }).filter((x) => x.ok).sort((a, b) => b.cal - a.cal);
  log(`  → 토스 개별 주식 규칙: ${pass.length ? pass[0].label : 'S0 지금 규칙 그대로(통과한 후보 없음)'}`);
}

// ②-7 코인만 vs 토스+업비트 — 같은 규칙, 칸 크기만
function coinsOnly({ per, coins, start, log, nSets }) {
  const IS_END = Date.parse('2024-01-01T00:00:00Z');
  const spot = coins.map((c) => X.simulateExits(c.bars, { ...LONG, minutes: c.minutes }));
  const noFund = per.map((x) => X.simulateExits(x.s.bars, { ...LONG }));
  const under = (days) => {
    let eq = 1;
    let peak = 1;
    let peakT = null;
    let worst = 0;
    for (const d of days.filter((x) => x.t >= start)) {
      eq *= 1 + d.ret;
      if (peakT == null) peakT = d.t;
      if (eq >= peak) { peak = eq; peakT = d.t; } else worst = Math.max(worst, Math.round((d.t - peakT) / DAY));
    }
    return worst;
  };
  const stat = (days) => {
    const a = T.summarizeTrend(days, { from: start });
    const i = T.summarizeTrend(days, { from: start, to: IS_END - 1 });
    const o = T.summarizeTrend(days, { from: IS_END });
    const c90 = X.contestWindows(days, start, { len: 90 });
    const y1 = X.contestWindows(days, start, { len: 365 });
    if (!a || !i || !o || !c90 || !y1) return null;
    const ys = Object.values(a.byYear);
    return { cagr: a.cagrPct, dd: a.maxDrawdownPct, is: i.cagrPct, oos: o.cagrPct, oosDd: o.maxDrawdownPct, worst90: c90.worst, hit: c90.hitPct, neg1y: y1.negPct, worstYear: Math.min(...ys), pos: a.positiveMonthsPct, under: under(days) };
  };
  const line = (r) => (r ? `연 ${r.cagr}% · 최대 손실 −${r.dd}% · 2020~23 ${r.is}% · 2024~ ${r.oos}%(손실 −${r.oosDd}%) · 90일 최악 ${r.worst90}% · 90일 안에 −15% 찍은 날 ${r.hit}% · 1년 뒤 마이너스 ${r.neg1y}% · 최악의 해 ${r.worstYear}% · 플러스 달 ${r.pos}% · 가장 길게 물린 ${r.under}일` : '데이터 없음');
  log(`\n[2g] 코인만(업비트 현물 BTC·ETH 롱만 · 펀딩 없음) vs 토스 주식 3칸 + 업비트 코인 2칸 — 같은 규칙, 칸 크기만 · 09:00 실행 기준(17:30 이면 코인 1년 약 2.5%p 덜, docs/07)`);
  for (const w of [0.15, 0.2, 0.25, 0.5]) log(`  코인만 칸 ${w * 100}%(합 ${w * 200}%): ${line(stat(X.combine(spot.map((r) => r.days), w)))}`);
  const rand = rng(20261030);
  const sets = Array.from({ length: Math.min(200, nSets) }, () => pickK(per.length, 5, rand));
  const tag = (r, cls) => ({ ...r, cls });
  const rows = sets.map((ix) => stat(X.capCombine([...spot.map((r) => tag(r, 'coin')), ...ix.slice(0, 3).map((i) => tag(noFund[i], 'stock'))], 0.15, 5, { stock: 3 }))).filter(Boolean);
  const m = (k, q2 = 0.5) => quant(rows.map((r) => r[k]), q2);
  log(`  토스 주식 3칸 + 업비트 코인 2칸(칸 15%, ${rows.length}조합 중간값): 연 ${m('cagr')}% [${m('cagr', 0.1)}] · 최대 손실 −${m('dd')}% · 2020~23 ${m('is')}% · 2024~ ${m('oos')}%(손실 −${m('oosDd')}%) · 90일 최악 ${m('worst90')}% · 90일 안에 −15% 찍은 날 ${m('hit')}% · 1년 뒤 마이너스 ${m('neg1y')}% · 최악의 해 ${m('worstYear')}% · 플러스 달 ${m('pos')}% · 가장 길게 물린 ${m('under')}일`);
}

// ②-8 종목 수만 바꾸기 — 돈을 N 등분, 종목마다 지금 규칙(실제 주식 · 펀딩 없음)
function manyStocks({ per, start, log, nSets }) {
  const pool = per.filter((x) => String(x.s.type || '').toUpperCase() !== 'ETF' && x.s.name !== 'QQQ' && x.s.name !== 'SPY');
  const rule = pool.map((x) => X.simulateExits(x.s.bars, { ...LONG }));
  const holds = pool.map((x) => holdDays(x.s.bars, 0.0007, null));
  const stat = (days, expo) => {
    const a = T.summarizeTrend(days, { from: start });
    const y1 = X.contestWindows(days, start, { len: 365 });
    if (!a || !y1) return null;
    const ys = Object.values(a.byYear);
    const ex = expo ? expo.filter((d) => d.t >= start) : null;
    return { cagr: a.cagrPct, dd: a.maxDrawdownPct, neg1y: y1.negPct, worst1y: y1.worst, worstYear: Math.min(...ys), negYears: ys.filter((v) => v < 0).length, nYears: ys.length, byYear: a.byYear, expo: ex && ex.length ? (ex.reduce((x, d) => x + d.ret, 0) / ex.length) * 100 : null };
  };
  const expoList = (i) => rule[i].days.map((d) => ({ t: d.t, ret: d.inMarket ? 1 : 0 }));
  log(`\n[2h] 종목 수만 바꾸기(토스 · 실제 주식 · 펀딩 없음) — 개별 주식 ${pool.length}종목 · 돈을 N 등분해 종목마다 지금 규칙(−10% · +30% · 선 아래 마감 정리) · 조합 중간값 [나쁜 쪽 10%]`);
  log('  표기: 연% · 최대 손실 · 1년 뒤 마이너스(아무 날 시작해 1년 뒤) · 1년 뒤 최악 · 최악의 해 · 마이너스 해 수 · 평균 들어가 있던 몫 · 연도별(2020 은 7월부터, 2026 은 지금까지)');
  const fmt = (rows) => {
    const m = (fn, q2 = 0.5) => quant(rows.map(fn), q2);
    const years = Object.keys(rows[0].byYear);
    return `연 ${m((r) => r.cagr)}% [${m((r) => r.cagr, 0.1)}] · 최대 손실 −${m((r) => r.dd)}% [−${m((r) => r.dd, 0.9)}] · 1년 뒤 마이너스 ${m((r) => r.neg1y)}% · 1년 뒤 최악 ${m((r) => r.worst1y)}% [${m((r) => r.worst1y, 0.1)}] · 최악의 해 ${m((r) => r.worstYear)}% [${m((r) => r.worstYear, 0.1)}] · 마이너스 해 ${m((r) => r.negYears)}/${rows[0].nYears}${rows[0].expo != null ? ` · 들어가 있던 몫 ${m((r) => r.expo)}%` : ''}\n     연도별 ${years.map((y) => `${y} ${m((r) => r.byYear[y])}%`).join(' · ')}`;
  };
  for (const n of [3, 5, 10, 20]) {
    if (n > pool.length) { log(`  ${n}종목: 종목 부족`); continue; }
    const rand = rng(20261031 + n);
    const sets = Array.from({ length: Math.min(200, nSets) }, () => pickK(pool.length, n, rand));
    const rows = sets.map((ix) => stat(X.combine(ix.map((i) => rule[i].days), 1 / n), X.combine(ix.map(expoList), 1 / n))).filter(Boolean);
    const hr = sets.map((ix) => stat(X.combine(ix.map((i) => holds[i]), 1 / n))).filter(Boolean);
    if (rows.length) log(`  ${n}종목(칸 ${Math.round(1000 / n) / 10}%) 규칙: ${fmt(rows)}`);
    if (hr.length) log(`     (참고 같은 ${n}종목 들고 있기: 연 ${quant(hr.map((r) => r.cagr), 0.5)}% · 최대 손실 −${quant(hr.map((r) => r.dd), 0.5)}% · 1년 뒤 최악 ${quant(hr.map((r) => r.worst1y), 0.5)}% · 최악의 해 ${quant(hr.map((r) => r.worstYear), 0.5)}%)`);
  }
  const all = stat(X.combine(rule.map((r) => r.days), 1 / pool.length), X.combine(pool.map((_, i) => expoList(i)), 1 / pool.length));
  if (all) log(`  전 종목 ${pool.length}개 같은 몫 규칙: ${fmt([all])}`);
}

// 칸마다 다른 몫 — [{ days, w }] → 하루 수익 합(매일 몫을 맞춘다고 근사, combine 과 같은 방식)
function weighted(parts) {
  const by = new Map();
  for (const { days, w } of parts) for (const d of days) by.set(d.t, (by.get(d.t) || 0) + w * d.ret);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, ret]) => ({ t, ret }));
}

// ②-9 토스 계획 — 지수 칸 + 주식 20종목, 목표 안에서 연% 최고
function planToss({ per, start, log, nSets }) {
  const pool = per.filter((x) => String(x.s.type || '').toUpperCase() !== 'ETF' && x.s.name !== 'QQQ' && x.s.name !== 'SPY');
  const idx = (n) => per.find((x) => x.s.name === n);
  const spy = idx('SPY');
  const qqq = idx('QQQ');
  if (!spy || !qqq) return log('SPY·QQQ 일봉 없음 — 서버에서 fetch-tradfi.js');
  const n = Math.min(20, pool.length);
  const rule = pool.map((x) => X.simulateExits(x.s.bars, { ...LONG }));
  const spyRule = X.simulateExits(spy.s.bars, { ...LONG });
  const qqqRule = X.simulateExits(qqq.s.bars, { ...LONG });
  const spyHold = holdDays(spy.s.bars, 0.0007, null);
  const inOf = (r) => r.days.map((d) => ({ t: d.t, ret: d.inMarket ? 1 : 0 }));
  const one = (days) => days.map((d) => ({ t: d.t, ret: 1 }));
  const rand = rng(20261101);
  const sets = Array.from({ length: Math.min(200, nSets) }, () => pickK(pool.length, n, rand));
  const stock = (ix, w) => ix.map((i) => ({ days: rule[i].days, w }));
  const stockIn = (ix, w) => ix.map((i) => ({ days: inOf(rule[i]), w }));
  const w30 = 0.7 / n;
  const w50 = 0.5 / n;
  const plans = [
    ['A 주식 20종목 × 5%', (ix) => stock(ix, 1 / n), (ix) => stockIn(ix, 1 / n)],
    ['B SPY 들고 있기 30% + 주식 20종목 × 3.5%', (ix) => [{ days: spyHold, w: 0.3 }, ...stock(ix, w30)], (ix) => [{ days: one(spyHold), w: 0.3 }, ...stockIn(ix, w30)]],
    ['C30 SPY 규칙 30% + 주식 20종목 × 3.5%', (ix) => [{ days: spyRule.days, w: 0.3 }, ...stock(ix, w30)], (ix) => [{ days: inOf(spyRule), w: 0.3 }, ...stockIn(ix, w30)]],
    ['C50 SPY 규칙 50% + 주식 20종목 × 2.5%', (ix) => [{ days: spyRule.days, w: 0.5 }, ...stock(ix, w50)], (ix) => [{ days: inOf(spyRule), w: 0.5 }, ...stockIn(ix, w50)]],
    ['D QQQ 규칙 30% + 주식 20종목 × 3.5%', (ix) => [{ days: qqqRule.days, w: 0.3 }, ...stock(ix, w30)], (ix) => [{ days: inOf(qqqRule), w: 0.3 }, ...stockIn(ix, w30)]],
  ];
  const stat = (days, expo) => {
    const a = T.summarizeTrend(days, { from: start });
    const y1 = X.contestWindows(days, start, { len: 365 });
    if (!a || !y1) return null;
    const ys = Object.values(a.byYear);
    const ex = expo.filter((d) => d.t >= start);
    return { cagr: a.cagrPct, dd: a.maxDrawdownPct, neg1y: y1.negPct, worst1y: y1.worst, worstYear: Math.min(...ys), negYears: ys.filter((v) => v < 0).length, nYears: ys.length, byYear: a.byYear, expo: ex.length ? (ex.reduce((x, d) => x + d.ret, 0) / ex.length) * 100 : null };
  };
  log(`\n[2i] 토스 계획 — 개별 주식 ${pool.length}종목에서 무작위 ${n}종목 ${sets.length}조합 · 모든 칸 같은 규칙(50·200 · −10% · +30%) · 중간값 [나쁜 쪽 10%]`);
  log('  목표: 최악의 해 중간값 ≥ −10% · 나쁜 쪽 10% ≥ −15% · 마이너스 해 ≤ 1번 — 지킨 것 중 연% 가 가장 높은 것');
  const res = [];
  for (const [label, build, buildIn] of plans) {
    const rows = sets.map((ix) => stat(weighted(build(ix)), weighted(buildIn(ix)))).filter(Boolean);
    if (!rows.length) { log(`  ${label}: 데이터 부족`); continue; }
    const m = (fn, q2 = 0.5) => quant(rows.map(fn), q2);
    const r = { label, cagr: m((x) => x.cagr), dd: m((x) => x.dd), wy: m((x) => x.worstYear), wyLow: m((x) => x.worstYear, 0.1), negY: m((x) => x.negYears) };
    r.ok = r.wy >= -10 && r.wyLow >= -15 && r.negY <= 1;
    res.push(r);
    const years = Object.keys(rows[0].byYear);
    log(`  ${label}: 연 ${r.cagr}% [${m((x) => x.cagr, 0.1)}] · 최대 손실 −${r.dd}% [−${m((x) => x.dd, 0.9)}] · 1년 뒤 마이너스 ${m((x) => x.neg1y)}% · 1년 뒤 최악 ${m((x) => x.worst1y)}% · 최악의 해 ${r.wy}% [${r.wyLow}] · 마이너스 해 ${r.negY}/${rows[0].nYears} · 들어가 있던 몫 ${m((x) => x.expo)}% · ${r.ok ? '목표 안' : '목표 밖'}`);
    log(`     연도별 ${years.map((y) => `${y} ${m((x) => x.byYear[y])}%`).join(' · ')}`);
  }
  const inside = res.filter((r) => r.ok).sort((a, b) => b.cagr - a.cagr || a.dd - b.dd);
  const pick = inside[0] || [...res].sort((a, b) => b.wy - a.wy)[0];
  log(`  → 고른 계획: ${pick ? pick.label : '-'}${inside.length ? '' : ' (목표를 다 지킨 계획 없음 — 최악의 해가 가장 덜 나쁜 것)'}`);
  log(`  종목 목록(${pool.length}, 고를 때 업종을 나누려고 — 과거 성적으로 고르지 않는다): ${pool.map((x) => x.s.name).join(' ')}`);
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
  if (argv.includes('--five')) return fiveStocks({ per, coins, start, log, nSets });
  if (argv.includes('--why')) return whyGap({ per, coins, start, log, nSets });
  if (argv.includes('--toss')) return tossOnly({ per, start, log, nSets });
  if (argv.includes('--stocks-only')) return stocksOnly({ per, start, log, nSets });
  if (argv.includes('--coins')) return coinsOnly({ per, coins, start, log, nSets });
  if (argv.includes('--many')) return manyStocks({ per, start, log, nSets });
  if (argv.includes('--plan')) return planToss({ per, start, log, nSets });
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

  // ①-2 들어갈 때 50일선과 거리(오너 2026-10-24 LLY '조건은 맞지만 50일선과 거리가 꽤 되면?') — 거리별 성적과 '멀면 기다리기'
  const ltr = per.flatMap((x) => x.r.trades.filter((t) => t.entryT >= start && t.ext != null));
  const buckets = [[-1, 0.03], [0.03, 0.06], [0.06, 0.1], [0.1, 0.15], [0.15, 99]];
  log(`\n[1b] 주식 롱 — 들어갈 때 50일선과 거리별(거래 수 · 이긴 비율 · 한 번 평균) · 전체 ${ltr.length}번`);
  log(`  ${buckets.map(([a, b2]) => { const g = ltr.filter((t) => t.ext > a && t.ext <= b2); return g.length ? `${a < 0 ? 0 : a * 100}~${b2 > 1 ? '' : b2 * 100}%: ${g.length}번 · ${Math.round((g.filter((t) => t.pct > 0).length / g.length) * 100)}% · ${r1(g.reduce((x, t) => x + t.pct, 0) / g.length)}%` : null; }).filter(Boolean).join(' | ')}`);
  for (const m of [null, 0.05, 0.1, 0.2]) {
    const rs = m == null ? per.map((x) => x.r) : per.map((x) => X.simulateExits(x.s.bars, { ...LONG, fundDay: x.s.fundDay, maxExt: m }));
    const bk = T.summarizeTrend(X.combine(rs.map((r) => r.days), 1 / Math.max(1, rs.length)), { from: start });
    const med = quant(rs.map((r) => { const z = T.summarizeTrend(r.days, { from: start }); return z ? z.cagrPct : null; }), 0.5);
    log(`  ${m == null ? '제한 없음' : `50일선에서 ${m * 100}% 이내일 때만(멀면 기다림)`}: 종목 연% 중간값 ${med} · 전 종목 같은 몫 롱 바구니 연 ${bk ? bk.cagrPct : '-'}% / −${bk ? bk.maxDrawdownPct : '-'}%`);
  }

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
  // ②-2 대표님 실제 방식(2026-10-24): 주식 7종목 + BTC·ETH 중 신호 나는 대로 칸 15% · 한 번에 5칸(먼저 온 것부터) vs 주식은 3칸까지(2칸은 코인 몫)
  //   코인이 쉬는 동안 주식으로 5칸을 채우면 나중에 코인 신호를 놓친다 — 무엇이 나은지. 무작위 7종목 200조합
  {
    const rand7 = rng(20261024);
    const sets7 = Array.from({ length: Math.min(200, nSets) }, () => pickK(per.length, 7, rand7));
    const tag = (r, cls) => ({ ...r, cls });
    log(`\n[2b] 주식 7종목 + BTC·ETH(롱 + 코인 숏) · 한 번에 5칸 — 조합 ${sets7.length}개 · 중간값 [나쁜 쪽 10%]`);
    for (const [label, classCaps, w] of [['칸 15% · 주식 칸 제한 없음(먼저 온 것부터 5칸)', null, 0.15], ['칸 15% · 주식은 3칸까지(2칸은 코인 몫)', { stock: 3 }, 0.15], ['칸 15% · 주식은 4칸까지', { stock: 4 }, 0.15], ['칸 12% · 주식은 3칸까지', { stock: 3 }, 0.12], ['칸 10% · 주식은 3칸까지', { stock: 3 }, 0.1]]) {
      const rows = sets7.map((ix) => {
        const lists = [...coinLong.map((r) => tag(r, 'coin')), ...coinShort.map((r) => tag(r, 'coin')), ...ix.map((i) => tag(per[i].r, 'stock'))];
        const days = X.capCombine(lists, w, 5, classCaps);
        const s2 = T.summarizeTrend(days, { from: start });
        const c90 = X.contestWindows(days, start, { len: 90 });
        return s2 && c90 ? { cagr: s2.cagrPct, dd: s2.maxDrawdownPct, worst90: c90.worst, hit: c90.hitPct } : null;
      }).filter(Boolean);
      log(`  ${label}: 연 ${quant(rows.map((r) => r.cagr), 0.5)}% [${quant(rows.map((r) => r.cagr), 0.1)}] · 최대 손실 −${quant(rows.map((r) => r.dd), 0.5)}% [−${quant(rows.map((r) => r.dd), 0.9)}] · 90일 최악 ${quant(rows.map((r) => r.worst90), 0.5)}% [${quant(rows.map((r) => r.worst90), 0.1)}] · 90일 안에 −15% 찍은 조합 ${Math.round((rows.filter((r) => r.hit > 0).length / rows.length) * 100)}%`);
    }
  }

  // ③ 주식 숏 — 새 숏 조건 그대로
  const IS_END = Date.parse('2024-01-01T00:00:00Z');
  const shorts = per.map((x) => ({ x, r: X.simulateExits(x.s.bars, { ...SHORT, fundDay: x.s.fundDay }) }));
  const st = shorts.map((y) => ({ name: y.x.s.name, all: T.summarizeTrend(y.r.days, { from: start }), is: T.summarizeTrend(y.r.days, { from: start, to: IS_END - 1 }), oos: T.summarizeTrend(y.r.days, { from: IS_END }), n: y.r.trades.filter((t) => t.entryT >= start).length })).filter((y) => y.all && y.n > 0);
  const trades = shorts.flatMap((y) => y.r.trades.filter((t) => t.entryT >= start));
  const basket = X.combine(shorts.map((y) => y.r.days), 1 / Math.max(1, shorts.length));
  const b = (from, to) => T.summarizeTrend(basket, { from, to });
  const ba = b(start);
  const bi = b(start, IS_END - 1);
  const bo = b(IS_END);
  log(`\n[3] 주식 숏(코인과 같은 새 숏 조건) — 숏이 한 번이라도 나온 ${st.length}종목 · 거래 ${trades.length}번 · 이긴 비율 ${trades.length ? Math.round((trades.filter((t) => t.pct > 0).length / trades.length) * 100) : '-'}% · 거래당 평균 ${trades.length ? r1(trades.reduce((x, t) => x + t.pct, 0) / trades.length) : '-'}%`);
  log(`  종목마다(숏 칸만): 플러스 ${st.filter((y) => y.all.cagrPct > 0).length}종목(${st.length ? Math.round((st.filter((y) => y.all.cagrPct > 0).length / st.length) * 100) : '-'}%) · 연% 중간값 ${quant(st.map((y) => y.all.cagrPct), 0.5)} · 2020~23 ${quant(st.filter((y) => y.is).map((y) => y.is.cagrPct), 0.5)} · 2024~ ${quant(st.filter((y) => y.oos).map((y) => y.oos.cagrPct), 0.5)}`);
  log(`  전 종목 같은 몫 숏 바구니: 연 ${ba ? ba.cagrPct : '-'}% / −${ba ? ba.maxDrawdownPct : '-'}% · 2020~23 ${bi ? bi.cagrPct : '-'}% · 2024~ ${bo ? bo.cagrPct : '-'}%`);
  // 연도별(오너 '주식도 하락장이 있을 텐데' — 2022 하락장에서만이라도 벌었는지) · 같은 해 롱 바구니와 나란히
  const longBasket = X.combine(per.map((x) => x.r.days), 1 / Math.max(1, per.length));
  const lb = T.summarizeTrend(longBasket, { from: start });
  const yearsS = ba ? ba.byYear : {};
  const byYearShortN = {};
  for (const t of trades) { const y = new Date(t.entryT).getUTCFullYear(); byYearShortN[y] = byYearShortN[y] || { n: 0, w: 0 }; byYearShortN[y].n++; if (t.pct > 0) byYearShortN[y].w++; }
  log(`  연도별 — 숏 바구니 / 롱 바구니(같은 몫) / 숏 거래 수·이긴 비율: ${Object.keys(yearsS).map((y) => `${y} 숏 ${yearsS[y]}% · 롱 ${lb && lb.byYear[y] != null ? lb.byYear[y] : '-'}% · ${byYearShortN[y] ? `${byYearShortN[y].n}번 ${Math.round((byYearShortN[y].w / byYearShortN[y].n) * 100)}%` : '0번'}`).join(' | ')}`);
  // ③-2 시장 전체가 하락장일 때만(2022 만 플러스였던 것을 본 뒤 떠올린 생각 — 할인해서 본다):
  //   지수(QQQ·SPY 각각)가 '두 선 아래 + 하락 배열 + 200일선이 20일 전보다 낮음'인 날에만 개별 주식 숏을 새로 든다
  const G = require('./ma-grid');
  for (const idxName of ['QQQ', 'SPY']) {
    const idx = per.find((x) => x.s.name === idxName);
    if (!idx) continue;
    const ib = idx.s.bars;
    const ic = ib.map((b) => b.c);
    const f50 = G.maSeries(ic, 50);
    const s200 = G.maSeries(ic, 200);
    const bear = new Set();
    ib.forEach((b, k) => {
      if (k >= 220 && f50[k] != null && s200[k] != null && s200[k - 20] != null && ic[k] < f50[k] && ic[k] < s200[k] && f50[k] < s200[k] && s200[k] < s200[k - 20]) bear.add(Math.floor(b.t / DAY));
    });
    const gate = (t) => bear.has(Math.floor(t / DAY));
    const gs = per.map((x) => X.simulateExits(x.s.bars, { ...SHORT, fundDay: x.s.fundDay, shortGate: gate }));
    const gt = gs.flatMap((r) => r.trades.filter((t) => t.entryT >= start));
    const gb = X.combine(gs.map((r) => r.days), 1 / Math.max(1, gs.length));
    const ga = T.summarizeTrend(gb, { from: start });
    const gsum = gs.map((r) => T.summarizeTrend(r.days, { from: start })).filter((y, i) => y && gs[i].trades.length);
    const bearDays = [...bear].filter((d) => d * DAY >= start).length;
    log(`\n[3b] ${idxName} 가 하락장(두 선 아래 + 하락 배열 + 200일선 내리막)인 날에만 주식 숏 — 그런 날 ${bearDays}일 · 거래 ${gt.length}번 · 이긴 비율 ${gt.length ? Math.round((gt.filter((t) => t.pct > 0).length / gt.length) * 100) : '-'}% · 거래당 ${gt.length ? r1(gt.reduce((x, t) => x + t.pct, 0) / gt.length) : '-'}% · 플러스 종목 ${gsum.filter((y) => y.cagrPct > 0).length}/${gsum.length}`);
    log(`  숏 바구니: 연 ${ga ? ga.cagrPct : '-'}% / −${ga ? ga.maxDrawdownPct : '-'}% · 연도별 ${ga ? Object.entries(ga.byYear).map(([y, v]) => `${y} ${v}%`).join(' · ') : '-'}`);
  }
  const coinS = coinShort.map((r, i) => T.summarizeTrend(r.days, { from: start }));
  log(`  (비교: 같은 숏을 코인에 — ${coins.map((c, i) => `${c.name} ${coinS[i] ? `${coinS[i].cagrPct}%/−${coinS[i].maxDrawdownPct}%` : '-'}`).join(' · ')})`);
  fs.mkdirSync(path.join(dir, '..', 'results'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(dir, '..', 'results', `stock-universe-${stamp}.md`), '```\n' + out.join('\n') + '\n```\n');
}

if (require.main === module) main();

module.exports = { rng, pickK, quant, flatFunding, loadUniverse, holdDays, afterTax };

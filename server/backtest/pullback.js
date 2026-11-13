'use strict';

// pullback.js — 일봉 신호등 + 4시간봉 20선 눌림 진입 시험(2026-10-23, 오너 "200·50 위나 아래서 사고 4시간 20이평까지 보라며? 자세히").
// 오늘 앞선 답에서 '4시간봉 20선까지 눌렸다가 다시 올라설 때 롱, 손절은 눌림 바닥 아래'를 시험 없이 권했다 — 그 말을 그대로 기계 규칙으로 옮겨 잰다.
// 결과를 보기 전에 정한 것:
//   방향: 마지막으로 마감된 일봉 종가가 SMA 50·200 둘 다 위 → 롱만 찾음 / (롱·숏 판) 둘 다 아래 + 50일선 < 200일선 → 숏만 찾음
//   E0 (기준, exits.js 추천 규칙과 같음): 일봉이 초록으로 마감하면 다음 날 시가(한국 09:00)에 진입
//   E1 (4시간 눌림): 4시간봉 저가가 4시간 SMA20 에 닿으면 '준비' → 그 뒤(같은 봉 포함) 4시간 종가가 SMA20 위로 마감하면 다음 4시간 시가에 진입
//       숏은 거꾸로(고가가 닿으면 준비 → 종가가 아래로 마감)
//   손절: −10% 고정 / 눌림 바닥(준비~진입 신호 사이 최저가) −0.1% 아래(10% 넘으면 10%)
//   익절: 손절 거리의 3R · 2R · 없음
//   공통 청산: 일봉 종가가 선 하나라도 반대로 마감하면 다음 날 시가 · 비용 한쪽 0.07% · 실제 펀딩(8시간마다) · 손절·익절은 15분봉으로 순서(한 봉에 둘 다면 손절)
//   node server/backtest/pullback.js

const fs = require('fs');
const path = require('path');
const E = require('./engine');
const T = require('./trend');
const G = require('./ma-grid');
const X = require('./exits');
const { parseFundingCsv } = require('./carry');

const DATA = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data');
const DAY = 86400000;
const H4 = 4 * 3600000;
const H8 = 8 * 3600000;
const M15 = 900000;
const IS_END = Date.parse('2024-01-01T00:00:00Z');
const COST = 0.0007;

// 일봉 신호: Map(UTC 날짜 시작 → 그날 종가 기준 1 / −1(하락 배열일 때만) / 0)
// confirm: 숏은 하락 배열(50일선 < 200일선)일 때만 — false 면 두 선 아래면 숏
function dailyLights(daily, { allowShort = false, confirm = true, fast = 50, slow = 200 } = {}) {
  const c = daily.map((b) => b.c);
  const f = G.maSeries(c, fast);
  const s = G.maSeries(c, slow);
  const m = new Map();
  daily.forEach((b, i) => {
    let v = 0;
    if (f[i] != null && s[i] != null) {
      if (c[i] > f[i] && c[i] > s[i]) v = 1;
      else if (allowShort && c[i] < f[i] && c[i] < s[i] && (!confirm || f[i] < s[i])) v = -1;
    }
    m.set(Math.floor(b.t / DAY) * DAY, v);
  });
  return m;
}

// 15분봉으로 한 종목을 돈다. 반환 { days:[{t,ret}], trades }
// execDelay: 일봉 마감(UTC 00:00 = 한국 09:00) 뒤 몇 ms 지나서 일봉 신호대로 사고팔지 — 손절·익절 주문은 그동안에도 걸려 있다.
//   오너는 한국 17:30~21:00 에만 휴대폰을 쓴다(2026-10-23) → 8.5시간·12시간 늦게 해도 되는지 잰다. shortOnly: 숏 칸만 따로 잴 때
function simulatePullback(m15, daily, { entry = 'pullback', stop = 'pullback', tp = 3, allowShort = false, shortOnly = false, confirm = true, execDelay = 0, stopPct = 10, lineStop = false, recheck = 'none', band = 0, slopeDays = 0, breakdownDays = 0, cost = COST, funding = null, smaLen = 20, fast = 50, slow = 200 } = {}) {
  const light = dailyLights(daily, { allowShort: allowShort || shortOnly, confirm, fast, slow });
  const lightAt = (t) => {
    const v = light.get(Math.floor(t / DAY) * DAY - DAY) || 0; // 어제 마감된 일봉
    return shortOnly && v > 0 ? 0 : v;
  };
  // lineStop: 매일 실행 시각에 손절 주문을 '어제 종가 기준 선 가격'으로 옮겨 건다(장중에 선이 뚫리면 바로 나옴).
  //   롱은 두 선 중 높은 쪽, 숏은 낮은 쪽 — 고정 손절보다 가까울 때만. 실행 시각에 이미 선 너머면 들어가지 않는다.
  const dc = daily.map((x) => x.c);
  const fS = G.maSeries(dc, fast);
  const sS = G.maSeries(dc, slow);
  const lines = new Map(daily.map((x, k) => [Math.floor(x.t / DAY) * DAY, fS[k] != null && sS[k] != null ? [fS[k], sS[k]] : null]));
  const lineFor = (t, dir) => {
    const v = lines.get(Math.floor(t / DAY) * DAY - DAY);
    return v ? (dir > 0 ? Math.max(v[0], v[1]) : Math.min(v[0], v[1])) : null;
  };
  // recheck: 실행 시각(17:30)에 지금 가격을 한 번 더 본다 — 'exit' 면 아침 종가가 선을 깼어도 지금 선 안으로 돌아왔으면 정리하지 않고,
  //   'both' 면 아침 종가가 초록이어도 지금 선 밖이면 들어가지 않는다(오너 질문 2026-10-23)
  const backInside = (t, dir, p) => {
    const line = lineFor(t, dir);
    return line != null && dir * (p - line) > 0;
  };
  // band: 선 근처 흔들림 여유(오너 질문 2026-10-23 '아래서 마감했다는 정의가 애매'). 롱은 종가가 높은 선 × (1+band) 위여야 들어가고
  //   × (1−band) 아래로 마감해야 정리, 숏은 낮은 선 기준 거꾸로. 그 사이면 있던 대로(들고 있으면 유지, 없으면 안 들어감). 0 이면 지금 규칙.
  const closeOf = new Map(daily.map((x) => [Math.floor(x.t / DAY) * DAY, x.c]));
  // 숏 진입에만 거는 추가 조건(2026-10-23 숏 재분석) — 들고 있는 동안은 원래 신호등으로만 판단
  //   slopeDays: 200일선이 slopeDays 전보다 낮아야(내려가는 중) · breakdownDays: 종가가 그 전 breakdownDays 일 최저가보다 낮아야(새 저점)
  const dayIdx = new Map(daily.map((x, k) => [Math.floor(x.t / DAY) * DAY, k]));
  const shortEntryOk = (t) => {
    const k = dayIdx.get(Math.floor(t / DAY) * DAY - DAY);
    if (k == null) return false;
    if (slopeDays > 0 && !(k - slopeDays >= 0 && sS[k] != null && sS[k - slopeDays] != null && sS[k] < sS[k - slopeDays])) return false;
    if (breakdownDays > 0) {
      if (k - breakdownDays < 0) return false;
      let low = Infinity;
      for (let q = k - breakdownDays; q < k; q++) low = Math.min(low, dc[q]);
      if (!(dc[k] < low)) return false;
    }
    return true;
  };
  const bandWant = (t, cur) => {
    const k = Math.floor(t / DAY) * DAY - DAY;
    const v = lines.get(k);
    const c = closeOf.get(k);
    if (!v || c == null) return 0;
    const hi = Math.max(v[0], v[1]);
    const lo = Math.min(v[0], v[1]);
    const longOk = !shortOnly && (cur > 0 ? c >= hi * (1 - band) : c > hi * (1 + band));
    const shortAllowed = (allowShort || shortOnly) && (!confirm || v[0] < v[1]);
    const shortOk = shortAllowed && (cur < 0 ? c <= lo * (1 + band) : c < lo * (1 - band));
    return longOk ? 1 : shortOk ? -1 : 0;
  };
  const applyLine = (t) => {
    const line = lineFor(t, pos.dir);
    const tighter = line != null && pos.dir * (line - pos.fixedStop) > 0;
    pos.stop = tighter ? line : pos.fixedStop;
    pos.stopIsLine = tighter;
  };
  const closes4 = [];
  let cur4 = null;
  let arm = null; // { dir, extreme }
  let cash = 1;
  let pos = null;
  let pendingEntry = null; // { dir, stopPrice }
  let exitNext = false;
  const trades = [];
  const days = [];
  let dayStartEq = 1;
  const value = (p) => pos.base * (1 + pos.dir * (p / pos.entry - 1)) - pos.fundCost;
  const close = (p, t, reason) => {
    cash = Math.max(0, value(p) - cost * pos.base * (p / pos.entry));
    const pct = (cash / pos.base0 - 1) * 100;
    trades.push({ dir: pos.dir, pct, r: pct / ((pos.dist / pos.entry) * 100), days: (t - pos.t) / DAY, reason, entryT: pos.t, exitT: t });
    pos = null;
    arm = null;
  };
  const open = (b, dir, stopPrice) => {
    const cap = (stopPct / 100) * b.o; // 고정 손절 폭이자 눌림 손절의 상한
    const dist = Math.min(cap, stopPrice == null ? cap : dir * (b.o - stopPrice));
    if (!(dist > 0) || cash <= 0) return;
    if (lineStop) {
      const line = lineFor(b.t, dir);
      if (line != null && dir * (b.o - line) <= 0) return;
    }
    pos = { dir, entry: b.o, t: b.t, base0: cash, base: cash * (1 - cost), fundCost: 0, dist, stop: b.o - dir * dist, fixedStop: b.o - dir * dist, stopIsLine: false, target: tp ? b.o + dir * dist * tp : null };
    if (lineStop) applyLine(b.t);
  };
  for (let i = 0; i < m15.length; i++) {
    const b = m15[i];
    const newDay = b.t % DAY === 0;
    // 하루가 바뀌는 시가: 하루 수익 기록
    if (newDay && i > 0) {
      const eq = pos ? value(m15[i - 1].c) : cash;
      days.push({ t: b.t - DAY, ret: dayStartEq > 0 ? eq / dayStartEq - 1 : 0 });
      dayStartEq = eq;
    }
    // 일봉 마감 + execDelay: 일봉 청산 → 기준 진입
    if (i > 0 && b.t % DAY === execDelay) {
      const want = band > 0 ? bandWant(b.t, pos ? pos.dir : 0) : lightAt(b.t);
      if (pos && want !== pos.dir && !(recheck !== 'none' && backInside(b.t, pos.dir, b.o))) close(b.o, b.t, 'signal');
      if (want === 0) arm = null;
      if (!pos && entry === 'daily' && want !== 0 && !(recheck === 'both' && !backInside(b.t, want, b.o)) && (want > 0 || shortEntryOk(b.t))) open(b, want, null);
      else if (pos && lineStop) applyLine(b.t);
    }
    // 4시간 시가: 어제 신호로 정한 눌림 진입
    if (b.t % H4 === 0 && pendingEntry && !pos) {
      if (lightAt(b.t) === pendingEntry.dir) open(b, pendingEntry.dir, pendingEntry.stopPrice);
      pendingEntry = null;
    }
    // 펀딩(8시간마다, 들고 있으면)
    if (pos && funding && b.t % H8 === 0) {
      const r = funding.get(b.t) || 0;
      pos.fundCost += pos.dir * r * pos.base * (b.o / pos.entry);
    }
    // 손절·익절(15분봉, 한 봉에 둘 다면 손절)
    if (pos) {
      const d = pos.dir;
      const why = pos.stopIsLine ? 'line' : 'stop';
      if (d * (b.o - pos.stop) <= 0) close(b.o, b.t, why);
      else if (pos.target != null && d * (b.o - pos.target) >= 0) close(b.o, b.t, 'target');
      else if (d > 0 ? b.l <= pos.stop : b.h >= pos.stop) close(pos.stop, b.t, why);
      else if (pos.target != null && (d > 0 ? b.h >= pos.target : b.l <= pos.target)) close(pos.target, b.t, 'target');
      else if (value(d > 0 ? b.l : b.h) <= 0) close(d > 0 ? b.l : b.h, b.t, 'liquidation');
    }
    // 4시간봉 만들기
    if (b.t % H4 === 0 || !cur4) cur4 = { t: Math.floor(b.t / H4) * H4, o: b.o, h: b.h, l: b.l, c: b.c };
    else {
      cur4.h = Math.max(cur4.h, b.h);
      cur4.l = Math.min(cur4.l, b.l);
      cur4.c = b.c;
    }
    const last4 = (b.t + M15) % H4 === 0;
    if (!last4) continue;
    closes4.push(cur4.c);
    if (closes4.length > smaLen) closes4.shift();
    if (entry !== 'pullback' || pos || closes4.length < smaLen) continue;
    const sma = closes4.reduce((x, y) => x + y, 0) / smaLen;
    const dir = lightAt(b.t + M15);
    if (dir === 0) {
      arm = null;
      continue;
    }
    if (arm && arm.dir !== dir) arm = null;
    if (!arm && (dir > 0 ? cur4.l <= sma : cur4.h >= sma)) arm = { dir, extreme: dir > 0 ? cur4.l : cur4.h };
    if (!arm) continue;
    arm.extreme = dir > 0 ? Math.min(arm.extreme, cur4.l) : Math.max(arm.extreme, cur4.h);
    if (dir > 0 ? cur4.c > sma : cur4.c < sma) {
      pendingEntry = { dir, stopPrice: stop === 'pullback' ? arm.extreme * (1 - dir * 0.001) : null };
      arm = null;
    }
  }
  return { days, trades };
}

function loadCoin(sym) {
  const m15 = E.parseCandleCsv(fs.readFileSync(path.join(DATA, `${sym}USDT-15m.csv`), 'utf8'));
  const daily = E.parseCandleCsv(fs.readFileSync(path.join(DATA, `${sym}USDT-1d.csv`), 'utf8'));
  const funding = new Map();
  const fp = path.join(DATA, `${sym}USDT-funding.csv`);
  if (fs.existsSync(fp)) for (const x of parseFundingCsv(fs.readFileSync(fp, 'utf8'))) funding.set(Math.round(x.t / H8) * H8, x.rate);
  return { name: sym, m15, daily, funding };
}

const VARIANTS = [
  { name: 'E0 기준: 다음 날 09시 진입 · 손절 10% · 익절 3R(+30%)', o: { entry: 'daily', stop: 'fixed', tp: 3 } },
  { name: 'E1 4시간 눌림 · 손절 10% · 익절 3R(+30%)', o: { entry: 'pullback', stop: 'fixed', tp: 3 } },
  { name: 'E1 4시간 눌림 · 손절 눌림 바닥 · 익절 3R', o: { entry: 'pullback', stop: 'pullback', tp: 3 } },
  { name: 'E1 4시간 눌림 · 손절 눌림 바닥 · 익절 2R', o: { entry: 'pullback', stop: 'pullback', tp: 2 } },
  { name: 'E1 4시간 눌림 · 손절 눌림 바닥 · 익절 없음', o: { entry: 'pullback', stop: 'pullback', tp: 0 } },
];

function main() {
  const assets = ['BTC', 'ETH'].filter((s) => fs.existsSync(path.join(DATA, `${s}USDT-15m.csv`))).map(loadCoin);
  const out = [];
  const log = (s = '') => { console.log(s); out.push(s); };
  if (!assets.length) return log('데이터 없음');
  const start = Math.max(...assets.map((a) => a.daily[Math.min(a.daily.length - 1, 200)].t));
  const end = Math.min(...assets.map((a) => a.m15[a.m15.length - 1].t));
  const r2 = (x) => Math.round(x * 100) / 100;
  const stat = (days, from, to = Infinity) => {
    const s = T.summarizeTrend(days, { from, to });
    return s ? `${s.cagrPct}% / −${s.maxDrawdownPct}% / ${s.maxDrawdownPct > 0 ? r2(s.cagrPct / s.maxDrawdownPct) : '-'}` : '-';
  };
  log(`일봉 SMA 50·200 + 4시간 SMA20 눌림 진입 · ${assets.map((a) => a.name).join('·')} 같은 몫 · 1배 · 비용 한쪽 0.07% · 실제 펀딩 · ${new Date(start).toISOString().slice(0, 10)} ~ ${new Date(end).toISOString().slice(0, 10)}`);
  log('칸: 연% / 최대 손실 / 칼마 — 전체 · 만들기(2020~23) · 시험(2024~) | 종목당 1년 거래 · 승률 · 평균 이익/손실 % · 평균 보유일 · 가장 긴 연속 손실 · 계좌(칸 15%) 연%/최대 손실');
  for (const allowShort of [false, true]) {
    log(`\n[${allowShort ? '롱 + 숏(하락 배열일 때만)' : '롱만'}]`);
    for (const v of VARIANTS) {
      const per = assets.map((a) => simulatePullback(a.m15, a.daily, { ...v.o, allowShort, funding: a.funding }));
      const days = X.combine(per.map((p) => p.days), 1 / assets.length).filter((d) => d.t >= start);
      const trades = per.flatMap((p) => p.trades.filter((t) => t.entryT >= start));
      const years = (end - start) / (365.25 * DAY);
      const tr = X.tradeSummary(trades, years * assets.length);
      const streak = Math.max(...per.map((p) => X.worstStreak(p.trades.filter((t) => t.entryT >= start)).length));
      const acct = T.summarizeTrend(X.combine(per.map((p) => p.days), 0.15), { from: start });
      log(`  ${v.name}`);
      log(`     ${stat(days, start)} · ${stat(days, start, IS_END - 1)} · ${stat(days, IS_END)} | ${tr.perYear}번 · 승률 ${tr.win}% · +${tr.avgWin} / ${tr.avgLoss} · ${tr.hold}일 · ${streak}연패 · 계좌 ${acct ? `${acct.cagrPct}% / −${acct.maxDrawdownPct}%` : '-'}${allowShort ? ` · 숏 합계 ${tr.shortPct}%` : ''}`);
    }
  }
  fs.mkdirSync(path.join(DATA, '..', 'results'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(DATA, '..', 'results', `pullback-${stamp}.md`), '```\n' + out.join('\n') + '\n```\n');
}

if (require.main === module) main();

module.exports = { simulatePullback, dailyLights, loadCoin, VARIANTS };

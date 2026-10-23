'use strict';

// exits.js — 신호등(SMA 50·200) 매매의 롱·숏 방식과 손절·익절 방법 비교(2026-10-23, 오너 "롱숏 매매방법과 익절·손절법을 자세하게, 쉽게").
// 결과를 보기 전에 정한 것:
//   진입: 마감된 일봉 종가가 두 선 모두 위 → 다음 날 시가에 롱 · 모두 아래 → 숏(방식별) · 포지션 없을 때만 · 한 칸 전부 1배
//   방식: 롱만 / 롱·숏 / 숏은 확인 하나 더(50일선이 200일선 아래 = 하락 배열일 때만 숏)
//   손절(항상 건다 — 오너 규칙): 진입가 −3·5·8·12% / ATR14 × 1.5·2·3
//   익절: 없음 / 1·2·3R (R = 진입가에서 처음 손절까지 거리)
//   손절 올리기: 그대로 / +1R 가면 본전으로 / 가장 좋았던 가격에서 ATR×2·3 뒤를 따라감(샹들리에)
//   신호 청산: 종가가 선 하나라도 반대로 넘으면 다음 날 시가에 정리 — 켬/끔 · 기간: 7일(오너 단타 기준) / 제한 없음
//   비용 한쪽 0.07%(시장가 0.05 + 미끄러짐 0.02), 코인은 실제 펀딩. 같은 날 손절·익절 둘 다 닿으면 코인은 15분봉으로 순서를 보고,
//   15분봉이 없으면(주식) 손절로 본다(불리하게).
//   시가가 손절을 건너뛰면(갭) 시가에 나간다 — 주식은 밤사이 갭이 있다.
// 고르는 법: 한 설정이 아니라 '다른 걸 다 바꿔도 이 선택이 나은가'(칼마 중간값)로 본다. 만들기(2020~23)로 고르고 시험(2024~)은 확인만.
//   node server/backtest/exits.js                          # BTC·ETH (로컬 데이터)
//   node server/backtest/exits.js --stocks SPY QQQ NVDA TSLA   # 서버: 미국 주식 일봉(2015년~)
//   node server/backtest/exits.js --coins --stocks QQQ NVDA TSLA   # 서버: 코인 + 주식 섞은 실제 칸 계좌([4])
//   ... --account                                                   # [4] 만(격자 생략) — 칸 크기별 계좌·대결 90일 위험, 코인 숏 포함

const fs = require('fs');
const path = require('path');
const E = require('./engine');
const T = require('./trend');
const G = require('./ma-grid');

const DAY = 86400000;
const IS_END = Date.parse('2024-01-01T00:00:00Z');
const COST = 0.0007;
const MODES = { long: '롱만', both: '롱·숏', confirm: '숏은 하락 배열일 때만' };
const STOPS = [{ k: 'pct', v: 3 }, { k: 'pct', v: 5 }, { k: 'pct', v: 8 }, { k: 'pct', v: 12 }, { k: 'atr', v: 1.5 }, { k: 'atr', v: 2 }, { k: 'atr', v: 3 }];
const TPS = [0, 1, 2, 3];
const TRAILS = ['none', 'be', 'ch2', 'ch3'];
const HOLDS = [0, 7];
// [3] 쉬운 규칙 후보 — 코인 결과[1]·[2]를 보고 고른 것(코인에선 할인해서 보고, 주식이 독립 확인). 손절 10% 는 8·12% 사이 확인용.
const RECIPES = [
  { name: '추천: 롱만 · 손절 10% · 익절 3R · 신호청산', o: { mode: 'long', stop: { k: 'pct', v: 10 }, tp: 3, trail: 'none', signalExit: true, holdDays: 0 } },
  { name: '롱만 · 손절 10% · 익절 없음 · 신호청산', o: { mode: 'long', stop: { k: 'pct', v: 10 }, tp: 0, trail: 'none', signalExit: true, holdDays: 0 } },
  { name: '롱만 · 손절 ATR×3 · 익절 없음 · 신호청산', o: { mode: 'long', stop: { k: 'atr', v: 3 }, tp: 0, trail: 'none', signalExit: true, holdDays: 0 } },
  { name: '추천 + 7일 안에 정리', o: { mode: 'long', stop: { k: 'pct', v: 10 }, tp: 3, trail: 'none', signalExit: true, holdDays: 7 } },
  { name: '추천에 숏 추가(롱·숏)', o: { mode: 'both', stop: { k: 'pct', v: 10 }, tp: 3, trail: 'none', signalExit: true, holdDays: 0 } },
  { name: '추천에 숏 추가(하락 배열일 때만)', o: { mode: 'confirm', stop: { k: 'pct', v: 10 }, tp: 3, trail: 'none', signalExit: true, holdDays: 0 } },
  { name: '흔한 단타: 롱·숏 · 손절 3% · 익절 1R · 7일', o: { mode: 'both', stop: { k: 'pct', v: 3 }, tp: 1, trail: 'none', signalExit: true, holdDays: 7 } },
];

const stopLabel = (s) => (s.k === 'pct' ? `손절 ${s.v}%` : `손절 ATR×${s.v}`);
const tpLabel = (x) => (x ? `익절 ${x}R` : '익절 없음');
const trailLabel = (x) => ({ none: '손절 그대로', be: '+1R 본전', ch2: '따라가기 ATR×2', ch3: '따라가기 ATR×3' })[x];
const label = (o) => `${stopLabel(o.stop)} · ${tpLabel(o.tp)} · ${trailLabel(o.trail)} · 신호청산 ${o.signalExit ? '켬' : '끔'} · ${o.holdDays ? `${o.holdDays}일` : '기간 없음'}`;

// 한 종목. bars: [{t,o,h,l,c}] 시간순 일봉. 반환 { days:[{t,ret,inMarket}], trades:[{dir,pct,r,days,reason}] }
// 같은 날 손절·익절 둘 다 닿았을 때 15분봉으로 어느 쪽이 먼저였는지 본다. 15분봉이 없거나 한 봉에서 둘 다면 손절(불리하게).
function firstHit(minuteBars, dir, stop, target) {
  for (const m of minuteBars || []) {
    const s = dir > 0 ? m.l <= stop : m.h >= stop;
    const t = dir > 0 ? m.h >= target : m.l <= target;
    if (s) return 'stop';
    if (t) return 'target';
  }
  return 'stop';
}

// 15분봉 → Map(UTC 날짜 시작 → 그날 15분봉들)
function minutesByDay(bars15) {
  const m = new Map();
  for (const b of bars15) {
    const k = Math.floor(b.t / DAY) * DAY;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(b);
  }
  return m;
}

// exitDays: 신호 청산을 종가 며칠 연속 반대일 때 할지(1 = 하루만 아래 마감해도)
function simulateExits(bars, { mode = 'long', stop = { k: 'atr', v: 2 }, tp = 0, trail = 'none', signalExit = true, exitDays = 1, holdDays = 0, cost = COST, fundDay = null, minutes = null, fast = 50, slow = 200 } = {}) {
  const closes = bars.map((b) => b.c);
  const f = G.maSeries(closes, fast);
  const s = G.maSeries(closes, slow);
  const atr = E.atrSeries(bars, 14);
  const wanted = (i) => {
    if (f[i] == null || s[i] == null) return 0;
    const c = closes[i];
    if (c > f[i] && c > s[i]) return mode === 'shortOnly' ? 0 : 1; // shortOnly: 숏 칸만 따로 잴 때(하락 배열 숏)
    if (mode !== 'long' && c < f[i] && c < s[i] && (mode === 'both' || f[i] < s[i])) return -1;
    return 0;
  };
  const days = [];
  const trades = [];
  let cash = 1;
  let pos = null;
  let pending = 0;
  const value = (p) => pos.base * (1 + pos.dir * (p / pos.entry - 1)) - pos.fundCost;
  const exit = (p, j, reason) => {
    cash = Math.max(0, value(p) - cost * pos.base * (p / pos.entry));
    const pct = (cash / pos.base0 - 1) * 100;
    trades.push({ dir: pos.dir, pct, r: pct / ((pos.dist / pos.entry) * 100), days: (bars[j].t - pos.t) / DAY, reason, entryT: pos.t, exitT: bars[j].t });
    pos = null;
  };
  for (let j = 1; j < bars.length; j++) {
    const b = bars[j];
    const start = pos ? value(bars[j - 1].c) : cash;
    // 시가: 어제 종가로 정한 청산·진입
    if (pos && (pos.exitNext || (holdDays && b.t >= pos.t + holdDays * DAY))) exit(b.o, j, pos.exitNext ? 'signal' : 'time');
    if (!pos && pending && cash > 0) {
      const dist = stop.k === 'pct' ? (b.o * stop.v) / 100 : (atr[j - 1] || 0) * stop.v;
      if (dist > 0 && dist < b.o) pos = { dir: pending, entry: b.o, t: b.t, base0: cash, base: cash * (1 - cost), fundCost: 0, dist, stop: b.o - pending * dist, target: tp ? b.o + pending * dist * tp : null, best: b.o, exitNext: false };
    }
    pending = 0;
    // 장중: 시가가 이미 넘었으면 시가에 · 둘 다 닿은 날은 15분봉으로 순서 확인
    if (pos) {
      const d = pos.dir;
      const hitStop = d > 0 ? b.l <= pos.stop : b.h >= pos.stop;
      const hitTarget = pos.target != null && (d > 0 ? b.h >= pos.target : b.l <= pos.target);
      if (d * (b.o - pos.stop) <= 0) exit(b.o, j, 'stop');
      else if (hitTarget && d * (b.o - pos.target) >= 0) exit(b.o, j, 'target');
      else if (hitStop && hitTarget) {
        if (firstHit(minutes && minutes.get(Math.floor(b.t / DAY) * DAY), d, pos.stop, pos.target) === 'target') exit(pos.target, j, 'target');
        else exit(pos.stop, j, 'stop');
      } else if (hitStop) exit(pos.stop, j, 'stop');
      else if (hitTarget) exit(pos.target, j, 'target');
      // 펀딩이 쌓여 순자산이 0 이 되면 청산(선물은 수량이 그대로라 오래 들고 있으면 펀딩이 원금을 먹는다)
      else if (value(d > 0 ? b.l : b.h) <= 0) exit(d > 0 ? b.l : b.h, j, 'liquidation');
    }
    // 종가: 펀딩 · 손절 올리기 · 신호 확인
    const want = wanted(j);
    if (pos) {
      const d = pos.dir;
      pos.fundCost += d * (fundDay ? fundDay.get(Math.floor(b.t / DAY) * DAY) || 0 : 0) * pos.base * (b.c / pos.entry);
      pos.best = d > 0 ? Math.max(pos.best, b.h) : Math.min(pos.best, b.l);
      const tighter = (x) => (d > 0 ? Math.max(pos.stop, x) : Math.min(pos.stop, x));
      if (trail === 'be' && d * (pos.best - pos.entry) >= pos.dist) pos.stop = tighter(pos.entry);
      if ((trail === 'ch2' || trail === 'ch3') && atr[j] > 0) pos.stop = tighter(pos.best - d * (trail === 'ch2' ? 2 : 3) * atr[j]);
      pos.against = want !== d ? (pos.against || 0) + 1 : 0;
      if (signalExit && pos.against >= exitDays) {
        pos.exitNext = true;
        pending = want;
      }
    } else pending = want;
    const end = pos ? value(b.c) : cash;
    days.push({ t: b.t, ret: start > 0 ? end / start - 1 : 0, inMarket: !!pos });
  }
  return { days, trades };
}

function tradeSummary(trades, years) {
  const w = trades.filter((x) => x.pct > 0);
  const l = trades.filter((x) => x.pct <= 0);
  const sum = (a) => a.reduce((x, y) => x + y.pct, 0);
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    perYear: years > 0 ? r1(trades.length / years) : null,
    win: trades.length ? r1((w.length / trades.length) * 100) : null,
    avgWin: w.length ? r1(sum(w) / w.length) : null,
    avgLoss: l.length ? r1(sum(l) / l.length) : null,
    pf: l.length && sum(l) < 0 ? Math.round((sum(w) / Math.abs(sum(l))) * 100) / 100 : null,
    hold: trades.length ? r1(trades.reduce((x, y) => x + y.days, 0) / trades.length) : null,
    shortPct: trades.length ? r1(sum(trades.filter((x) => x.dir < 0))) : null,
  };
}

// 여러 종목을 칸 크기 w 로 합친 계좌 하루 수익률 — 날짜는 합집합(주식이 쉬는 주말은 그 종목 0)
function combine(lists, w) {
  const by = new Map();
  for (const list of lists) for (const d of list) by.set(d.t, (by.get(d.t) || 0) + w * d.ret);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, ret]) => ({ t, ret }));
}

// 가장 길게 연속으로 진 거래들
function worstStreak(trades) {
  let best = [];
  let cur = [];
  for (const t of trades) {
    if (t.pct <= 0) {
      cur.push(t);
      if (cur.length > best.length) best = [...cur];
    } else cur = [];
  }
  return best;
}

// 대결 규칙(owner-record: 시작 금액 대비 −15% 면 끝, 90일)으로 본 위험 — 매일 새로 시작했다고 치고 90일씩
function contestWindows(days, from, { len = 90, loss = 15 } = {}) {
  const d = days.filter((x) => x.t >= from);
  const eq = [1];
  for (const x of d) eq.push(eq[eq.length - 1] * (1 + x.ret));
  const ends = [];
  let hit = 0;
  for (let i = 0; i + len < eq.length; i++) {
    let low = Infinity;
    for (let k = i + 1; k <= i + len; k++) low = Math.min(low, eq[k] / eq[i]);
    if (low <= 1 - loss / 100) hit++;
    ends.push((eq[i + len] / eq[i] - 1) * 100);
  }
  if (!ends.length) return null;
  ends.sort((a, b) => a - b);
  const r1 = (x) => Math.round(x * 10) / 10;
  return { n: ends.length, hitPct: r1((hit / ends.length) * 100), worst: r1(ends[0]), median: r1(ends[Math.floor(ends.length / 2)]), negPct: r1((ends.filter((x) => x < 0).length / ends.length) * 100) };
}

const median = (a) => {
  const v = a.filter((x) => x != null).sort((x, y) => x - y);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};

function main() {
  const argv = process.argv.slice(2);
  const si = argv.indexOf('--stocks');
  const isStock = si >= 0;
  const withCoins = !isStock || argv.includes('--coins');
  const assets = [...(withCoins ? G.loadCoins() : []), ...(isStock ? G.loadStocks(argv.slice(si + 1).filter((x) => !x.startsWith('--')).map((x) => x.toUpperCase())) : [])];
  for (const a of assets) {
    const p15 = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data', `${a.name}USDT-15m.csv`);
    a.minutes = fs.existsSync(p15) ? minutesByDay(E.parseCandleCsv(fs.readFileSync(p15, 'utf8'))) : null;
  }
  const out = [];
  const log = (s = '') => { console.log(s); out.push(s); };
  if (!assets.length) return log('데이터 없음');
  const start = Math.max(...assets.map((a) => a.bars[Math.min(a.bars.length - 1, 200)].t));
  const stat = (days, from, to = Infinity) => {
    const s = T.summarizeTrend(days, { from, to });
    return s ? { cagr: s.cagrPct, dd: s.maxDrawdownPct, calmar: s.maxDrawdownPct > 0 ? Math.round((s.cagrPct / s.maxDrawdownPct) * 100) / 100 : null } : null;
  };
  log(`신호등 SMA 50·200 + 손절·익절 비교 · ${assets.map((a) => a.name).join('·')} 같은 몫 · 한 칸 1배 · 비용 한쪽 ${Math.round(COST * 10000) / 100}%${withCoins ? ' · 코인은 실제 펀딩, 같은 날 손절·익절 둘 다면 15분봉으로 순서' : ''}${isStock ? ' · 주식은 펀딩 빠짐, 같은 날 둘 다면 손절로 봄' : ''} · ${new Date(start).toISOString().slice(0, 10)}부터`);
  const evaluate = (o) => {
    const per = assets.map((a) => simulateExits(a.bars, { ...o, fundDay: a.fundDay, minutes: a.minutes }));
    const days = combine(per.map((x) => x.days), 1 / assets.length);
    const trades = per.flatMap((x) => x.trades);
    const years = days.length ? (days[days.length - 1].t - start) / (365.25 * DAY) : 0;
    return { o, all: stat(days, start), is: stat(days, start, IS_END - 1), oos: stat(days, Math.max(start, IS_END)), each: per.map((x) => stat(x.days, start)), tr: tradeSummary(trades, years * assets.length) };
  };
  const rows = [];
  const accountOnly = argv.includes('--account'); // [4] 계좌 기준만(격자 생략 — 서버에서 빨리)
  if (!accountOnly) for (const mode of Object.keys(MODES)) for (const stop of STOPS) for (const tp of TPS) for (const trail of TRAILS) for (const signalExit of [true, false]) for (const holdDays of HOLDS) rows.push(evaluate({ mode, stop, tp, trail, signalExit, holdDays }));
  const cal = (s) => (s && s.calmar != null ? s.calmar : null);
  const fmt = (x) => (x == null ? '-' : String(x));
  // 1) 선택 하나의 효과 — 나머지를 다 바꿔 본 칼마 중간값
  if (!accountOnly) log('\n[1] 이 선택이 나은가 — 다른 설정을 전부 바꿔 본 칼마 중간값 (만들기 2020~23 / 시험 2024~)');
  const dims = [
    ['방식', (o) => MODES[o.mode], Object.values(MODES)],
    ['손절', (o) => stopLabel(o.stop), STOPS.map(stopLabel)],
    ['익절', (o) => tpLabel(o.tp), TPS.map(tpLabel)],
    ['손절 올리기', (o) => trailLabel(o.trail), TRAILS.map(trailLabel)],
    ['신호 청산', (o) => (o.signalExit ? '켬' : '끔'), ['켬', '끔']],
    ['기간', (o) => (o.holdDays ? `${o.holdDays}일` : '기간 없음'), HOLDS.map((h) => (h ? `${h}일` : '기간 없음'))],
  ];
  if (!accountOnly) for (const [name, key, values] of dims) {
    const cells = values.map((v) => {
      const g = rows.filter((r) => key(r.o) === v);
      return `${v} ${fmt(median(g.map((r) => cal(r.is))))}/${fmt(median(g.map((r) => cal(r.oos))))}`;
    });
    log(`  ${name}: ${cells.join(' · ')}`);
  }
  // 2) 방식별 만들기 구간 상위 5개와 시험 구간 성적
  const show = (title, r) => {
    log(`  ${title}`);
    log(`     ${fmt(cal(r.all))} / ${fmt(cal(r.is))} / ${fmt(cal(r.oos))} · 연 ${fmt(r.all && r.all.cagr)}% · −${fmt(r.all && r.all.dd)}% · ${fmt(r.tr.perYear)}번 · 승률 ${fmt(r.tr.win)}% · +${fmt(r.tr.avgWin)} / ${fmt(r.tr.avgLoss)} · ${fmt(r.tr.hold)}일 · ${assets.map((a, i) => `${a.name} ${fmt(cal(r.each[i]))}`).join(' ')}${r.o.mode === 'long' ? '' : ` · 숏 합계 ${fmt(r.tr.shortPct)}%`}`);
  };
  const cols = '(전체 / 만들기 / 시험 칼마 · 연% · 최대 손실 · 종목당 1년 거래 수 · 승률 · 평균 이익/손실 % · 평균 보유일 · 종목별 칼마)';
  if (!accountOnly) for (const mode of Object.keys(MODES)) {
    log(`\n[2] ${MODES[mode]} — 만들기 구간 칼마 상위 5 ${cols}`);
    const top = rows.filter((r) => r.o.mode === mode).sort((a, b) => (cal(b.is) ?? -9) - (cal(a.is) ?? -9)).slice(0, 5);
    for (const r of top) show(label(r.o), r);
  }
  if (!accountOnly) log(`\n[3] 쉬운 규칙 후보 ${cols}`);
  if (!accountOnly) for (const x of RECIPES) show(x.name, evaluate(x.o));
  // 4) 계좌 기준 — 추천 규칙을 종목마다 한 칸씩(칸 크기 10·15·20%) 했을 때. 빈 칸은 현금(이자 0)
  const rec = RECIPES[0];
  const per = assets.map((a) => simulateExits(a.bars, { ...rec.o, fundDay: a.fundDay, minutes: a.minutes }));
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  log(`\n[4] 계좌 기준 — '${rec.name}'을 ${assets.map((a) => a.name).join('·')} 한 칸씩`);
  per.forEach((p, i) => {
    const st = worstStreak(p.trades.filter((t) => t.entryT >= start));
    if (st.length) log(`  ${assets[i].name}: 가장 긴 연속 손실 ${st.length}번 (${iso(st[0].entryT)} ~ ${iso(st[st.length - 1].exitT)}) · 그 동안 그 칸 ${Math.round((st.reduce((m, t) => m * (1 + t.pct / 100), 1) - 1) * 1000) / 10}% · 가장 큰 한 번 손실 ${Math.round(Math.min(...p.trades.map((t) => t.pct)) * 10) / 10}%`);
  });
  // 오너 규칙의 코인 숏(하락 배열일 때만 · 손절 4% · 익절 2R) — 롱과 같은 칸 크기로 코인에만 더한다(2026-10-23)
  const coins = assets.filter((a) => a.fundDay);
  const shortPer = coins.map((a) => simulateExits(a.bars, { mode: 'shortOnly', stop: { k: 'pct', v: 4 }, tp: 2, trail: 'none', signalExit: true, holdDays: 0, fundDay: a.fundDay, minutes: a.minutes }));
  const plans = [['롱만', per]];
  if (shortPer.length) plans.push(['롱 + 코인 숏(4%·8%)', [...per, ...shortPer]]);
  for (const w of [0.1, 0.15, 0.2]) for (const [pname, list] of plans) {
    const days = combine(list.map((p) => p.days), w);
    const s = T.summarizeTrend(days, { from: start });
    const cw = contestWindows(days, start);
    if (s) log(`  칸 ${w * 100}% ${pname} (최대 ${Math.round(w * assets.length * 100)}% 사용): 연 ${s.cagrPct}% · 계좌 최대 손실 −${s.maxDrawdownPct}% · 최악의 달 ${s.worstMonthPct}% · 대결 90일 −15% 로 끝 ${cw ? cw.hitPct : '-'}% · 90일 최악 ${cw ? cw.worst : '-'}% · 중간 ${cw ? cw.median : '-'}% · 연도별 ${Object.entries(s.byYear).map(([y, x]) => `${y} ${x}%`).join(' · ')}`);
  }
  fs.mkdirSync(path.join(__dirname, '..', '..', 'reports', 'backtest', 'results'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.writeFileSync(path.join(__dirname, '..', '..', 'reports', 'backtest', 'results', `exits-${isStock ? (withCoins ? 'mix' : 'stocks') : 'coins'}-${stamp}.md`), '```\n' + out.join('\n') + '\n```\n');
}

if (require.main === module) main();

module.exports = { simulateExits, tradeSummary, firstHit, minutesByDay, combine, worstStreak, contestWindows, RECIPES };

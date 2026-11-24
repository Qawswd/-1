'use strict';

// claude-trader.js — 세 번째 선수 'Claude 분석'(오너 요청 2026-10-15: "너도 최선의 분석을 따로 해서 따로 기록해놔, 누가 이기는지 보게").
// 하루 두 번(한국 runsKst 09:30·23:40) claude 를 한 번씩 불러(기본 opus, 뉴스 검색 허용) 시장 데이터와 내 가상 장부를 주고 판단(JSON)을 받는다.
// **가상 장부만** — 거래소 주문 경로가 없다(공개 시세 GET 만). 규칙은 오너와 같다:
//   1배(열린 포지션 명목가 합 ≤ 순자산) · 모든 진입에 손절(0.3~25%) · BTC·ETH·바이낸스 미국 주식만 · 손절은 당기기만 · 누적 −15% 면 끝.
// 채점은 바이낸스 실계좌 공개 시세: 진입은 판단 직후 마크 가격, 손절·익절은 5분마다 1분봉 고가·저가로 확인(한 봉에 둘 다면 손절 먼저).
// 비용: 진입·청산 각 0.05% · 펀딩(롱이 양수 펀딩을 낸다, 숏은 받는다).

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const AG = require('./agents');
const EX = require('./exchange');
const { kstParts } = require('./trend-follow');
const OR = require('./owner-record');

const FAPI = 'https://fapi.binance.com';
const STATE_PATH = path.join(__dirname, '..', 'reports', 'claude-trader.json');
const DAY = 86400000;
const MIN = 60000;
const UNIVERSE = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SPYUSDT', 'QQQUSDT', 'NVDAUSDT', 'TSLAUSDT', 'AAPLUSDT', 'MSFTUSDT', 'AMZNUSDT', 'GOOGLUSDT', 'METAUSDT']);
const DEFAULTS = Object.freeze({ enabled: false, model: 'opus', runsKst: ['09:30', '23:40'], capital: 10000, days: 90, maxLossPct: 15, maxPositions: 4, monitorEveryMin: 5, feePct: 0.05, webSearch: true, timeoutSec: 300 });

function effectiveParams(cfg) {
  const c = cfg && typeof cfg === 'object' ? cfg : {};
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const runs = Array.isArray(c.runsKst) ? c.runsKst.filter((x) => /^\d{2}:\d{2}$/.test(String(x))).slice(0, 4) : [];
  return {
    enabled: c.enabled === true,
    model: /^[a-z0-9.-]+$/i.test(String(c.model || '')) ? String(c.model) : DEFAULTS.model,
    runsKst: runs.length ? runs.sort() : [...DEFAULTS.runsKst],
    capital: num(c.capital, 100, 1e9, DEFAULTS.capital),
    days: num(c.days, 7, 365, DEFAULTS.days),
    maxLossPct: num(c.maxLossPct, 1, 60, DEFAULTS.maxLossPct),
    maxPositions: num(c.maxPositions, 1, 8, DEFAULTS.maxPositions),
    monitorEveryMin: num(c.monitorEveryMin, 1, 60, DEFAULTS.monitorEveryMin),
    feePct: num(c.feePct, 0, 1, DEFAULTS.feePct),
    webSearch: c.webSearch !== false,
    timeoutSec: num(c.timeoutSec, 60, 900, DEFAULTS.timeoutSec),
  };
}

// --- 지표(일봉·1시간봉 → 판단용 숫자) -------------------------------------------------
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const smaOf = (arr, n) => (arr.length >= n ? arr.slice(-n).reduce((a, b) => a + b, 0) / n : null);
function rsiOf(closes, n = 14) {
  if (closes.length <= n) return null;
  let g = 0;
  let l = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d;
    else l -= d;
  }
  return l === 0 ? 100 : r2(100 - 100 / (1 + g / l));
}
const parseKlines = (rows) => (Array.isArray(rows) ? rows.map((k) => ({ t: Number(k[0]), o: Number(k[1]), h: Number(k[2]), l: Number(k[3]), c: Number(k[4]), v: Number(k[7] != null ? k[7] : k[5]) })).filter((b) => Number.isFinite(b.c)) : []);

// 일봉은 마지막(진행 중) 봉을 빼고 본다 — 끝난 봉만으로 지표를 만든다
function features(daily, hourly, mark, h4 = []) {
  const d = daily.slice(0, -1);
  const closes = d.map((b) => b.c);
  const price = Number(mark) || (daily.length ? daily[daily.length - 1].c : null);
  if (!price || closes.length < 2) return null;
  const pctFrom = (x) => (x ? r2((price / x - 1) * 100) : null);
  const at = (k) => (closes.length > k ? closes[closes.length - 1 - k] : null);
  let atr = null;
  if (d.length > 15) {
    let s = 0;
    for (let i = d.length - 14; i < d.length; i++) s += Math.max(d[i].h - d[i].l, Math.abs(d[i].h - d[i - 1].c), Math.abs(d[i].l - d[i - 1].c));
    atr = r2((s / 14 / price) * 100);
  }
  const last30 = d.slice(-30);
  const h = hourly.slice(-48);
  return {
    price,
    chg1d: pctFrom(at(0)),
    chg7d: pctFrom(at(6)),
    chg30d: pctFrom(at(29)),
    vsSma20: pctFrom(smaOf(closes, 20)),
    vsSma50: pctFrom(smaOf(closes, 50)),
    vsSma200: pctFrom(smaOf(closes, 200)),
    rsi14: rsiOf(closes),
    atrPct: atr,
    vsHigh30: last30.length ? pctFrom(Math.max(...last30.map((b) => b.h))) : null,
    vsLow30: last30.length ? pctFrom(Math.min(...last30.map((b) => b.l))) : null,
    chg24h: h.length >= 24 ? pctFrom(h[h.length - 24].o) : null,
    chg48h: h.length ? pctFrom(h[0].o) : null,
    vs4hSma20: h4.length > 20 ? pctFrom(smaOf(h4.slice(0, -1).map((b) => b.c), 20)) : null,
    volVs7d: d.length > 8 && d.slice(-8, -1).every((b) => b.v > 0) ? r2(d[d.length - 1].v / (d.slice(-8, -1).reduce((a, b) => a + b.v, 0) / 7)) : null,
    days: closes.length,
  };
}

// 핵심 종목 말고, 오늘 거래대금 상위·많이 움직인 바이낸스 미국 주식(오너가 어떤 미국 주식이든 살 수 있으니 공평하게).
// tickers = GET /fapi/v1/ticker/24hr 전체, info = exchangeInfo. 거래대금 상위 8 + (거래대금 중간 이상 중) 등락 상위 4.
// Yahoo 로 미국 주식·ETF 라고 확인된 것만(fetch-tradfi.js 목록) — 레버리지 ETF 같은 모르는 상품은 고르지 않는다(2026-10-15 서버: SNXX·MVLL·RAM 이 섞였다).
function pickExtraStocks(tickers, info, core = UNIVERSE, n = 12) {
  const rows = (Array.isArray(tickers) ? tickers : [])
    .filter((t) => t && /USDT$/.test(t.symbol) && !core.includes(t.symbol) && OR.isAllowedSymbol(t.symbol, info, { strict: true }) === true && !/^(BTC|ETH)/.test(t.symbol))
    .map((t) => ({ symbol: t.symbol, qv: Number(t.quoteVolume) || 0, chg: Math.abs(Number(t.priceChangePercent)) || 0 }));
  const byVol = [...rows].sort((a, b) => b.qv - a.qv);
  const picked = byVol.slice(0, Math.min(8, n)).map((x) => x.symbol);
  const median = byVol.length ? byVol[Math.floor(byVol.length / 2)].qv : 0;
  for (const x of rows.filter((r) => r.qv >= median && !picked.includes(r.symbol)).sort((a, b) => b.chg - a.chg)) {
    if (picked.length >= n) break;
    picked.push(x.symbol);
  }
  return picked;
}

// --- 가상 장부 -------------------------------------------------------------------------
const dirOf = (side) => (side === 'LONG' ? 1 : -1);
function equityOf(st, marks) {
  let eq = st.cash;
  for (const p of st.positions) {
    const m = Number(marks && marks[p.symbol]) || p.lastMark || p.entry;
    eq += p.qty * (m - p.entry) * dirOf(p.side);
  }
  return r2(eq);
}
function notionalPctOf(st, marks, equity) {
  if (!(equity > 0)) return Infinity;
  let n = 0;
  for (const p of st.positions) n += p.qty * (Number(marks && marks[p.symbol]) || p.lastMark || p.entry);
  return (n / equity) * 100;
}

// 판단(JSON actions) → 실행할 것 / 거절(이유). 순서: 청산 → 손절 당기기 → 진입(청산으로 생긴 여유를 쓸 수 있게)
function validateActions(actions, { st, marks, p, isAllowed = (sym) => UNIVERSE.includes(sym) }) {
  const list = Array.isArray(actions) ? actions.filter((a) => a && typeof a === 'object') : [];
  const accepted = [];
  const rejected = [];
  const open = new Map(st.positions.map((x) => [x.symbol, x]));
  const order = { CLOSE: 0, MOVE_STOP: 1, OPEN: 2 };
  const sorted = [...list].sort((a, b) => (order[String(a.type).toUpperCase()] ?? 9) - (order[String(b.type).toUpperCase()] ?? 9));
  let equity = equityOf(st, marks);
  let usedPct = notionalPctOf(st, marks, equity);
  for (const a of sorted) {
    const type = String(a.type || '').toUpperCase();
    const symbol = String(a.symbol || '').toUpperCase();
    const price = Number(marks && marks[symbol]);
    const no = (why) => rejected.push({ action: a, why });
    if (!isAllowed(symbol)) { no('허용 종목 아님'); continue; }
    if (type === 'CLOSE') {
      if (!open.has(symbol)) { no('열린 포지션 없음'); continue; }
      const pos = open.get(symbol);
      open.delete(symbol);
      usedPct -= (pos.qty * (price || pos.entry) / equity) * 100;
      accepted.push({ type, symbol, reason: String(a.reason || '').slice(0, 300) });
      continue;
    }
    if (!(price > 0)) { no('현재가 없음'); continue; }
    const stop = Number(a.stop);
    if (type === 'MOVE_STOP') {
      const pos = open.get(symbol);
      if (!pos) { no('열린 포지션 없음'); continue; }
      const tighter = pos.side === 'LONG' ? stop > pos.stop && stop < price : stop < pos.stop && stop > price;
      if (!(Number.isFinite(stop) && tighter)) { no('손절은 손실을 줄이는 쪽으로만, 현재가 반대편에만'); continue; }
      accepted.push({ type, symbol, stop });
      continue;
    }
    if (type !== 'OPEN') { no('모르는 행동'); continue; }
    const side = String(a.side || '').toUpperCase();
    const sizePct = Number(a.sizePct);
    const target = a.target == null || a.target === '' ? null : Number(a.target);
    if (!['LONG', 'SHORT'].includes(side)) { no('방향 없음'); continue; }
    if (open.has(symbol)) { no('같은 종목 포지션이 이미 있음'); continue; }
    if (open.size >= p.maxPositions) { no(`포지션 최대 ${p.maxPositions}개`); continue; }
    if (!(sizePct > 0 && sizePct <= 100)) { no('크기(sizePct) 0~100'); continue; }
    if (usedPct + sizePct > 100.0001) { no(`1배 넘음(이미 ${r2(usedPct)}% + ${sizePct}%)`); continue; }
    const dist = Math.abs(price - stop) / price;
    const sideOk = side === 'LONG' ? stop < price : stop > price;
    if (!(Number.isFinite(stop) && sideOk && dist >= 0.003 && dist <= 0.25)) { no('손절 필수 — 현재가 반대편 0.3~25%'); continue; }
    if (target != null && !(Number.isFinite(target) && (side === 'LONG' ? target > price : target < price))) { no('목표가가 반대편'); continue; }
    open.set(symbol, { symbol, side });
    usedPct += sizePct;
    accepted.push({ type, symbol, side, sizePct, stop, target, reason: String(a.reason || '').slice(0, 300) });
  }
  return { accepted, rejected };
}

function openPos(st, a, price, p, t) {
  const equity = equityOf(st, { [a.symbol]: price });
  const qty = (equity * a.sizePct) / 100 / price;
  st.cash -= qty * price * (p.feePct / 100);
  const pos = { id: `${a.symbol}-${t}`, symbol: a.symbol, side: a.side, qty, entry: price, stop: a.stop, target: a.target, openedAt: t, lastMark: price, reason: a.reason, nextFundingTime: null };
  st.positions.push(pos);
  return pos;
}
function closePos(st, pos, price, why, p, t) {
  const pnl = pos.qty * (price - pos.entry) * dirOf(pos.side);
  const fee = pos.qty * price * (p.feePct / 100);
  st.cash += pnl - fee;
  st.positions = st.positions.filter((x) => x !== pos);
  const rec = { symbol: pos.symbol, side: pos.side, entry: pos.entry, exit: price, qty: pos.qty, openedAt: pos.openedAt, closedAt: t, why, pnl: r2(pnl - fee), pct: r2(((price / pos.entry - 1) * 100) * dirOf(pos.side)), funding: r2(pos.funding || 0), reason: pos.reason };
  st.closed.push(rec);
  return rec;
}

// 1분봉(시간순)으로 손절·익절 도달 확인 — 한 봉에 둘 다면 손절 먼저(보수적), 갭이면 시가
function checkExit(pos, candles) {
  for (const b of candles) {
    if (b.t < pos.openedAt) continue; // 진입 전 가격이 섞인 봉은 보지 않는다
    if (pos.side === 'LONG') {
      if (b.l <= pos.stop) return { why: '손절', price: Math.min(b.o, pos.stop), t: b.t };
      if (pos.target != null && b.h >= pos.target) return { why: '익절', price: Math.max(b.o, pos.target), t: b.t };
    } else {
      if (b.h >= pos.stop) return { why: '손절', price: Math.max(b.o, pos.stop), t: b.t };
      if (pos.target != null && b.l <= pos.target) return { why: '익절', price: Math.min(b.o, pos.target), t: b.t };
    }
  }
  return null;
}

// 순자산 기록 [{t, equity}] 에서 t0 이후 첫 기록 → 마지막 기록 수익률(%)
function returnSince(snaps, t0 = -Infinity, key = 'equity') {
  const list = (Array.isArray(snaps) ? snaps : []).filter((s) => s && Number(s[key]) > 0);
  const first = list.find((s) => s.t >= t0) || null;
  const last = list[list.length - 1];
  return first && last && first !== last ? r2((last[key] / first[key] - 1) * 100) : null;
}

// 닫힌 거래 성적(서버 계산 — 복기의 근거). 운과 실력을 가르려면 숫자가 먼저다.
function tradeStats(closed) {
  const list = Array.isArray(closed) ? closed : [];
  const part = (arr) => {
    const wins = arr.filter((x) => x.pnl > 0);
    const gain = wins.reduce((a, x) => a + x.pnl, 0);
    const loss = Math.abs(arr.filter((x) => x.pnl <= 0).reduce((a, x) => a + x.pnl, 0));
    return {
      n: arr.length,
      winRate: arr.length ? r2((wins.length / arr.length) * 100) : null,
      avgPct: arr.length ? r2(arr.reduce((a, x) => a + (x.pct || 0), 0) / arr.length) : null,
      pf: loss > 0 ? r2(gain / loss) : null,
      pnl: r2(arr.reduce((a, x) => a + (x.pnl || 0), 0)),
      holdHours: arr.length ? r2(arr.reduce((a, x) => a + ((x.closedAt - x.openedAt) || 0), 0) / arr.length / 3600000) : null,
    };
  };
  const isCoin = (x) => /^(BTC|ETH)/.test(x.symbol);
  return {
    all: part(list),
    long: part(list.filter((x) => x.side === 'LONG')),
    short: part(list.filter((x) => x.side === 'SHORT')),
    coin: part(list.filter(isCoin)),
    stock: part(list.filter((x) => !isCoin(x))),
    byExit: Object.fromEntries(['손절', '익절', '판단 청산'].map((k) => [k, list.filter((x) => x.why === k).length])),
  };
}
const statLine = (label, x) => `${label} ${x.n}번${x.n ? ` · 이긴 비율 ${x.winRate}% · 평균 ${x.avgPct}% · 손익비(PF) ${x.pf ?? '-'} · 합 ${x.pnl} USDT · 평균 보유 ${x.holdHours}시간` : ''}`;

const fmtN = (v) => (v == null ? '-' : String(v));
function buildPrompt({ now, feats, funding, st, marks, p }) {
  const { dateKey, hhmm } = kstParts(new Date(now));
  const equity = equityOf(st, marks);
  const total = r2((equity / p.capital - 1) * 100);
  const order = [...UNIVERSE.filter((x) => feats[x]), ...Object.keys(feats).filter((x) => !UNIVERSE.includes(x))];
  const rows = order.map((s) => {
    const f = feats[s];
    return `${s} | ${f.price} | ${fmtN(f.chg24h)} | ${fmtN(f.chg7d)} | ${fmtN(f.chg30d)} | ${fmtN(f.vs4hSma20)} | ${fmtN(f.vsSma20)} | ${fmtN(f.vsSma50)} | ${fmtN(f.vsSma200)} | ${fmtN(f.rsi14)} | ${fmtN(f.atrPct)} | ${fmtN(f.vsHigh30)} | ${fmtN(f.vsLow30)} | ${fmtN(f.volVs7d)} | ${funding[s] == null ? '-' : r2(funding[s] * 100 * 1000) / 1000} | ${f.days}`;
  });
  const pos = st.positions.length
    ? st.positions.map((x) => `- ${x.symbol} ${x.side} 진입 ${x.entry} · 손절 ${x.stop} · 목표 ${x.target ?? '없음'} · 지금 ${marks[x.symbol] ?? '-'} (${r2(((Number(marks[x.symbol]) / x.entry - 1) * 100) * dirOf(x.side))}%) · 이유: ${x.reason || '-'}`).join('\n')
    : '- 없음';
  const recent = st.closed.slice(-10).map((x) => `- ${x.symbol} ${x.side} ${x.entry}→${x.exit} ${x.why} ${x.pct}%`).join('\n') || '- 아직 없음';
  return [
    `너는 'Claude 분석' 선수다. 대표님(바이낸스 실계좌 직접 매매)·시스템(일봉 평균선 추세추종, 롱만)과 ${p.days}일 동안 가상 계좌 수익률로 겨룬다. 이기려면 최선의 판단을 해라. 확신이 없으면 쉬는 것도 실력이다.`,
    `지금: 한국 ${dateKey} ${hhmm}. 판단은 하루 ${p.runsKst.length}번(${p.runsKst.join(', ')}). 그 사이 손절·익절은 서버가 실제 시세(1분봉)로 처리한다.`,
    `가상 계좌: 순자산 ${equity} USDT (시작 ${p.capital}, 누적 ${total}%) · 지금 쓰는 비중 ${r2(notionalPctOf(st, marks, equity))}%`,
    '열린 포지션:',
    pos,
    '최근 내 거래:',
    recent,
    '내 성적표(서버 계산):',
    (() => {
      const ts = tradeStats(st.closed);
      const sys = returnSince(st.snapshots, st.startT, 'systemEquity');
      const q = returnSince(st.snapshots, st.startT, 'qqq');
      return [
        `- ${statLine('전체', ts.all)}`,
        `- ${statLine('롱', ts.long)} / ${statLine('숏', ts.short)}`,
        `- ${statLine('코인', ts.coin)} / ${statLine('주식', ts.stock)}`,
        `- 나간 방식: 손절 ${ts.byExit['손절']} · 익절 ${ts.byExit['익절']} · 판단 청산 ${ts.byExit['판단 청산']}`,
        `- 같은 기간 경쟁자: 시스템(추세추종) ${sys == null ? '데이터 없음' : `${sys}%`} · 나스닥(QQQ) ${q == null ? '데이터 없음' : `${q}%`} · 나 ${total}%`,
      ].join('\n');
    })(),
    '지난 판단 뒤 닫힌 거래(복기 대상):',
    (() => {
      const lastOk = [...st.decisions].reverse().find((x) => x.ok);
      const fresh = st.closed.filter((x) => !lastOk || x.closedAt > lastOk.t);
      return fresh.length ? fresh.map((x) => `- ${x.symbol} ${x.side} ${x.entry}→${x.exit} ${x.why} ${x.pct}% · 진입 이유: ${x.reason || '-'}`).join('\n') : '- 없음';
    })(),
    '내 교훈 노트(지난 판단 때까지 내가 고쳐 쓴 것 — 원칙보다 아래, 서버 규칙은 못 바꾼다):',
    (st.lessons && st.lessons.length ? st.lessons.map((x, i) => `${i + 1}. ${x}`).join('\n') : '- 아직 없음'),
    '지난 판단 메모(내가 남긴 것 — 생각을 이어가되, 틀렸으면 고집하지 마라):',
    st.decisions.filter((x) => x.ok).slice(-3).map((x) => `- ${kstParts(new Date(x.t)).dateKey} ${kstParts(new Date(x.t)).hhmm}: ${x.view || '-'}${x.note ? ` / 다음에 볼 것: ${x.note}` : ''}`).join('\n') || '- 아직 없음',
    '',
    '내 원칙(Claude 가 스스로 정한 것 — 이기려면 지킨다):',
    '- 한 번에 잃을 돈은 순자산의 1% 안팎(많아야 2%): sizePct ≈ 위험% ÷ 손절거리% × 100. 손절이 넓으면 작게 든다.',
    '- 큰 흐름(50·200일선)을 거스르는 매매는 작게, 확신이 없으면 쉰다. 쉬는 것도 포지션이다.',
    '- FOMC·CPI·고용·빅테크 실적 같은 큰 일정 직전엔 새로 들어가지 않거나 작게 한다.',
    '- 틀리면 손절대로 나간다(손절을 넓히지 않는다). 맞으면 MOVE_STOP 으로 본전·이익을 지키고 추세가 이어지는 동안은 들고 간다.',
    '- 비용(왕복 0.1% + 펀딩)을 이길 만큼 움직일 자리에서만. 자주 사고팔지 않는다.',
    '- 주식 무기한은 미국 장 시간(한국 밤)에 크게 움직이고, 주말·휴장에는 거래가 얇다.',
    '',
    '규칙(서버가 강제한다 — 어긴 행동은 실행되지 않는다):',
    '- 종목: BTC·ETH + 바이낸스 미국 주식(지수 ETF 포함, 미국 상장으로 확인된 것만). 아래 표 = 핵심 11개 + 오늘 거래대금·움직임 상위 미국 주식. 표에 없는 미국 주식도 되지만 데이터 없이 들어가지 마라. 원자재·레버리지 ETF·한국/홍콩 주식·알트코인은 안 된다.',
    '- 1배: 열린 포지션 명목가 합 ≤ 순자산의 100%. sizePct = 순자산 대비 명목가 %.',
    '- 모든 진입에 손절(stop) 필수: 롱은 현재가 아래, 숏은 위, 거리 0.3%~25%. 목표(target)는 선택.',
    `- 포지션 최대 ${p.maxPositions}개, 종목당 하나. 손절은 당기기만(MOVE_STOP 은 손실을 줄이는 쪽으로만).`,
    `- 비용: 진입·청산 각 ${p.feePct}%, 펀딩(롱이 양수 펀딩을 낸다, 숏은 받는다). 누적 −${p.maxLossPct}% 면 경기 끝.`,
    '',
    '데이터(바이낸스 실시간 공개 시세. 일봉은 끝난 봉 기준. 숫자는 % — 현재가가 그 값보다 몇 % 위/아래인지):',
    '종목 | 현재가 | 24시간 | 7일 | 30일 | 4시간20봉선 | 20일선 | 50일선 | 200일선 | RSI14 | 일봉ATR% | 30일고점 | 30일저점 | 어제거래대금÷7일평균(배) | 펀딩(%/회) | 일봉수',
    ...rows,
    '주식 무기한은 2026년에 상장해 일봉이 짧다(200일선이 없을 수 있다). 미국 주식은 미국 장 시간에 크게 움직인다.',
    p.webSearch ? '필요하면 WebSearch 로 최신 뉴스·일정(FOMC·CPI·실적)을 찾아봐도 된다. 찾지 못한 건 지어내지 마라.' : '데이터에 없는 숫자를 지어내지 마라.',
    '',
    '판단하기 전에 먼저 복기하라(매번 — 갈수록 나아지기 위해):',
    '- 지난 판단·닫힌 거래가 왜 그렇게 됐나? 진입 이유가 맞았는데 운이 나빴나, 판단이 틀렸나(근거 부족·추세 역행·일정 무시·크기 과다·손절 위치)? 맞았다면 무엇이 통했나?',
    '- 성적표에서 반복되는 패턴(롱/숏, 코인/주식, 손절이 너무 가까움 등)을 찾고 교훈 노트를 고쳐 써라: 맞는 건 남기고, 틀린 건 고치거나 빼고, 새로 배운 건 더한다(최대 12개, 한 줄씩).',
    '- 한두 번 결과로 원칙을 뒤집지 마라(표본이 작으면 운이 크다). 여러 번 반복된 것만 교훈이 된다. 경쟁자보다 뒤처지면 무엇을 다르게 할지 적어라.',
    '',
    '출력은 JSON 하나만(설명 문장 없이):',
    '{"review":"지난 판단·거래 복기 2~4문장","postmortems":[{"symbol":"BTCUSDT","lesson":"닫힌 거래 한 줄 복기"}],"lessons":["교훈 노트 전체(고친 판, 최대 12줄)"],"view":"한두 문장 시장 판단","actions":[{"type":"OPEN","symbol":"BTCUSDT","side":"LONG","sizePct":30,"stop":0,"target":null,"reason":"짧게"},{"type":"CLOSE","symbol":"ETHUSDT","reason":"짧게"},{"type":"MOVE_STOP","symbol":"SPYUSDT","stop":0}],"note":"다음 판단 때 볼 것"}',
    '아무것도 안 하는 게 최선이면 "actions": [] 로.',
  ].join('\n');
}

// --- claude 부르기(한 번, 재시도 없음 — 한도면 그날은 건너뛴다) -------------------------------
function spawnClaude(prompt, { model, webSearch, timeoutSec }) {
  return new Promise((resolve) => {
    const cmd = `${AG.resolveClaudeBin()} -p --model ${model} --output-format json${webSearch ? ' --allowedTools "WebSearch"' : ''}`;
    const child = spawn(cmd, { shell: true, cwd: require('os').homedir() });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_) {
        /* 무시 */
      }
      finish({ stdout, stderr, code: null, timedOut: true });
    }, timeoutSec * 1000);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => finish({ stdout, stderr: `${stderr}\n${e.message}`, code: null }));
    child.on('close', (code) => finish({ stdout, stderr, code }));
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function askClaude(prompt, p, spawnFn = spawnClaude) {
  const res = await spawnFn(prompt, p);
  const cli = AG.parseClaudeCliOutput(res.stdout);
  const parsed = AG.extractJson(cli.innerText);
  if (parsed && typeof parsed === 'object') return { ok: true, decision: parsed, costUsd: cli.costUsd };
  const limit = AG.isSessionLimitResponse(res, cli);
  const base = limit ? '사용량 한도' : res.timedOut ? `시간 초과(${p.timeoutSec}초)` : `응답을 읽지 못함(종료코드 ${res.code})`;
  // 원인을 남긴다 — 처음 켰을 때 실패했는데 이유가 기록에 없었다(2026-10-15)
  let hint = '';
  try {
    hint = AG.diagnose(res);
  } catch (_) {
    /* 진단 실패 */
  }
  const snippet = String(cli.innerText || res.stderr || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  return { ok: false, error: `${base}${hint ? ` — ${hint}` : ''}`, detail: snippet, limit };
}

// --- 상태 파일 ----------------------------------------------------------------------------
let _statePath = STATE_PATH;
function _setStatePathForTest(x) {
  _statePath = x || STATE_PATH;
}
const _writesBlocked = () => !!process.env.NODE_TEST_CONTEXT && _statePath === STATE_PATH;
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(_statePath, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch (_) {
    return {};
  }
}
function saveState(state) {
  if (_writesBlocked()) return;
  fs.mkdirSync(path.dirname(_statePath), { recursive: true });
  const tmp = `${_statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, _statePath);
}

async function fetchPublicJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ko = (side) => (side === 'LONG' ? '롱' : '숏');

function weeklyText(st, p) {
  const pct = (v) => (v == null ? '데이터 없음' : `${v > 0 ? '+' : ''}${v}%`);
  const last = st.snapshots[st.snapshots.length - 1];
  const claude = r2((last.equity / p.capital - 1) * 100);
  return [
    `📊 <b>주간 성적표</b> (Claude 시작 ${esc(kstParts(new Date(st.startT)).dateKey)} 부터)`,
    `Claude 분석: ${pct(claude)} · 거래 ${st.closed.length}번 · 열린 포지션 ${st.positions.length}개`,
    `시스템(데모 추세추종): ${pct(returnSince(st.snapshots, st.startT, 'systemEquity'))}`,
    `나스닥(QQQ): ${pct(returnSince(st.snapshots, st.startT, 'qqq'))}`,
    '대표님 직접: 입금 전(기록 대기)',
    ...(st.lessons && st.lessons.length ? [`Claude 가 요즘 배운 것: ${st.lessons.slice(0, 2).map(esc).join(' / ')}`] : []),
  ].join('\n');
}

// 한 번 돈다(1분마다 불린다). 상태를 고쳐 돌려준다 — 저장은 호출부.
async function runTraderOnce({ cfg, now = Date.now(), state = {}, fetchJson = fetchPublicJson, spawnFn = spawnClaude, systemClient = null, notify = async () => {}, force = false } = {}) {
  const p = effectiveParams(cfg && cfg.claudeTrader);
  if (!p.enabled && !force) return { state, skipped: '꺼짐' };
  const st = state && state.startT ? { ...state } : { startT: now, cash: p.capital, positions: [], closed: [], decisions: [], rejections: 0, failures: 0, snapshots: [], runKeys: {}, lastMonitorAt: now, ended: null };
  if (st.ended) return { state: st, skipped: '끝남' };
  const { dateKey, hhmm } = kstParts(new Date(now));
  const runKey = p.runsKst.filter((x) => hhmm >= x).map((x) => `${dateKey} ${x}`).pop() || null;
  const decide = force || (runKey && !st.runKeys[runKey]);
  const monitor = now - (st.lastMonitorAt || 0) >= p.monitorEveryMin * MIN || !st.snapshots.length;
  if (!decide && !monitor) return { state: st };
  const events = [];

  // ① 현재가(마크)·펀딩 — 열린 포지션 종목(판단할 땐 핵심 + 오늘 상위 미국 주식)
  let info = null;
  let extras = [];
  if (decide) {
    try {
      info = await fetchJson(`${FAPI}/fapi/v1/exchangeInfo`);
      extras = pickExtraStocks(await fetchJson(`${FAPI}/fapi/v1/ticker/24hr`), info);
    } catch (_) {
      /* 추가 종목 없이 핵심 종목만으로 판단 */
    }
  }
  const syms = [...new Set([...(decide ? [...UNIVERSE, ...extras] : []), ...st.positions.map((x) => x.symbol)])];
  const marks = {};
  const prem = {};
  for (const s of syms) {
    try {
      const pi = await fetchJson(`${FAPI}/fapi/v1/premiumIndex?symbol=${s}`);
      if (Number(pi.markPrice) > 0) marks[s] = Number(pi.markPrice);
      prem[s] = pi;
    } catch (_) {
      /* 이 종목 시세는 다음에 */
    }
  }

  // ② 손절·익절·펀딩(지난 확인 뒤 1분봉) — 서버가 꺼져 있던 동안은 15분봉으로 본다
  if (monitor) {
    for (const pos of [...st.positions]) {
      const from = Math.max(st.lastMonitorAt || pos.openedAt, pos.openedAt);
      const interval = now - from > 900 * MIN ? '15m' : '1m';
      let candles = [];
      try {
        candles = parseKlines(await fetchJson(`${FAPI}/fapi/v1/klines?symbol=${pos.symbol}&interval=${interval}&startTime=${from}&endTime=${now}&limit=1000`));
      } catch (_) {
        continue; // 이번엔 확인 못 함 — 다음 확인에서 같은 구간을 다시 본다
      }
      const pi = prem[pos.symbol];
      if (pi && Number(pi.nextFundingTime) > 0) {
        if (pos.nextFundingTime && now >= pos.nextFundingTime) {
          const fee = pos.qty * (marks[pos.symbol] || pos.entry) * Number(pi.lastFundingRate || 0) * dirOf(pos.side);
          st.cash -= fee;
          pos.funding = (pos.funding || 0) - fee;
        }
        pos.nextFundingTime = Number(pi.nextFundingTime);
      }
      const hit = checkExit(pos, candles);
      if (hit) {
        const rec = closePos(st, pos, hit.price, hit.why, p, hit.t);
        events.push(`🤖 <b>Claude ${esc(rec.why)}</b> — ${esc(rec.symbol)} ${ko(rec.side)} ${rec.entry} → ${rec.exit} (${rec.pct > 0 ? '+' : ''}${rec.pct}%, ${rec.pnl > 0 ? '+' : ''}${rec.pnl} USDT)`);
      } else if (marks[pos.symbol]) pos.lastMark = marks[pos.symbol];
    }
    st.lastMonitorAt = now;
  }

  // ③ 하루 기록(첫 기록은 바로) — 비교용으로 시스템(데모) 순자산·QQQ 도 같이
  const last = st.snapshots[st.snapshots.length - 1];
  if (!last || (last.dateKey !== dateKey && hhmm >= '09:00')) {
    let systemEquity = null;
    if (systemClient) {
      try {
        systemEquity = EX.equityFromBalance(await systemClient.getAccountBalance());
      } catch (_) {
        /* 비교 칸 비움 */
      }
    }
    let qqq = marks.QQQUSDT || null;
    if (!qqq) {
      try {
        qqq = Number((await fetchJson(`${FAPI}/fapi/v1/premiumIndex?symbol=QQQUSDT`)).markPrice) || null;
      } catch (_) {
        /* 비교 칸 비움 */
      }
    }
    st.snapshots.push({ dateKey, t: now, equity: equityOf(st, marks), systemEquity, qqq });
    if (new Date(now + 9 * 3600000).getUTCDay() === 1 && last && st.lastWeeklyKey !== dateKey) {
      st.lastWeeklyKey = dateKey;
      let ownerStarted = false;
      try {
        ownerStarted = !!require('./owner-record').loadState().baseT;
      } catch (_) {
        /* 오너 기록 없음 */
      }
      if (!ownerStarted) events.push(weeklyText(st, p));
    }
  }

  // ④ 판단
  if (decide) {
    if (runKey) st.runKeys[runKey] = true;
    const feats = {};
    const funding = {};
    for (const s of [...UNIVERSE, ...extras]) {
      try {
        const daily = parseKlines(await fetchJson(`${FAPI}/fapi/v1/klines?symbol=${s}&interval=1d&limit=220`));
        const hourly = parseKlines(await fetchJson(`${FAPI}/fapi/v1/klines?symbol=${s}&interval=1h&limit=48`));
        let h4 = [];
        try {
          h4 = parseKlines(await fetchJson(`${FAPI}/fapi/v1/klines?symbol=${s}&interval=4h&limit=30`));
        } catch (_) {
          /* 4시간봉은 없어도 판단한다 */
        }
        const f = features(daily, hourly, marks[s], h4);
        if (f) feats[s] = f;
        if (prem[s]) funding[s] = Number(prem[s].lastFundingRate);
      } catch (_) {
        /* 이 종목은 이번 판단에서 뺀다 */
      }
    }
    const prompt = buildPrompt({ now, feats, funding, st, marks, p });
    const ans = await askClaude(prompt, p, spawnFn);
    if (!ans.ok) {
      st.failures += 1;
      st.decisions.push({ t: now, ok: false, error: ans.error, detail: ans.detail || null, model: p.model });
      events.push(`🤖 Claude 판단 건너뜀 — ${esc(ans.error)}(다음 판단 때 다시 · 열린 포지션의 손절·익절은 계속 처리)`);
    } else {
      const isAllowed = (sym) => UNIVERSE.includes(sym) || (/USDT$/.test(sym) && !/^(BTC|ETH)/.test(sym) && OR.isAllowedSymbol(sym, info, { strict: true }) === true);
      // 표에 없던 종목을 고르면 그 종목 현재가를 지금 받아 온다
      for (const a of Array.isArray(ans.decision.actions) ? ans.decision.actions : []) {
        const sym = String((a && a.symbol) || '').toUpperCase();
        if (sym && !marks[sym] && isAllowed(sym)) {
          try {
            const pi = await fetchJson(`${FAPI}/fapi/v1/premiumIndex?symbol=${sym}`);
            if (Number(pi.markPrice) > 0) marks[sym] = Number(pi.markPrice);
            prem[sym] = pi;
          } catch (_) {
            /* 현재가 없음 → 그 행동은 막힌다 */
          }
        }
      }
      const v = validateActions(ans.decision.actions, { st, marks, p, isAllowed });
      st.rejections += v.rejected.length;
      for (const a of v.accepted) {
        const price = marks[a.symbol];
        if (a.type === 'CLOSE') {
          const pos = st.positions.find((x) => x.symbol === a.symbol);
          if (pos) {
            const rec = closePos(st, pos, price || pos.lastMark || pos.entry, '판단 청산', p, now);
            events.push(`🤖 <b>Claude 청산</b> — ${esc(rec.symbol)} ${ko(rec.side)} ${rec.entry} → ${rec.exit} (${rec.pct > 0 ? '+' : ''}${rec.pct}%) · ${esc(a.reason)}`);
          }
        } else if (a.type === 'MOVE_STOP') {
          const pos = st.positions.find((x) => x.symbol === a.symbol);
          if (pos) pos.stop = a.stop;
        } else if (a.type === 'OPEN') {
          const pos = openPos(st, a, price, p, now);
          if (prem[a.symbol] && Number(prem[a.symbol].nextFundingTime) > 0) pos.nextFundingTime = Number(prem[a.symbol].nextFundingTime);
          events.push(`🤖 <b>Claude 진입</b> — ${esc(a.symbol)} ${ko(a.side)} ${a.sizePct}% @ ${price} · 손절 ${a.stop}${a.target ? ` · 목표 ${a.target}` : ''}\n이유: ${esc(a.reason)}`);
        }
      }
      const lastOkT = ([...st.decisions].reverse().find((x) => x.ok) || {}).t || 0;
      const lessons = Array.isArray(ans.decision.lessons) ? ans.decision.lessons.map((x) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, 12) : null;
      if (lessons && lessons.length) {
        if (JSON.stringify(lessons) !== JSON.stringify(st.lessons || [])) (st.lessonHistory = st.lessonHistory || []).push({ t: now, lessons });
        st.lessons = lessons;
      }
      for (const pm of Array.isArray(ans.decision.postmortems) ? ans.decision.postmortems : []) {
        const sym = String((pm && pm.symbol) || '').toUpperCase();
        const rec = [...st.closed].reverse().find((x) => x.symbol === sym && x.closedAt > lastOkT && !x.postmortem);
        if (rec) rec.postmortem = String(pm.lesson || '').slice(0, 300);
      }
      st.decisions.push({ t: now, ok: true, review: String(ans.decision.review || '').slice(0, 800), view: String(ans.decision.view || '').slice(0, 500), note: String(ans.decision.note || '').slice(0, 300), accepted: v.accepted.length, rejected: v.rejected.map((x) => x.why), costUsd: ans.costUsd ?? null });
      if (st.lessonHistory && st.lessonHistory.length > 200) st.lessonHistory = st.lessonHistory.slice(-200);
      if (st.decisions.length > 400) st.decisions = st.decisions.slice(-400);
    }
  }

  // ⑤ 손실 한도·기간 끝
  const equity = equityOf(st, marks);
  const total = r2((equity / p.capital - 1) * 100);
  const why = total <= -p.maxLossPct ? `최대 손실 한도 −${p.maxLossPct}% 도달` : now >= st.startT + p.days * DAY ? `기간 ${p.days}일 끝` : null;
  if (why) {
    for (const pos of [...st.positions]) closePos(st, pos, marks[pos.symbol] || pos.lastMark || pos.entry, '경기 끝', p, now);
    st.ended = { t: now, reason: why };
    events.push(`🏁 <b>Claude 분석 경기 끝</b> — ${esc(why)} · 누적 ${total}% · 거래 ${st.closed.length}번`);
  }
  for (const e of events) await notify(e);
  return { state: st, events };
}

class ClaudeTraderScheduler {
  constructor({ loadConfig, exchangeMod = EX, notifyMod, intervalMs = 60000, runFn = runTraderOnce } = {}) {
    Object.assign(this, { loadConfig, exchangeMod, notifyMod, intervalMs, runFn, _timer: null, _running: false });
  }
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick().catch((e) => console.error('[claude-trader]', e && e.message ? e.message : e)), this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }
  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
  async _tick(now = Date.now(), { force = false } = {}) {
    if (this._running || typeof this.loadConfig !== 'function') return null;
    const cfg = this.loadConfig();
    if (!force && !effectiveParams(cfg && cfg.claudeTrader).enabled) return null;
    this._running = true;
    try {
      let systemClient = null;
      if (process.env.BINANCE_API_KEY && /demo/.test(process.env.BINANCE_FUTURES_BASE_URL || '')) {
        systemClient = this.exchangeMod.createClient({ apiKey: process.env.BINANCE_API_KEY, apiSecret: process.env.BINANCE_API_SECRET, baseUrl: process.env.BINANCE_FUTURES_BASE_URL });
      }
      const notify = async (text) => {
        if (this.notifyMod && typeof this.notifyMod.sendMessage === 'function') await this.notifyMod.sendMessage(text, cfg);
      };
      const r = await this.runFn({ cfg, now, state: loadState(), systemClient, notify, force });
      saveState(r.state);
      return r;
    } finally {
      this._running = false;
    }
  }
}

module.exports = {
  UNIVERSE,
  DEFAULTS,
  STATE_PATH,
  effectiveParams,
  features,
  parseKlines,
  pickExtraStocks,
  equityOf,
  notionalPctOf,
  validateActions,
  openPos,
  closePos,
  checkExit,
  returnSince,
  tradeStats,
  weeklyText,
  buildPrompt,
  askClaude,
  loadState,
  saveState,
  _setStatePathForTest,
  runTraderOnce,
  ClaudeTraderScheduler,
};

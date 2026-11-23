'use strict';

// owner-dca.js — 대표님 TQQQ 적립 통(2026-11-21 대표님 결정 · docs/08 'TQQQ 적립 판' · 근거 docs/07 leveraged-dca).
// 매달 정한 날(기본 11일 — 월급 다음 날) 17:30 토스에서 TQQQ 를 정한 금액만큼 소수점 예약 → 장 시작에 체결.
// TQQQ 가 '사상 최고가'(since = 2010-02-11 상장일부터 · 분할 반영 가격)에서 ddPct 넘게 빠져 있으면 그달은 extra 를 더 — 더 넣는 돈은 하락장 예비 저축에서만, 없으면 기본만.
//   처음엔 '산 뒤 최고가'(since 2026-11-21)였다 — 1999 년부터 만든 가짜 TQQQ 가 2000 년 고점을 못 넘어 시험이 틀어지던 것을 피하려던 계산상 선택이었다.
//   대표님 '이전 고점 기준이어야 하지 않아?'(2026-11-23) — 맞다: 이미 빠진 시장에서 시작하면 산 뒤 최고가로는 바닥에서 더 사지 못한다. 진짜 TQQQ 는 2010 상장이라 그때부터의 최고가를 쓴다.
//   (시험 근거: 사상 최고가 기준인 QQQ −40% · −20% 도 넣은 돈 대비 6.1 · 6.0배로 꾸준히 5.7배 이상 — docs/07)
// 계단식(2026-11-21 대표님 '고점 대비 −40% 일 때 상황에 따라 더'): −deepPct(기본 60%) 아래인 달엔 여윳돈이 있으면 최대 deepMax(월급 한 달 치) 더 —
//   폭락 한가운데서 '얼마나 더'를 정하지 않도록 미리 숫자로. 계단식 자체는 따로 시험하지 않았다(깊을수록 더 넣은 돈의 효율이 좋았던 결과를 이어 붙임, docs/07).
// 팔지 않는다(10년) · 금액을 그때 기분으로 늘리지 않는다 · 빚 · 생활비 · 비상금 금지. 서버는 금액을 알려 줄 뿐 주문하지 않는다.
// 입력: TQQQ 마감 일봉(owner-signal 이 Yahoo 에서 받아 온다) → 신호 맨 위에 붙는 줄(HTML).

const DAY = 86400000;
const LISTED = '2010-02-11'; // TQQQ 상장일 — since 가 이날 이전이면 '사상 최고가'
const DEFAULTS = Object.freeze({ enabled: false, symbol: 'TQQQ', day: 11, base: 250000, extra: 150000, ddPct: 40, deepPct: 60, deepMax: 250000, since: LISTED });
const peakLabel = (p) => (p.since <= LISTED ? '사상 최고가' : `${p.since} 뒤 최고가`);

function effectiveDca(c) {
  const o = c && typeof c === 'object' ? c : {};
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : d);
  return {
    enabled: o.enabled === true,
    symbol: /^[A-Z]{1,6}$/.test(String(o.symbol || '')) ? String(o.symbol) : DEFAULTS.symbol,
    day: Math.round(num(o.day, 1, 28, DEFAULTS.day)),
    base: Math.round(num(o.base, 0, 10000000, DEFAULTS.base)),
    extra: Math.round(num(o.extra, 0, 10000000, DEFAULTS.extra)),
    ddPct: num(o.ddPct, 5, 95, DEFAULTS.ddPct),
    deepPct: num(o.deepPct, 5, 99, DEFAULTS.deepPct),
    deepMax: Math.round(num(o.deepMax, 0, 10000000, DEFAULTS.deepMax)),
    since: /^\d{4}-\d{2}-\d{2}$/.test(String(o.since || '')) && Number.isFinite(Date.parse(`${o.since}T00:00:00Z`)) ? String(o.since) : DEFAULTS.since,
  };
}

const kst = (t) => new Date(t + 9 * 3600000);
const man = (won) => `${(won / 10000).toLocaleString('en-US', { maximumFractionDigits: 1 })}만 원`;
const usd = (x) => `$${x >= 1 ? x.toFixed(2) : Number(x.toPrecision(4))}`;

// 산 뒤 최고가 · 마지막 종가 · 빠진 정도
function drawdownSince(bars, sinceT) {
  const xs = (bars || []).filter((b) => b && b.t >= sinceT && b.c > 0);
  if (!xs.length) return null;
  const hi = Math.max(...xs.map((b) => b.c));
  const last = xs[xs.length - 1];
  return { hi, last: last.c, lastT: last.t, dd: 1 - last.c / hi };
}

// 이번 달 금액(오늘이 사는 날이 아니어도 다음 사는 날 금액을 미리 보인다)
function plan(bars, p, now = Date.now()) {
  const since = Date.parse(`${p.since}T00:00:00Z`);
  const d = drawdownSince(bars, since);
  const deep = !!(d && d.dd * 100 >= p.ddPct);
  const deeper = !!(d && p.deepPct > p.ddPct && d.dd * 100 >= p.deepPct);
  const today = kst(now);
  const isDay = today.getUTCDate() === p.day;
  return { d, deep, deeper, isDay, amount: p.base + (deep ? p.extra : 0), upTo: p.base + (deep ? p.extra : 0) + (deeper ? p.deepMax : 0) };
}

function dcaLines(bars, p, now = Date.now()) {
  if (!p || !p.enabled) return [];
  const r = plan(bars, p, now);
  const where = r.d ? `${p.symbol} 종가 ${usd(r.d.last)} · ${peakLabel(p)} ${usd(r.d.hi)} 대비 −${(r.d.dd * 100).toFixed(1)}%` : `${p.symbol} 시세 없음(받지 못함 — 이번 달은 기본 금액)`;
  const more = r.deeper && p.deepMax > 0 ? ` + 여윳돈이 있으면 최대 ${man(p.deepMax)} 더(−${p.deepPct}% 아래 · 빚 · 생활비 · 비상금 금지)` : '';
  const amt = r.deep ? `<b>${man(r.amount)}</b>(−${p.ddPct}% 아래 — 예비 저축에서 ${man(p.extra)} 더 · 예비가 없으면 ${man(p.base)})${more}` : `<b>${man(p.base)}</b>`;
  if (r.isDay) return [`🗓️ <b>오늘 ${p.symbol} 적립</b> — 17:30 토스 ${p.symbol} ${amt} 소수점 예약(장 시작에 체결) · ${where} · 팔지 않는다`];
  const next = r.deeper && p.deepMax > 0 ? `${man(r.amount)} + 여윳돈 최대 ${man(p.deepMax)}(−${p.deepPct}% 아래)` : r.deep ? `${man(r.amount)}(−${p.ddPct}% 아래)` : man(p.base);
  return [`📈 ${p.symbol} 적립: 다음 ${p.day}일 ${next} · ${where}`];
}

module.exports = { DEFAULTS, LISTED, effectiveDca, drawdownSince, plan, dcaLines, peakLabel };

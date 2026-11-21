'use strict';

// owner-dca.js — 대표님 TQQQ 적립 통(2026-11-21 대표님 결정 · docs/08 'TQQQ 적립 판' · 근거 docs/07 leveraged-dca).
// 매달 정한 날(기본 11일 — 월급 다음 날) 17:30 토스에서 TQQQ 를 정한 금액만큼 소수점 예약 → 장 시작에 체결.
// TQQQ 가 '산 뒤(시작한 날 뒤) 최고가'에서 ddPct 넘게 빠져 있으면 그달은 extra 를 더 — 더 넣는 돈은 하락장 예비 저축에서만, 없으면 기본만.
// 팔지 않는다(10년) · 금액을 그때 기분으로 늘리지 않는다 · 빚 금지. 서버는 금액을 알려 줄 뿐 주문하지 않는다.
// 입력: TQQQ 마감 일봉(owner-signal 이 Yahoo 에서 받아 온다) → 신호 맨 위에 붙는 줄(HTML).

const DAY = 86400000;
const DEFAULTS = Object.freeze({ enabled: false, symbol: 'TQQQ', day: 11, base: 250000, extra: 150000, ddPct: 40, since: '2026-11-21' });

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
  const today = kst(now);
  const isDay = today.getUTCDate() === p.day;
  return { d, deep, isDay, amount: p.base + (deep ? p.extra : 0) };
}

function dcaLines(bars, p, now = Date.now()) {
  if (!p || !p.enabled) return [];
  const r = plan(bars, p, now);
  const where = r.d ? `${p.symbol} 종가 ${usd(r.d.last)} · 산 뒤 최고가 ${usd(r.d.hi)} 대비 −${(r.d.dd * 100).toFixed(1)}%` : `${p.symbol} 시세 없음(아직 산 뒤 기록이 없거나 받지 못함)`;
  const amt = r.deep ? `<b>${man(r.amount)}</b>(−${p.ddPct}% 아래 — 예비 저축에서 ${man(p.extra)} 더 · 예비가 없으면 ${man(p.base)})` : `<b>${man(p.base)}</b>`;
  if (r.isDay) return [`🗓️ <b>오늘 ${p.symbol} 적립</b> — 17:30 토스 ${p.symbol} ${amt} 소수점 예약(장 시작에 체결) · ${where} · 팔지 않는다`];
  return [`📈 ${p.symbol} 적립: 다음 ${p.day}일 ${r.deep ? `${man(r.amount)}(−${p.ddPct}% 아래)` : man(p.base)} · ${where}`];
}

module.exports = { DEFAULTS, effectiveDca, drawdownSince, plan, dcaLines };

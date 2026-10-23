'use strict';

// owner-signal.js — 대표님 직접 매매 규칙(docs/08-OWNER-RULES.md)의 매일 신호를 숫자로 보낸다(2026-10-23, 오너 "응 만들어줘").
// 차트를 눈으로 보면 '선 바로 위아래'가 애매하다 → 한국 09:05(바이낸스 일봉 마감 뒤) 마감된 일봉 종가와 그 봉의 SMA 50·200 을
// 숫자로 비교해 텔레그램으로 보낸다. 오너는 17:30 에 이 메시지대로 한다. /신호 로 언제든 다시 받을 수 있다.
// 주문은 하지 않는다 — 계산과 알림뿐(오너 계좌는 owner-record.js 가 읽기만 한다).
//   코인: fapi.binance.com 공개 일봉(진행 중인 봉 제외) · 주식(설정 stocks): Yahoo 일봉(배당 반영, 장이 끝난 봉만) — 주식은 롱만.

const fs = require('fs');
const path = require('path');

const STATE_PATH = path.join(__dirname, '..', 'reports', 'owner-signal-state.json');
const FAPI_PUBLIC = 'https://fapi.binance.com';
const DAY = 86400000;

// 규칙(오너 규칙 한 장과 같다 — 바꾸려면 docs/08 과 docs/07 근거부터)
const RULES = Object.freeze({
  fast: 50,
  slow: 200,
  slotPct: 20,
  long: Object.freeze({ stopPct: 10, tpPct: 30 }),
  short: Object.freeze({ stopPct: 4, tpPct: 8 }), // 코인만 · 하락 배열(50일선 < 200일선)일 때만
});

const DEFAULTS = Object.freeze({ enabled: false, runAtKst: '09:05', symbols: ['BTCUSDT', 'ETHUSDT'], stocks: [] });
const COINS = Object.freeze(['BTCUSDT', 'ETHUSDT']);

function effectiveParams(c) {
  const o = c && typeof c === 'object' ? c : {};
  const up = (a) => (Array.isArray(a) ? a.map((s) => String(s).toUpperCase().trim()).filter((s, i, x) => s && x.indexOf(s) === i) : null);
  return {
    enabled: o.enabled === true,
    runAtKst: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(o.runAtKst || '')) ? String(o.runAtKst) : DEFAULTS.runAtKst,
    symbols: (up(o.symbols) || [...DEFAULTS.symbols]).filter((s) => COINS.includes(s)),
    stocks: (up(o.stocks) || []).filter((s) => /^[A-Z][A-Z.\-^]{0,9}$/.test(s)).slice(0, 8),
  };
}

const sma = (closes, n, end = closes.length) => (end >= n ? closes.slice(end - n, end).reduce((a, b) => a + b, 0) / n : null);

// 마감된 종가 목록 → 오늘(마지막 봉)과 어제의 상태. 'long' | 'short' | 'flat' | null(평균을 낼 봉이 모자람)
function judge(closes, { allowShort = true } = {}) {
  const at = (end) => {
    const c = closes[end - 1];
    const f = sma(closes, RULES.fast, end);
    const s = sma(closes, RULES.slow, end);
    if (!(c > 0) || f == null || s == null) return { c: c ?? null, f, s, state: null };
    let state = 'flat';
    if (c > f && c > s) state = 'long';
    else if (allowShort && c < f && c < s && f < s) state = 'short';
    return { c, f, s, state };
  };
  const today = at(closes.length);
  const prev = closes.length > 1 ? at(closes.length - 1) : { state: null };
  return { ...today, prevState: prev.state };
}

// 선 바로 위아래를 가르려고 소수점을 남긴다(81,797.6 vs 81,797.0 이 같아 보이지 않게)
function fmt(x) {
  if (x == null || !Number.isFinite(x)) return '-';
  if (x >= 1000) return x.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return x >= 1 ? x.toFixed(2) : Number(x.toPrecision(4)).toString();
}
function pct(a, b) {
  if (!(a > 0 && b > 0)) return '-';
  const d = (a / b - 1) * 100;
  return `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(Math.abs(d) < 0.1 ? 3 : 2)}%`;
}
const ICON = { long: '🟢 롱', short: '🔴 숏', flat: '⚪ 쉼' };

// 종목 한 줄 묶음(HTML). j = judge 결과 + name·stock
function symbolLines(name, j, { stock = false } = {}) {
  if (!j || j.state == null) return [`<b>${name}</b> 데이터 없음 — 오늘은 차트로 직접 확인`];
  const head = `<b>${name}</b> 종가 ${fmt(j.c)} · 50일선 ${fmt(j.f)} (${pct(j.c, j.f)}) · 200일선 ${fmt(j.s)} (${pct(j.c, j.s)})`;
  const changed = j.prevState && j.prevState !== j.state ? ` (어제 ${ICON[j.prevState]} → 바뀜)` : '';
  const L = RULES.long;
  const S = RULES.short;
  let what;
  if (j.state === 'long') {
    what = `롱 들고 있으면 유지 · 없으면 17:30 롱(손절 −${L.stopPct}% · 익절 +${L.tpPct}%, 오늘 종가로 치면 ${fmt(j.c * (1 - L.stopPct / 100))} · ${fmt(j.c * (1 + L.tpPct / 100))})${stock ? '' : ' · 숏 들고 있으면 정리'}`;
  } else if (j.state === 'short') {
    what = `롱 들고 있으면 17:30 정리 · 숏 들고 있으면 유지 · 없으면 17:30 숏(손절 +${S.stopPct}% · 익절 −${S.tpPct}%, 오늘 종가로 치면 ${fmt(j.c * (1 + S.stopPct / 100))} · ${fmt(j.c * (1 - S.tpPct / 100))})`;
  } else {
    const why = j.c < j.f && j.c < j.s ? (stock ? '두 선 아래(주식은 숏 없음)' : '두 선 아래지만 하락 배열 아님') : j.c < j.f ? '50일선 아래' : '200일선 아래';
    what = `${why} — 롱·숏 들고 있으면 17:30 정리 · 새로 들어가지 않음`;
  }
  return [head, `→ ${ICON[j.state]}${changed}: ${what}`];
}

function buildMessage({ dateLabel, rows }) {
  const lines = [`📏 <b>대표님 규칙 신호</b> — ${dateLabel} 09:00 마감 일봉`];
  for (const r of rows) lines.push('', ...symbolLines(r.name, r.j, { stock: r.stock }));
  lines.push('', `한 칸 = 순자산 ${RULES.slotPct}% · 1배 · 손절·익절은 진입가 기준으로 5분 안에 · 지금 가격이 달라도 이 신호대로`);
  return lines.join('\n');
}

// --- 데이터 ------------------------------------------------------------------------

async function fetchJson(url, fetchImpl = fetch, headers = {}) {
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 바이낸스 kline → 마감된 봉만 {t, c}
function closedKlines(klines, now) {
  if (!Array.isArray(klines)) return [];
  return klines
    .map((k) => ({ t: Number(k[0]), c: Number(k[4]), ct: Number(k[6]) }))
    .filter((k) => Number.isFinite(k.t) && k.c > 0 && Number.isFinite(k.ct) && k.ct < now)
    .sort((a, b) => a.t - b.t);
}

// Yahoo 일봉 → 장이 끝난 봉만(봉 시각은 개장 시각 — 정규장 6.5시간 + 여유)
function closedYahoo(rows, now) {
  return (rows || []).filter((b) => b.t + 7 * 3600000 <= now);
}

async function collect(p, { now = Date.now(), fetchImpl = fetch } = {}) {
  const rows = [];
  for (const symbol of p.symbols) {
    try {
      const k = closedKlines(await fetchJson(`${FAPI_PUBLIC}/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=260`, fetchImpl), now);
      rows.push({ name: symbol.replace('USDT', ''), j: judge(k.map((x) => x.c), { allowShort: true }), lastT: k.length ? k[k.length - 1].t : null });
    } catch (e) {
      rows.push({ name: symbol.replace('USDT', ''), j: null, error: e.message });
    }
  }
  for (const sym of p.stocks) {
    try {
      const { parseYahooDaily } = require('./backtest/fetch-stocks');
      const from = Math.floor((now - 2 * 365 * DAY) / 1000);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${from}&period2=${Math.floor(now / 1000)}&interval=1d&events=div,splits`;
      const bars = closedYahoo(parseYahooDaily(await fetchJson(url, fetchImpl, { 'User-Agent': 'Mozilla/5.0 (compatible; trading-floor)', Accept: 'application/json' })), now);
      rows.push({ name: sym, stock: true, j: judge(bars.map((b) => b.c), { allowShort: false }) });
    } catch (e) {
      rows.push({ name: sym, stock: true, j: null, error: e.message });
    }
  }
  return rows;
}

// --- 상태 파일 --------------------------------------------------------------------

let _statePath = STATE_PATH;
function _setStatePath(p) {
  _statePath = p || STATE_PATH;
}
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(_statePath, 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch (_) {
    return {};
  }
}
function saveState(s) {
  if (process.env.NODE_TEST_CONTEXT && _statePath === STATE_PATH) return;
  fs.mkdirSync(path.dirname(_statePath), { recursive: true });
  fs.writeFileSync(`${_statePath}.tmp`, JSON.stringify(s, null, 1));
  fs.renameSync(`${_statePath}.tmp`, _statePath);
}

function kstParts(now) {
  const d = new Date(now + 9 * 3600000);
  const p2 = (x) => String(x).padStart(2, '0');
  return { dateKey: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`, label: `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}`, hhmm: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` };
}

// 지금 신호 메시지 만들기(보내지는 않음) — /신호 와 ops 확인용
async function currentMessage(cfg, opts = {}) {
  const p = effectiveParams(cfg && cfg.ownerSignal);
  const now = opts.now || Date.now();
  const rows = await collect(p, { ...opts, now });
  // 날짜는 마지막으로 마감된 코인 일봉 기준(한국 09:00 전에 물으면 어제 09:00 봉이다)
  const lastT = Math.max(...rows.map((r) => (r.lastT != null ? r.lastT : -Infinity)));
  return { text: buildMessage({ dateLabel: kstParts(Number.isFinite(lastT) ? lastT + DAY : now).label, rows }), rows };
}

class OwnerSignalScheduler {
  constructor({ loadConfig, notifyMod, intervalMs = 60000, fetchImpl } = {}) {
    Object.assign(this, { loadConfig, notifyMod, intervalMs });
    this.fetchImpl = fetchImpl || fetch;
    this._timer = null;
    this._running = false;
    this._attempts = { dateKey: null, n: 0, lastAt: 0 };
  }
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick().catch((e) => console.error('[owner-signal]', e && e.message)), this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }
  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
  async _tick(now = Date.now()) {
    if (this._running || typeof this.loadConfig !== 'function') return null;
    const cfg = this.loadConfig() || {};
    const p = effectiveParams(cfg.ownerSignal);
    if (!p.enabled) return null;
    const { dateKey, hhmm } = kstParts(now);
    if (hhmm < p.runAtKst) return null;
    const st = loadState();
    if (st.lastSent === dateKey) return null;
    if (this._attempts.dateKey !== dateKey) this._attempts = { dateKey, n: 0, lastAt: 0 };
    if (this._attempts.n >= 6 || now - this._attempts.lastAt < 30 * 60000) return null;
    this._attempts.n += 1;
    this._attempts.lastAt = now;
    this._running = true;
    try {
      const { text, rows } = await currentMessage(cfg, { now, fetchImpl: this.fetchImpl });
      // 코인 일봉이 오늘 09:00 마감 봉까지 안 왔으면(거래소 지연) 30분 뒤 다시
      const expect = Math.floor(now / DAY) * DAY - DAY;
      if (rows.some((r) => !r.stock && r.lastT != null && r.lastT < expect) && this._attempts.n < 6) return { ok: false, retry: true };
      const r = this.notifyMod && typeof this.notifyMod.sendMessage === 'function' ? await this.notifyMod.sendMessage(text, cfg) : { ok: false, error: 'notify 없음' };
      if (r && r.ok) saveState({ ...st, lastSent: dateKey, states: Object.fromEntries(rows.map((x) => [x.name, x.j ? x.j.state : null])) });
      return { ok: !!(r && r.ok), text };
    } finally {
      this._running = false;
    }
  }
}

module.exports = { RULES, DEFAULTS, STATE_PATH, effectiveParams, judge, symbolLines, buildMessage, closedKlines, closedYahoo, collect, currentMessage, kstParts, loadState, saveState, _setStatePath, OwnerSignalScheduler };

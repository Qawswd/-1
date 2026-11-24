'use strict';

// leverage-guard.js — 레버리지 지킴이(2026-10-30, 대표님 계좌 청산 뒤 — docs/09-POSTMORTEM-OWNER-2026-10.md).
// 규칙의 첫 줄(1배)이 의지로만 지켜지다 두 번 무너졌다. 그래서 대표님 실계좌(읽기 전용 키)의 종목별 레버리지 '설정'을
// checkEveryMin 마다 보고, 지켜보는 종목 중 1배가 아닌 게 있으면 들어가기 전이라도 텔레그램으로 경고한다.
// 1배가 아닌 채로 포지션이 열려 있으면 '긴급'(30분마다 다시). 텔레그램 /레버리지 로 언제든 점검.
// GET 만 보낸다 — 주문도 레버리지 변경도 하지 않는다(바꾸는 건 대표님 손). 키에 읽기 말고 다른 권한이 있으면 쓰지 않는다(owner-record 와 같은 규칙).

const OR = require('./owner-record');

const DEFAULTS = Object.freeze({ enabled: false, checkEveryMin: 5, remindKst: '17:20', extraSymbols: [] });
const URGENT_EVERY_MS = 30 * 60000;

function effectiveParams(c) {
  const o = c && typeof c === 'object' ? c : {};
  const n = Number(o.checkEveryMin);
  return {
    enabled: o.enabled === true,
    checkEveryMin: Number.isFinite(n) ? Math.min(60, Math.max(1, n)) : DEFAULTS.checkEveryMin,
    remindKst: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(o.remindKst || '')) ? String(o.remindKst) : DEFAULTS.remindKst,
    extraSymbols: Array.isArray(o.extraSymbols) ? o.extraSymbols.map((s) => String(s).toUpperCase()).filter((s) => /^[A-Z0-9]{2,20}USDT$/.test(s)) : [],
  };
}

// 지켜볼 종목: 텔레그램 신호의 코인 + 주식(Yahoo 티커 → 바이낸스 무기한 이름, BRK-B → BRKBUSDT) + 따로 넣은 것
function watchedSymbols(cfg) {
  const os = require('./owner-signal').effectiveParams(cfg && cfg.ownerSignal);
  const p = effectiveParams(cfg && cfg.leverageGuard);
  return [...new Set([...os.symbols, ...os.stocks.map((s) => `${s.replace(/[^A-Z]/g, '')}USDT`), ...p.extraSymbols])];
}

// symbolConfig · v2 positionRisk 둘 다 [{ symbol, leverage, ... }] 모양 → Map(symbol → 배수)
function leverageMap(rows) {
  const m = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const lev = Number(r && r.leverage);
    if (r && r.symbol && Number.isFinite(lev) && lev > 0) m.set(String(r.symbol), lev);
  }
  return m;
}

// 읽은 것 → 판정. positions = v3 positionRisk(열린 것)
function evaluate({ levMap, positions, watched }) {
  const open = (Array.isArray(positions) ? positions : []).filter((x) => x && Math.abs(Number(x.positionAmt)) > 0);
  const openOver = open.map((x) => ({ symbol: x.symbol, leverage: levMap.get(x.symbol) ?? null, side: Number(x.positionAmt) > 0 ? '롱' : '숏' })).filter((x) => x.leverage != null && x.leverage > 1);
  const over = watched.filter((s) => (levMap.get(s) ?? 1) > 1).map((s) => ({ symbol: s, leverage: levMap.get(s) }));
  const unknown = watched.filter((s) => !levMap.has(s));
  return { over, openOver, unknown };
}

const fmtList = (xs) => xs.map((x) => `${x.symbol} <b>${x.leverage}배</b>`).join(' · ');

function statusLines({ levMap, watched, ev }) {
  const lines = ['🛡 <b>레버리지 점검</b>'];
  lines.push(watched.map((s) => (levMap.has(s) ? `${s} ${levMap.get(s)}x ${levMap.get(s) > 1 ? '⚠️' : '✓'}` : `${s} 없음(바이낸스에 그 종목이 없거나 못 읽음)`)).join('\n'));
  if (ev.openOver.length) lines.push(`🚨 1배가 아닌 채로 열린 포지션: ${fmtList(ev.openOver)} — 지금 정리하세요`);
  else if (ev.over.length) lines.push('⚠️ 들어가기 전에 위 종목을 1배로 바꾸세요(종목 화면 위 배수 → 1 → 확인)');
  else lines.push('모두 1배 ✓');
  return lines.join('\n');
}

async function readAll(client) {
  let rows = null;
  let source = 'symbolConfig';
  try {
    rows = await client.getSymbolConfig();
  } catch (_) {
    source = 'positionRisk v2';
    rows = await client.getPositionsV2();
  }
  return { levMap: leverageMap(rows), positions: await client.getPositions(), source };
}

function kstHhmm(now) {
  const d = new Date(now + 9 * 3600000);
  return { dateKey: d.toISOString().slice(0, 10), hhmm: d.toISOString().slice(11, 16) };
}

class LeverageGuard {
  constructor({ loadConfig, notifyMod, makeClient, now = () => Date.now(), intervalMs = 60000 } = {}) {
    Object.assign(this, { loadConfig, notifyMod, now, intervalMs });
    this.makeClient = makeClient || (() => OR.createReadOnlyClient({ apiKey: process.env.OWNER_BINANCE_API_KEY, apiSecret: process.env.OWNER_BINANCE_API_SECRET }));
    this._timer = null;
    this._running = false;
    this._lastCheck = 0;
    this._keyOk = null; // { dateKey, ok }
    this._warned = new Map(); // symbol → 경고한 배수(바뀌면 다시)
    this._urgentAt = new Map(); // symbol → 마지막 긴급 경고 시각
    this._remindedKey = null;
  }
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.tick().catch((e) => console.error('[leverage-guard]', e && e.message)), this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }
  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
  async send(text) {
    const cfg = this.loadConfig() || {};
    if (this.notifyMod && typeof this.notifyMod.sendMessage === 'function') return this.notifyMod.sendMessage(text, cfg);
    return null;
  }
  // 키가 '읽기만'인지 하루 한 번 — 아니면 아무것도 읽지 않는다
  async keyOk(client, dateKey) {
    if (this._keyOk && this._keyOk.dateKey === dateKey) return this._keyOk.ok;
    let kc;
    try {
      kc = OR.checkKeyRestrictions(await client.getApiRestrictions());
    } catch (e) {
      kc = { ok: false, problems: [e.message] };
    }
    this._keyOk = { dateKey, ok: kc.ok };
    if (!kc.ok) await this.send(`🔒 <b>레버리지 지킴이 — 키를 쓰지 않았습니다</b>\n${(kc.problems || []).join('\n')}\n바이낸스 API 관리에서 '읽기'만 켠 키로 바꿔 주세요.`);
    return kc.ok;
  }
  async tick() {
    if (this._running || typeof this.loadConfig !== 'function') return null;
    const cfg = this.loadConfig() || {};
    const p = effectiveParams(cfg.leverageGuard);
    if (!p.enabled) return null;
    const now = this.now();
    if (now - this._lastCheck < p.checkEveryMin * 60000) return null;
    this._running = true;
    try {
      const client = this.makeClient();
      const { dateKey, hhmm } = kstHhmm(now);
      if (!(await this.keyOk(client, dateKey))) return { skipped: '키 권한' };
      this._lastCheck = now;
      const watched = watchedSymbols(cfg);
      const { levMap, positions } = await readAll(client);
      const ev = evaluate({ levMap, positions, watched });
      const sent = [];
      // 🚨 1배가 아닌 채로 열린 포지션 — 30분마다 다시
      for (const x of ev.openOver) {
        if (now - (this._urgentAt.get(x.symbol) || 0) < URGENT_EVERY_MS) continue;
        this._urgentAt.set(x.symbol, now);
        const liq = Math.round(100 / x.leverage);
        await this.send(`🚨 <b>레버리지 긴급</b> — ${x.symbol} ${x.side}이 <b>${x.leverage}배</b>로 열려 있습니다.\n1배라면 −10% 손절이 지켜 주지만, ${x.leverage}배는 약 −${liq}% 안쪽에서 청산됩니다(손절보다 먼저).\n지금 정리하고, 1배로 바꾼 뒤 규칙대로 다시 들어가세요.`);
        sent.push(`urgent:${x.symbol}`);
      }
      for (const s of [...this._urgentAt.keys()]) if (!ev.openOver.some((x) => x.symbol === s)) this._urgentAt.delete(s);
      // ⚠️ 설정만 1배가 아닌 것 — 처음 보이거나 배수가 바뀌면 바로, 그리고 하루 한 번 remindKst(17:30 실행 전)에
      const fresh = ev.over.filter((x) => this._warned.get(x.symbol) !== x.leverage && !ev.openOver.some((o) => o.symbol === x.symbol));
      const remind = ev.over.length > 0 && hhmm >= p.remindKst && this._remindedKey !== dateKey;
      if (fresh.length || remind) {
        await this.send(`⚠️ <b>레버리지 경고</b> — ${fmtList(remind ? ev.over : fresh)} 로 설정돼 있습니다.\n들어가기 전에 1배로 바꾸세요(바이낸스 선물 → 종목 화면 위 배수 → 1 → 확인). 주문 전 세 가지: ① 1x ② 순자산 × 15% ③ 5분 안에 손절·익절.`);
        sent.push(remind ? 'remind' : 'fresh');
        if (remind) this._remindedKey = dateKey;
      }
      for (const x of ev.over) this._warned.set(x.symbol, x.leverage);
      for (const s of [...this._warned.keys()]) if (!ev.over.some((x) => x.symbol === s)) this._warned.delete(s);
      return { ev, sent };
    } finally {
      this._running = false;
    }
  }
}

// /레버리지 · ops 용 — 지금 상태 글
async function currentStatus(cfg, { client } = {}) {
  const c = client || OR.createReadOnlyClient({ apiKey: process.env.OWNER_BINANCE_API_KEY, apiSecret: process.env.OWNER_BINANCE_API_SECRET });
  const kc = OR.checkKeyRestrictions(await c.getApiRestrictions());
  if (!kc.ok) return { text: `🔒 키를 쓰지 않았습니다 — ${kc.problems.join(' · ')}`, ok: false };
  const watched = watchedSymbols(cfg);
  const { levMap, positions, source } = await readAll(c);
  const ev = evaluate({ levMap, positions, watched });
  return { text: statusLines({ levMap, watched, ev }), ok: true, source, ev };
}

module.exports = { DEFAULTS, effectiveParams, watchedSymbols, leverageMap, evaluate, statusLines, currentStatus, LeverageGuard };

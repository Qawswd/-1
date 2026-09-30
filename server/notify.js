'use strict';

// PIXEL TRADING FLOOR — 텔레그램 발송 (notify)
//
// 계약(docs/v2-contracts.md):
//   module.exports = { sendMessage, sendDecision, sendAlert, isEnabled }
//
// 원칙
//   - Node 내장 fetch로 https://api.telegram.org/bot<token>/sendMessage 만 호출한다.
//   - **절대 throw 하지 않는다.** 앱 흐름(분석·감시 루프)을 이 모듈이 막으면 안 된다.
//     실패는 console.error 한 줄 + { ok:false, error } 반환으로 끝낸다.
//   - 봇 토큰은 어떤 경로로도 로그에 남기지 않는다(redact 로 세탁한 뒤에만 출력).
//   - 모든 메시지는 HTML parse_mode · 한국어 · 끝에 항상 면책 문구.
//   - 데이터에 없는 값은 줄 자체를 빼고, 지어내지 않는다.

const API_BASE = 'https://api.telegram.org';
const API_TIMEOUT_MS = 10000;
const TAIL = '— AI 시뮬레이션, 투자 조언 아님';
const TG_MAX = 4096; // 텔레그램 메시지 길이 상한

// 테스트에서 갈아끼울 수 있게 간접 참조로 둔다(_setFetch).
let fetchImpl = (...args) => fetch(...args);

// --- config 로드 (config.js 가 아직 없어도 죽지 않는다) ------------------

// config.js 는 다른 모듈이 만드는 파일이라 없을 수 있다. 없으면 텔레그램은
// 그냥 '비활성'으로 취급한다(무설정 = 발송 안 함).
const CFG_FALLBACK = { telegram: { enabled: false, botToken: '', chatId: '' } };
let cfgMod; // undefined = 아직 시도 안 함, null = 없음
let cfgModTriedAt = 0;

function loadCfgSafe() {
  const now = Date.now();
  if (cfgMod === undefined || (cfgMod === null && now - cfgModTriedAt > 60000)) {
    cfgModTriedAt = now;
    try {
      // eslint-disable-next-line global-require
      const m = require('./config');
      cfgMod = m && typeof m.loadConfig === 'function' ? m : null;
    } catch (_) {
      cfgMod = null;
    }
  }
  if (cfgMod) {
    try {
      const c = cfgMod.loadConfig();
      if (c && typeof c === 'object') return c;
    } catch (_) {}
  }
  return CFG_FALLBACK;
}

// cfg 는 세 가지 형태를 모두 받는다:
//   1) 전체 설정 객체        { telegram:{...}, risk:{...} }
//   2) 텔레그램 설정만       { enabled, botToken, chatId }
//   3) 생략(undefined/null)  → config.js 에서 직접 읽는다
function normalizeCfg(cfg) {
  if (!cfg || typeof cfg !== 'object') return loadCfgSafe();
  if (cfg.telegram && typeof cfg.telegram === 'object') return cfg;
  if ('botToken' in cfg || 'chatId' in cfg) return { telegram: cfg };
  return cfg;
}

function pickTelegram(cfg) {
  const t = (cfg && cfg.telegram) || {};
  // 토큰은 환경변수(.env)를 최우선으로 쓴다 — BINANCE_API_KEY와 같은 원칙이다.
  // config.json은 HTTP POST로 고칠 수 있는 파일이라, 거기 실제 비밀값을 두면 유출
  // 경로가 된다. 환경변수가 없으면(과거 설정을 아직 안 옮긴 경우) config.json 값으로
  // 넘어간다 — 하루아침에 끊기지 않게 하는 임시 호환이다. chatId는 자격증명이 아니라
  // "어디로 보낼지"일 뿐이라 config.json에 그대로 둬도 된다.
  const envToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  return {
    enabled: !!t.enabled,
    botToken: envToken || String(t.botToken || '').trim(),
    chatId: String(t.chatId == null ? '' : t.chatId).trim(),
  };
}

function isEnabled(cfg) {
  const t = pickTelegram(normalizeCfg(cfg));
  return !!(t.enabled && t.botToken && t.chatId);
}

// --- 문자열 유틸 --------------------------------------------------------

// 토큰이 실수로 로그·반환값에 섞이는 걸 막는다.
function redact(text, token) {
  let s = String(text == null ? '' : text);
  if (token) s = s.split(token).join('***');
  // 형태가 남아 있으면(다른 토큰이라도) 통째로 가린다: 123456789:AAH...
  return s.replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '***');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 필드 단위 상한 — 메시지가 텔레그램 상한을 넘지 않게 앞단에서 자른다.
function cut(s, max) {
  const t = String(s == null ? '' : s).trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + '…';
}

function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  if (abs >= 1000) return Math.round(v).toLocaleString('en-US');
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 0.01) return v.toFixed(4);
  if (abs === 0) return '0';
  return v.toPrecision(4);
}

function pctStr(n, dp = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  return `${v >= 0 ? '+' : ''}${v.toFixed(dp)}%`;
}

function hhmmKst(ts) {
  const d = ts ? new Date(ts) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  // "서버가 KST PC에서 돈다"는 예전 가정은 지금(AWS UTC 서버)엔 틀리다 — 서버 로컬
  // 시각을 그대로 쓰면 알림 타임스탬프가 실제보다 9시간 뒤로 표시된다. Intl로 명시적
  // 타임존 변환을 해야 서버가 어디서 돌든(UTC든 KST든) 항상 정확하다.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const hh = String(Number(map.hour) % 24).padStart(2, '0');
  return `${hh}:${map.minute}`;
}

// 값이 있을 때만 줄을 만든다(없는 수치를 지어내지 않기 위한 게이트).
function has(v) {
  return v != null && v !== '' && v !== '-';
}

// --- 발송 ---------------------------------------------------------------

// text 는 **이미 HTML 이스케이프된** 문자열이어야 한다(태그를 쓰기 때문).
// 반환: { ok:true, messageId } | { ok:false, error }
async function sendMessage(text, cfg) {
  const c = normalizeCfg(cfg);
  const tg = pickTelegram(c);
  if (!tg.enabled) return { ok: false, error: '텔레그램 비활성(config.telegram.enabled=false)' };
  if (!tg.botToken || !tg.chatId) {
    return { ok: false, error: '봇 토큰 또는 chatId 가 비어 있음' };
  }

  let body = String(text == null ? '' : text);
  if (!body.trim()) return { ok: false, error: '빈 메시지' };
  if (body.length > TG_MAX) {
    // 필드 단위로 이미 잘라두므로 여기까지 오는 건 예외 상황이다.
    body = body.slice(0, TG_MAX - 120) + '\n…(생략)\n\n' + TAIL;
  }

  try {
    const res = await fetchImpl(`${API_BASE}/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: tg.chatId,
        text: body,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok || !data || data.ok !== true) {
      const why =
        (data && (data.description || data.error_code)) ||
        `HTTP ${res && res.status != null ? res.status : '?'}`;
      const msg = redact(String(why), tg.botToken);
      console.error('[notify] 텔레그램 발송 실패:', msg);
      return { ok: false, error: msg };
    }
    return { ok: true, messageId: data.result ? data.result.message_id : null };
  } catch (e) {
    const msg = redact(e && e.message ? e.message : String(e), tg.botToken);
    console.error('[notify] 텔레그램 발송 오류:', msg);
    return { ok: false, error: msg };
  }
}

// --- 판정 메시지 --------------------------------------------------------

const MODE_LABEL = {
  algo: '알고리즘',
  scalp: '스캘핑 20x',
  attack: '공격 20x',
};

const ACTION_ICON = {
  BUY: '🟢',
  SELL: '🔴',
  LONG: '🟢',
  SHORT: '🔴',
  HOLD: '⚪',
  PASS: '⚪',
};

// 리포트 링크. localhost 는 폰에서 열리지 않으므로 링크 대신 경로만 보여준다
// (열리지도 않는 링크를 다는 게 더 나쁘다).
function baseUrl(cfg) {
  const b =
    (cfg && (cfg.baseUrl || (cfg.telegram && cfg.telegram.baseUrl))) ||
    process.env.FLOOR_BASE_URL ||
    '';
  if (b) return String(b).replace(/\/+$/, '');
  const port = Number(process.env.PORT) || 8000;
  return `http://localhost:${port}`;
}

function reportLine(decision, cfg) {
  const p =
    decision.reportPath || decision.savedPath || decision.path || decision.report_url || null;
  if (!p) return null;
  const raw = String(p);
  if (/^https?:\/\//i.test(raw)) {
    return `📄 <a href="${escapeHtml(raw)}">리포트 열기</a>`;
  }
  const rel = raw.replace(/^\/+/, '');
  const base = baseUrl(cfg);
  const name = rel.split('/').pop();
  if (/localhost|127\.0\.0\.1/i.test(base)) {
    // 로컬 전용 주소 — 파일 경로만 알려준다.
    return `📄 리포트 <code>${escapeHtml(rel)}</code>`;
  }
  return `📄 <a href="${escapeHtml(base + '/' + rel)}">${escapeHtml(name)}</a>`;
}

// sizing 은 문자열(PM 코멘트)일 수도, riskmath.positionSize() 객체일 수도 있다.
function sizingText(sizing) {
  if (!sizing) return null;
  if (typeof sizing === 'string') return cut(sizing, 160);
  if (typeof sizing !== 'object') return null;
  const bits = [];
  if (Number.isFinite(Number(sizing.qty))) bits.push(`수량 ${fmtNum(sizing.qty)}`);
  if (Number.isFinite(Number(sizing.notional))) bits.push(`명목 ${fmtNum(sizing.notional)}`);
  if (Number.isFinite(Number(sizing.marginRequired))) {
    bits.push(`증거금 ${fmtNum(sizing.marginRequired)}`);
  }
  if (Number.isFinite(Number(sizing.riskAmount))) {
    bits.push(`허용손실 ${fmtNum(sizing.riskAmount)}`);
  }
  if (Number.isFinite(Number(sizing.notionalPctOfAccount))) {
    bits.push(`계좌의 ${Number(sizing.notionalPctOfAccount).toFixed(1)}%`);
  }
  return bits.length ? bits.join(' · ') : null;
}

// 청산가가 계산된 판정이면 청산 경고를 한 줄 붙인다 — 레버리지 값은 cfg.risk.leverage(기본 1배)를
// 그대로 읽어 동적으로 표기한다("1배 청산 경고"처럼). CLAUDE.md 규칙.
function leverageWarning(decision, cfg) {
  const mode = String(decision.mode || '').toLowerCase();
  const levered =
    mode === 'scalp' ||
    mode === 'attack' ||
    !!decision.scalp ||
    decision.liq != null ||
    decision.stopBeyondLiq === true;
  if (!levered) return null;

  const lev = Number(
    decision.leverage != null ? decision.leverage : cfg && cfg.risk ? cfg.risk.leverage : null
  );
  // 1배는 가격이 0 근처까지 가야 청산이라 경고가 의미 없다(손절이 훨씬 먼저 온다).
  // 손절보다 청산이 먼저 오는 설계만은 배수와 상관없이 경고한다.
  if (Number.isFinite(lev) && lev > 0 && lev <= 1 && decision.stopBeyondLiq !== true) return null;
  const levTxt = Number.isFinite(lev) && lev > 0 ? `${lev}배` : '고배율';
  const parts = [`⚠ <b>${escapeHtml(levTxt)} 청산 경고</b>`];
  if (has(decision.liq)) {
    parts.push(`청산가 ${escapeHtml(fmtNum(decision.liq))} 확인`);
  }
  if (decision.stopBeyondLiq === true) {
    parts.push('<b>손절보다 청산이 먼저 온다 — 이 설계는 치명적</b>');
  } else if (Number.isFinite(lev) && lev > 0) {
    parts.push(`약 ${(100 / lev).toFixed(1)}% 역행이면 청산 구간(유지증거금 별도)`);
  }
  parts.push('잔고 전액 진입 금지');
  return parts.join(' · ');
}

// 판정 메시지 — 폰에서 3초 안에 읽히게. 오너 요청(2026-09-26): "Buy/Sell · 익절구간 · 손절구간" 만 크게.
// 첫 줄 = 방향, 그 다음 진입/익절/손절 숫자와 %, 손익비. 근거·리포트는 아래에 짧게.
const ACTION_KO = { BUY: '매수 (BUY)', SELL: '매도 (SELL)', HOLD: '관망 (HOLD)', PASS: '관망 (PASS)', LONG: '매수 (LONG)', SHORT: '매도 (SHORT)' };

function priceNum(v) {
  if (v == null || v === '' || v === '-') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  try {
    const rm = require('./riskmath');
    const n = rm.parsePrice(String(v));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (_) {
    const m = String(v).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  }
}

function levelLine(label, raw, entry, side) {
  if (!has(raw)) return null;
  const n = priceNum(raw);
  let pctTxt = '';
  if (n != null && entry != null && entry > 0) {
    const dir = side === 'SHORT' ? -1 : 1;
    const pct = ((n - entry) / entry) * 100 * dir;
    pctTxt = ` (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
  }
  const shown = n != null ? fmtNum(n) : cut(raw, 40);
  return `${label} <b>${escapeHtml(shown)}</b>${escapeHtml(pctTxt)}`;
}

function buildDecisionHtml(decision, market, cfg) {
  const d = decision && typeof decision === 'object' ? decision : {};
  const m = market && typeof market === 'object' ? market : {};

  const display = String(d.symbol || d.display || m.display || m.symbol || '-');
  const nameKo = m.nameKo || d.nameKo || '';
  const title = nameKo ? `${nameKo} (${display})` : display;

  // 스캘핑 판정이 있으면 그쪽 방향·레벨을 우선한다(실제 체결 축)
  const scalp = d.scalp && typeof d.scalp === 'object' ? d.scalp : null;
  const scalpBias = scalp && scalp.bias ? String(scalp.bias).toUpperCase() : null;
  const useScalp = scalpBias === 'LONG' || scalpBias === 'SHORT';
  const action = useScalp ? scalpBias : String(d.action || '-').toUpperCase();
  const side = action === 'SELL' || action === 'SHORT' ? 'SHORT' : action === 'BUY' || action === 'LONG' ? 'LONG' : null;
  const icon = ACTION_ICON[action] || '⚪';
  const src = useScalp ? scalp : d;

  const L = [];
  L.push(`${icon} <b>${escapeHtml(title)} — ${escapeHtml(ACTION_KO[action] || action)}</b>`);
  const conf = Number(d.confidence);
  if (Number.isFinite(conf)) L.push(`확신도 ${conf}%` + (has(d.verdict) ? ` · PM ${escapeHtml(String(d.verdict))}` : ''));

  if (!side) {
    L.push('');
    L.push('지금은 들어가지 않습니다.');
  } else {
    const entry = priceNum(src.entry);
    L.push('');
    const e = levelLine('진입', src.entry, null, side);
    const t = levelLine('익절', src.target, entry, side);
    const st = levelLine('손절', src.stop, entry, side);
    if (e) L.push(e);
    if (t) L.push(t);
    if (st) L.push(st);
    const rr = Number(d.rr);
    if (Number.isFinite(rr) && rr > 0) L.push(`손익비 1 : ${rr.toFixed(1)}`);
    if (!e && !t && !st) L.push('레벨 없음 — 리포트 확인');
  }

  // 리스크 게이트가 강등했으면 그 이유 한 줄
  const reasons = Array.isArray(d.riskReasons) ? d.riskReasons : Array.isArray(d.reasons) ? d.reasons : [];
  if (d.riskOk === false && reasons.length) {
    L.push('');
    L.push(`⚠ ${escapeHtml(cut(reasons[0], 120))}`);
  }

  // 레버리지 경고(1배면 안 나온다)
  const warn = leverageWarning(d, cfg);
  if (warn) {
    L.push('');
    L.push(warn);
  }

  const rationale = d.rationale || d.bubble || '';
  if (rationale) {
    L.push('');
    L.push(`<i>${escapeHtml(cut(rationale, 220))}</i>`);
  }
  const rl = reportLine(d, cfg);
  if (rl) L.push(rl);
  L.push('');
  L.push(TAIL);
  return L.join('\n');
}

async function sendDecision(decision, market, cfg) {
  const c = normalizeCfg(cfg);
  if (!isEnabled(c)) return { ok: false, error: '텔레그램 비활성' };
  let html;
  try {
    html = buildDecisionHtml(decision, market, c);
  } catch (e) {
    // 메시지 조립에서 죽는 일이 없도록 최후 방어.
    console.error('[notify] 판정 메시지 조립 실패:', e && e.message ? e.message : e);
    return { ok: false, error: '메시지 조립 실패' };
  }
  return sendMessage(html, c);
}

// --- 급변동 알림 --------------------------------------------------------

const SEV_ICON = { info: 'ℹ️', warn: '⚠️', critical: '🚨' };
const KIND_LABEL = {
  move: '급변동',
  volume: '거래량 급증',
  funding: '펀딩비 이상',
  premium: '괴리 확대',
};

function buildAlertHtml(alert) {
  const a = alert && typeof alert === 'object' ? alert : {};
  const sev = String(a.severity || 'info').toLowerCase();
  const icon = SEV_ICON[sev] || 'ℹ️';
  const kind = KIND_LABEL[String(a.kind || '').toLowerCase()] || '감시 알림';
  const name = String(a.display || a.symbol || '-');

  const L = [];
  L.push(`${icon} <b>${escapeHtml(kind)}</b> · ${escapeHtml(name)}`);
  if (a.message) L.push(escapeHtml(cut(a.message, 200)));
  const priceTxt = a.priceText || (a.price != null ? fmtNum(a.price) : null);
  if (priceTxt) L.push(`현재가 ${escapeHtml(String(priceTxt))}`);
  const t = hhmmKst(a.ts);
  if (t) L.push(`${escapeHtml(t)} 기준`);
  L.push('');
  L.push(TAIL);
  return L.join('\n');
}

async function sendAlert(alert, cfg) {
  const c = normalizeCfg(cfg);
  if (!isEnabled(c)) return { ok: false, error: '텔레그램 비활성' };
  let html;
  try {
    html = buildAlertHtml(alert);
  } catch (e) {
    console.error('[notify] 알림 메시지 조립 실패:', e && e.message ? e.message : e);
    return { ok: false, error: '메시지 조립 실패' };
  }
  return sendMessage(html, c);
}

// 테스트 전용 — fetch 를 갈아끼운다. 인자 없이 부르면 원복.
function _setFetch(fn) {
  fetchImpl = typeof fn === 'function' ? fn : (...args) => fetch(...args);
}

// --- 실거래 실행 이벤트 메시지 --------------------------------------------
// engine.js가 emit하는 'execution' 이벤트와 같은 모양을 받는다. 진입 성공/실패,
// 하루 손실 한도 차단, 포지션 충돌 조정(유지/전환) 전부 이 한 함수에서 갈라 처리한다.
//
// 앞에 붙는 💰는 감시 알림(ℹ️⚠️🚨 — buildAlertHtml)과 겹치지 않는 고유 표시다.
// 감시 알림은 자주 오니까(사용자 의도대로 그대로 둔다), 진짜 돈이 움직이는 메시지만
// 텔레그램에서 "💰" 한 글자로 검색해 바로 걸러볼 수 있게 하려는 목적이다.
const MONEY_TAG = '💰';

// 거래소 주소가 데모·테스트넷이면 메시지에 "데모"라고 쓴다 — 가짜 돈을 "실거래"로 부르지 않는다.
function isDemoExchange() {
  return /demo|testnet/i.test(String(process.env.BINANCE_FUTURES_BASE_URL || ''));
}

function buildExecutionHtml(event) {
  return `${MONEY_TAG} ${buildExecutionBody(event)}`;
}

function buildExecutionBody(event) {
  const e = event || {};

  if (e.confidenceGate && e.confidenceGate.blocked) {
    const c = e.confidenceGate;
    return (
      `⏭️ <b>주문 안 함 — 확신도 부족</b>\n` +
      `확신도 ${c.confidence == null ? '없음' : c.confidence + '%'} (기준 ${c.min}% 이상)\n` +
      `판정은 성적표에 그대로 기록됩니다.`
    );
  }

  if (e.dailyLossLimit && e.dailyLossLimit.blocked) {
    const d = e.dailyLossLimit;
    return (
      `🛑 <b>하루 손실 한도 초과</b>\n` +
      `오늘은 신규 진입을 멈췄습니다(기존 포지션은 그대로 보호됩니다).\n` +
      `최근 24시간 실현손익: ${fmtNum(d.realizedPnl)} USDT (한도 -${fmtNum(d.maxLossUsd)} USDT)`
    );
  }

  if (e.portfolioExposure && e.portfolioExposure.blocked) {
    const p = e.portfolioExposure;
    return (
      `🛑 <b>전체 포트폴리오 노출 한도 초과</b>\n` +
      `다른 종목에 이미 열린 포지션이 많아 이 신규 진입은 넣지 않았습니다(기존 포지션은 그대로 보호됩니다).\n` +
      `기존 ${fmtNum(p.currentTotal)} + 신규 시도 = ${fmtNum(p.projectedTotal)} USDT (한도 ${fmtNum(p.maxAllowed)} USDT)`
    );
  }

  if (e.consecutiveLossPause && e.consecutiveLossPause.paused) {
    const c = e.consecutiveLossPause;
    return (
      `⏸️ <b>연속 손실 일시정지</b>\n` +
      `연속 ${c.consecutiveLosses}회 손실로 신규 진입을 멈췄습니다(기존 포지션은 그대로 보호됩니다).\n` +
      `쿨다운 ${c.cooldownHours}시간 — 이기는 거래가 나오거나 시간이 지나면 자동으로 풀립니다.`
    );
  }

  if (e.startupAudit) {
    const a = e.startupAudit;
    const lines = [`🛡️ <b>서버 재시작 점검</b>`, `무보호 포지션 ${a.unprotected.length}건 발견(전체 ${a.checked}건 중).`];
    if (a.fixed.length) {
      lines.push(`↩️ 원래 손절가로 복원: ${a.fixed.map((f) => `${f.symbol}@${fmtNum(f.stop)}`).join(', ')}`);
    }
    if (a.flattened.length) {
      lines.push(`🔴 원래 손절가를 몰라 안전하게 청산: ${a.flattened.join(', ')}`);
    }
    if (a.failed.length) {
      lines.push(`⚠️ 자동 조치 실패(직접 확인 필요): ${a.failed.map((f) => f.symbol).join(', ')}`);
    }
    return lines.join('\n');
  }

  if (e.reconcile) {
    const r = e.reconcile;
    const lines = [`🔍 <b>정합성 점검</b>`];
    if (r.staleClosedCount > 0) {
      lines.push(`거래소엔 없는데 로컬 장부엔 "열려있음"으로 남아있던 ${r.staleClosedCount}건을 자동으로 정리했습니다.`);
    }
    if (r.orphanCount > 0) {
      lines.push(
        `거래소엔 있는데 로컬 기록이 없는 포지션 ${r.orphanCount}건: ${r.orphanSymbols.join(', ')} — ` +
          `원래 목표·근거를 몰라 자동 복원은 안 했습니다(보호 여부는 재시작 점검이 별도로 확인합니다).`
      );
    }
    return lines.join('\n');
  }

  if (e.conflict) {
    const v = e.conflict.verdict || {};
    const ex = e.conflict.existing || {};
    if (String(v.action).toUpperCase() !== 'SWITCH') {
      return (
        `↔️ <b>기존 포지션 유지</b> (AI 판단)\n` +
        `${escapeHtml(ex.side || '')} ${has(ex.entry) ? fmtNum(ex.entry) : ''} 그대로 유지합니다.\n` +
        `${escapeHtml(cut(v.reasoning || '', 500))}`
      );
    }
    // SWITCH인데 이후 단계(청산 또는 재진입)가 실패한 경우 — 아래 일반 실패 처리로 이어진다.
  }

  // 포지션 청산 검토 결과(익절 또는 손절선 조정) — resolvePositionConflict와 별개로,
  // 가격이 움직일 때마다 열린 포지션을 다시 살펴본 AI 판단.
  if (e.review) {
    const rv = e.review;
    if (rv.type === 'exit') {
      const icon = rv.resultOk ? '💵' : '⚠️';
      return (
        `${icon} <b>포지션 청산</b> (AI 판단 — 익절/손절 검토)\n` +
        `${escapeHtml(rv.symbol || '')}${rv.resultOk ? '' : ' — 청산 시도 실패'}\n` +
        `${escapeHtml(cut(rv.reasoning || '', 500))}` +
        (rv.resultOk ? '' : `\n${escapeHtml(cut(rv.resultError || '', 300))}`)
      );
    }
    if (rv.type === 'tighten_stop') {
      const icon = rv.resultOk ? '🔒' : '⚠️';
      return (
        `${icon} <b>손절선 조정</b> (AI 판단 — 이익 보호)\n` +
        `${escapeHtml(rv.symbol || '')} 새 손절 ${has(rv.newStopPrice) ? fmtNum(rv.newStopPrice) : '?'}${
          rv.resultOk ? '' : ' — 적용 실패'
        }\n` +
        `${escapeHtml(cut(rv.reasoning || '', 500))}` +
        (rv.resultOk ? '' : `\n${escapeHtml(cut(rv.resultError || '', 300))}`)
      );
    }
  }

  if (e.ok === true) {
    const entry = e.entryOrder || {};
    const stop = e.stopOrder || {};
    const ex = e.executed || {};
    return (
      `✅ <b>${isDemoExchange() ? '데모 계좌 진입 완료' : '실거래 진입 완료'}</b>\n` +
      `${escapeHtml(entry.symbol || '')} ${escapeHtml(entry.side || '')}` +
      (has(ex.qty) ? ` · 수량 ${fmtNum(ex.qty)}` : '') +
      (has(ex.notional) ? ` · 명목가 ${fmtNum(ex.notional)} USDT` : '') +
      (ex.cappedByMax ? ' (포지션 상한 적용)' : '') +
      (has(stop.triggerPrice) ? `\n손절 트리거: ${fmtNum(stop.triggerPrice)}` : '') +
      `\n레버리지 1배 고정`
    );
  }

  if (e.stopFailed) {
    return e.flattened
      ? `⚠️ <b>손절 제출 실패 → 즉시 청산됨</b>\n보호 없는 포지션을 남기지 않았습니다.\n${escapeHtml(cut(e.error || '', 500))}`
      : `🚨 <b>긴급 — 손절도 청산도 실패</b>\n지금 즉시 거래소 앱에서 직접 확인하세요!\n${escapeHtml(cut(e.error || '', 500))}`;
  }

  return `❌ <b>${isDemoExchange() ? '데모 주문 실행 실패' : '실거래 실행 실패'}</b>\n${escapeHtml(cut(e.error || '알 수 없는 오류', 500))}`;
}

async function sendExecutionEvent(event, cfg) {
  return sendMessage(buildExecutionHtml(event), cfg);
}

// --- 일간 요약 메시지 --------------------------------------------------------
// daily-summary.js가 모아온 { realizedPnl, positions } 을 사람이 아침에 한눈에 볼
// 만한 형태로 정리한다.

// 지난 24시간 감시 활동 한 줄 — "왜 조용했나"를 요약에 같이 적는다(트리거 0회면 그게 이유다).
function buildActivityLine(activity) {
  if (!activity || typeof activity !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const parts = [];
  if (n(activity.moveTriggers) != null) parts.push(`급변동 트리거 ${n(activity.moveTriggers)}회`);
  if (n(activity.scheduledRuns) != null) {
    const d = n(activity.scheduledDirectional);
    const h = n(activity.scheduledHold);
    const split = d != null && h != null && d + h > 0 ? `(매매 ${d} · 관망 ${h})` : '';
    parts.push(`예약 분석 ${n(activity.scheduledRuns)}회${split}`);
  }
  if (n(activity.maxMove15mPct) != null) {
    const sym = activity.maxMoveSymbol ? `${escapeHtml(activity.maxMoveSymbol)} ` : '';
    parts.push(`${sym}15분 최대 변동 ${n(activity.maxMove15mPct) >= 0 ? '+' : ''}${n(activity.maxMove15mPct).toFixed(2)}%`);
  }
  if (!parts.length) return null;
  return `감시 활동(24h): ${parts.join(' · ')}`;
}

function buildDailySummaryHtml({ realizedPnl, positions, incomeBreakdown, activity } = {}) {
  const sgn = (v) => `${v >= 0 ? '+' : ''}${fmtNum(v)}`;
  let pnlLine;
  if (realizedPnl == null) {
    pnlLine = '최근 24시간 손익: 조회 실패';
  } else if (incomeBreakdown) {
    // 순손익(수수료·펀딩 반영)을 먼저, 내역을 아래에 — 실현손익만 보면 실제보다 좋아 보인다.
    pnlLine =
      `최근 24시간 순손익: ${sgn(realizedPnl)} USDT\n` +
      `  (실현손익 ${sgn(incomeBreakdown.realized)} · 수수료 ${sgn(incomeBreakdown.commission)} · 펀딩 ${sgn(incomeBreakdown.funding)})`;
  } else {
    pnlLine = `최근 24시간 실현손익: ${sgn(realizedPnl)} USDT`;
  }

  const list = Array.isArray(positions) ? positions : [];
  const posLines = list.length
    ? list
        .map((p) => {
          const sign = p.unrealizedPct != null && p.unrealizedPct >= 0 ? '+' : '';
          const pct = p.unrealizedPct != null ? `${sign}${p.unrealizedPct}%` : '—';
          const dir = p.side === 'LONG' ? '롱' : '숏';
          return `  ${escapeHtml(p.symbol || '')} ${dir} ${pct}`;
        })
        .join('\n')
    : '  (지금 열려있는 포지션 없음)';

  const act = buildActivityLine(activity);
  return (
    `${MONEY_TAG} 📅 <b>일간 요약</b>\n\n${pnlLine}\n\n현재 열린 포지션(${list.length}개):\n${posLines}` +
    (act ? `\n\n${act}` : '')
  );
}

async function sendDailySummary(data, cfg) {
  return sendMessage(buildDailySummaryHtml(data), cfg);
}

module.exports = {
  sendMessage,
  sendDecision,
  sendAlert,
  isEnabled,
  sendExecutionEvent,
  sendDailySummary,
  // 계약 외 부가 export — 통합·테스트 편의용(제거해도 계약은 유지된다)
  escapeHtml,
  buildDecisionHtml,
  buildAlertHtml,
  buildExecutionHtml,
  buildDailySummaryHtml,
  buildActivityLine,
  hhmmKst,
  _setFetch,
};

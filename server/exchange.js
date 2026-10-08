'use strict';

// exchange.js — 바이낸스 USD-M 선물(Futures) 주문 실행 모듈
//
// 설계 원칙
// - API 키·시크릿은 오직 환경변수로만 받는다. config.json에도, 코드에도 절대 박아두지
//   않는다(HTTP POST로 config.json을 고칠 수 있는 이 서버 구조상, 거기 키를 두면 유출 경로가 된다).
// - BASE URL(테스트넷/실계좌)도 환경변수로 명시해야만 동작한다 — 기본값을 두지 않는다.
//   "설정을 깜빡해서 실계좌로 나가는" 사고를 원천 차단하기 위해서다.
// - 레버리지는 이 모듈 안에서 1배로 하드코딩한다(HARD_LEVERAGE). 상위 코드가 실수로
//   다른 값을 넘겨도 무시한다.
// - 진입 주문이 체결되지 않으면 손절 주문을 걸지 않는다. 손절 주문 제출이 실패하면,
//   보호 없는 포지션을 그대로 두지 않고 즉시 시장가로 청산을 시도한다(안전 우선).
// - 2025년 12월부터 바이낸스의 조건부 주문(STOP_MARKET 등)은 기존 /fapi/v1/order가
//   아니라 별도의 /fapi/v1/algoOrder 엔드포인트를 쓴다. 진입 주문과 손절 주문의
//   엔드포인트가 다르다는 점이 이 모듈에서 가장 중요한 부분이다.
// - 외부 npm 의존성 0. Node 내장 crypto·fetch만 쓴다.

const crypto = require('crypto');

const HARD_LEVERAGE = 1; // "무조건 1배" — 이 모듈 안에서는 절대 못 바꾼다.
// 기대값 하한 — docs/00-CEO-PLAN.md 철칙(2026-09-30 개정). 확신도(= 익절이 손절보다 먼저 닿을 확률)와
// 손익비로 1회 기대값을 R 단위로 계산해, 건 돈의 0.2배 미만이면 주문하지 않는다.
// 설정(execution.minEvR)으로 올릴 수는 있어도 이 값 아래로 내릴 수는 없다.
const HARD_MIN_EV_R = 0.2;
const RECV_WINDOW_MS = 5000;

// --------------------------------------------------------------------------
// 순수 함수 — 네트워크 없이 전부 유닛테스트 가능
// --------------------------------------------------------------------------

// 기대값 게이트. EV(R) = p × 손익비 − (1 − p). 확신도·레벨 중 하나라도 못 읽으면 막는다 —
// 모르는 판정에 돈을 걸지 않는다. breakEvenConfidence 는 이 손익비에서 통과에 필요한 최소 확신도.
function checkEdge({ confidence, entry, stop, target } = {}, cfgMinEvR) {
  const m = Number(cfgMinEvR);
  const minEvR = Number.isFinite(m) && m > HARD_MIN_EV_R ? m : HARD_MIN_EV_R;
  const c = confidence == null || confidence === '' ? NaN : Number(confidence);
  const e = Number(entry);
  const sl = Number(stop);
  const tp = Number(target);
  const out = { blocked: true, confidence: Number.isFinite(c) ? c : null, rr: null, evR: null, minEvR, breakEvenConfidence: null, reason: null };
  if (!Number.isFinite(c) || c < 0 || c > 100) {
    out.reason = '확신도 없음';
    return out;
  }
  const risk = Math.abs(e - sl);
  const reward = Math.abs(tp - e);
  const sameSide = (tp - e) * (e - sl) > 0; // 롱: sl < e < tp, 숏: tp < e < sl
  if (![e, sl, tp].every(Number.isFinite) || !(risk > 0) || !(reward > 0) || !sameSide) {
    out.reason = '진입·손절·익절 레벨을 읽을 수 없음';
    return out;
  }
  const rr = reward / risk;
  const p = c / 100;
  const r2 = (x) => Math.round(x * 100) / 100;
  out.rr = r2(rr);
  out.evR = r2(p * rr - (1 - p));
  out.breakEvenConfidence = Math.ceil(((1 + minEvR) / (rr + 1)) * 100);
  out.blocked = p * rr - (1 - p) < minEvR;
  if (out.blocked) out.reason = '기대값 부족';
  return out;
}

// HMAC SHA256 서명 (hex). 바이낸스 서명 규칙 그대로.
function hmacSha256Hex(secret, message) {
  return crypto.createHmac('sha256', String(secret || '')).update(String(message || '')).digest('hex');
}

// 객체 → 'a=1&b=2' 쿼리스트링. null/undefined는 건너뛴다. 값은 그대로 문자열화한다
// (바이낸스는 숫자를 문자열로 보내도 받아들인다 — 부동소수점 표기 오차를 우리가 직접 통제하기 위해
// 항상 문자열로 넘긴다).
function toQueryString(params) {
  const parts = [];
  for (const key of Object.keys(params || {})) {
    const v = params[key];
    if (v === null || v === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

// 서명이 붙은 최종 쿼리스트링을 만든다. timestamp는 호출 시점 기준으로 매번 새로 찍는다
// (재시도 시 오래된 timestamp로 재전송하면 바이낸스가 거부하기 때문).
function signParams(params, secret, now = Date.now()) {
  const withMeta = { ...params, timestamp: now, recvWindow: RECV_WINDOW_MS };
  const qs = toQueryString(withMeta);
  const signature = hmacSha256Hex(secret, qs);
  return `${qs}&signature=${signature}`;
}

// step(예: 0.001)에 맞춰 내림 처리. 수량은 항상 내림 — 올림하면 계좌 잔고를 초과할 수 있다.
function floorToStep(value, step) {
  const v = Number(value);
  const s = Number(step);
  if (!Number.isFinite(v) || !Number.isFinite(s) || s <= 0) return null;
  const steps = Math.floor(v / s + 1e-9); // 부동소수점 오차 보정
  const out = steps * s;
  // step의 소수 자릿수만큼만 남긴다(0.1 * 3 = 0.30000000000000004 방지).
  // 1e-7 같은 지수 표기도 자릿수를 바르게 센다.
  const decimals = Math.max(0, Math.min(12, Math.ceil(-Math.log10(s) - 1e-9)));
  return Number(out.toFixed(decimals));
}

// exchangeInfo 응답에서 해당 종목의 수량·가격 단위를 찾는다. 못 찾으면 null(호출부가 처리).
function pickSymbolFilters(data, symbol) {
  const list = data && Array.isArray(data.symbols) ? data.symbols : [];
  const want = String(symbol || '').toUpperCase();
  const info = list.find((x) => x && String(x.symbol).toUpperCase() === want);
  if (!info) return null;
  const lot = (info.filters || []).find((f) => f.filterType === 'LOT_SIZE');
  const price = (info.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
  const fromPrecision = (p) => (Number.isInteger(Number(p)) && Number(p) >= 0 ? Number((10 ** -Number(p)).toFixed(Number(p))) : null);
  const qtyStep = lot && Number(lot.stepSize) > 0 ? Number(lot.stepSize) : fromPrecision(info.quantityPrecision);
  const priceStep = price && Number(price.tickSize) > 0 ? Number(price.tickSize) : fromPrecision(info.pricePrecision);
  return { symbol: info.symbol, qtyStep, priceStep };
}

// 우리 판정 어휘(BUY/SELL, LONG/SHORT)를 바이낸스 side로 통일한다.
// market.js 내부 표기(예: 'BTC', 'SKHYNIX')를 바이낸스 선물 API가 요구하는 완전한
// 심볼명('BTCUSDT')으로 변환한다. positions.js의 다른 소비자들(장부 표시, 시세 매칭 등)은
// 원래 표기를 그대로 써야 하므로 이 변환은 거래소 호출 직전, 여기서만 한다.
function toBinanceFuturesSymbol(symbol) {
  const s = String(symbol || '')
    .toUpperCase()
    .trim()
    .replace(/-/g, ''); // 'SKHYNIX-USDT' 같은 대시 표기도 안전하게 처리
  if (!s) return s;
  return s.endsWith('USDT') ? s : `${s}USDT`;
}

function toBinanceSide(action) {
  const a = String(action || '').toUpperCase();
  if (a === 'BUY' || a === 'LONG') return 'BUY';
  if (a === 'SELL' || a === 'SHORT') return 'SELL';
  return null;
}

// 포지션을 닫는 쪽(손절 주문)의 side는 진입의 반대다.
function oppositeSide(side) {
  if (side === 'BUY') return 'SELL';
  if (side === 'SELL') return 'BUY';
  return null;
}

// 진입 주문(시장가) 파라미터.
function buildEntryOrderParams({ symbol, side, quantity, clientOrderId }) {
  const params = {
    symbol,
    side,
    type: 'MARKET',
    quantity,
    newOrderRespType: 'RESULT', // 체결 결과를 바로 응답으로 받는다(폴링 불필요)
  };
  // 우리가 정한 주문 ID — 응답을 못 받았을 때(시간초과 등) 이 ID로 거래소에 "그 주문이
  // 실제로 들어갔는지" 조회할 수 있다. 없으면 결과를 모른 채 추측할 수밖에 없다(R11).
  if (clientOrderId) params.newClientOrderId = clientOrderId;
  return params;
}

// 바이낸스 newClientOrderId 규칙: 36자 이하, [.A-Z:/a-z0-9_-]. 시각+무작위로 충돌을 피한다.
function makeClientOrderId(prefix = 'ptf') {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`.slice(0, 36);
}

// 손절 주문(조건부, algoOrder 엔드포인트용) 파라미터.
// closePosition=true 이면 quantity/reduceOnly를 같이 보내면 안 된다(바이낸스가 거부함) —
// "지금 보유한 포지션 전체를 닫아라"는 뜻이라 수량을 따로 계산할 필요가 없어 오히려 더 안전하다.
function buildStopOrderParams({ symbol, side, triggerPrice, workingType = 'MARK_PRICE' }) {
  return {
    algoType: 'CONDITIONAL',
    symbol,
    side,
    type: 'STOP_MARKET',
    triggerPrice,
    closePosition: 'true',
    workingType,
  };
}

// 레버리지 고정(1배) 파라미터. leverage 인자를 받지 않는다 — 실수로라도 다른 값을 못 넘긴다.
function buildLeverageParams({ symbol }) {
  return { symbol, leverage: HARD_LEVERAGE };
}

// 포지션 전체를 시장가로 청산하는 파라미터(손절 주문 제출 자체가 실패했을 때 쓰는 최후 수단).
function buildFlattenParams({ symbol, side, quantity }) {
  return { symbol, side, type: 'MARKET', quantity, reduceOnly: 'true', newOrderRespType: 'RESULT' };
}

// /fapi/v1/income 요청 파라미터. incomeType 을 일부러 비워 실현손익·수수료·펀딩을 함께 받는다.
// (특정 종류만 필요하면 incomeType 을 명시해서 넘긴다.)
function buildIncomeParams({ startTime, endTime, limit, incomeType } = {}) {
  const p = { startTime, endTime, limit: limit || 1000 };
  if (incomeType) p.incomeType = incomeType;
  return p;
}

// getIncomeHistory 응답에서 REALIZED_PNL 레코드만 골라 합산한다. 우리가 따로 손익을
// 계산해서 거래소 기록과 어긋날 위험을 피하려고, 거래소가 실제로 기록한 숫자만 쓴다.
function sumRealizedPnl(records) {
  if (!Array.isArray(records)) return 0;
  let sum = 0;
  for (const r of records) {
    if (!r || r.incomeType !== 'REALIZED_PNL') continue;
    const v = Number(r.income);
    if (Number.isFinite(v)) sum += v;
  }
  return Math.round(sum * 100) / 100;
}

// maxLossUsd가 설정 안 됐으면(0 이하) 체크 자체를 하지 않는다 — 명시적으로 켠 사람만 막는다.
function isDailyLossLimitExceeded(realizedPnl, maxLossUsd) {
  if (!(Number(maxLossUsd) > 0)) return false;
  return Number(realizedPnl) <= -Math.abs(Number(maxLossUsd));
}

// 재시도해도 되는 오류인지 판단한다 — 일시적 문제(네트워크 끊김, 타임아웃, 거래소
// 5xx, 429 rate-limit)만 재시도 대상이다. "Invalid symbol"(400) 같은 건 다시 물어봐도
// 똑같이 실패하므로 즉시 그대로 던지는 게 맞다(재시도가 문제를 감추고 시간만 버린다).
function isRetryableError(err) {
  if (!err) return false;
  // fetch 자체가 실패(네트워크 끊김·DNS·타임아웃)하면 응답이 없어 status가 없다.
  if (err.status == null) return true;
  if (err.status >= 500) return true; // 거래소 쪽 일시적 문제
  if (err.status === 429) return true; // rate limit — 잠깐 쉬면 풀리는 경우가 많다
  return false;
}

// fn()을 실행하고, 재시도 가능한 오류면 지수 백오프(300ms→600ms→...)로 재시도한다.
// 읽기 전용(조회) 호출에만 써야 한다 — 주문 제출처럼 상태를 바꾸는 호출에 쓰면,
// "응답만 못 받았을 뿐 실제로는 체결된" 요청을 재시도해서 주문이 중복 나갈 위험이
// 있다(이 파일의 주문 관련 메서드들이 재시도를 안 쓰는 이유다).
async function withRetry(fn, { retries = 2, baseDelayMs = 300 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === retries || !isRetryableError(e)) throw e;
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// getPosition()의 응답(positionRisk 배열)에서 이미 열려있는 포지션이 있는지 본다.
// 원웨이 모드에서는 반대 방향 주문이 새 포지션을 만드는 게 아니라 기존 포지션과
// 합쳐지거나 뒤집혀버려서, 그 전에 걸어둔 손절이 엉뚱한 포지션을 보호하게 된다 —
// 그래서 방향 상관없이 "이미 뭐라도 열려있으면" 무조건 막는다(안전 우선).
function hasOpenPosition(positionRiskResponse) {
  if (!Array.isArray(positionRiskResponse)) return false;
  return positionRiskResponse.some((p) => {
    const amt = Number(p && p.positionAmt);
    return Number.isFinite(amt) && Math.abs(amt) > 0;
  });
}

// --------------------------------------------------------------------------
// 네트워크 경계 — 여기서부터는 실제 HTTP 호출. fetchImpl을 주입할 수 있게 해서
// 상위 오케스트레이션 로직(openPositionWithStop)은 가짜 클라이언트로 테스트 가능하다.
// --------------------------------------------------------------------------

function createClient({ apiKey, apiSecret, baseUrl, fetchImpl } = {}) {
  if (!apiKey || !apiSecret) {
    throw new Error(
      '[exchange] BINANCE_API_KEY / BINANCE_API_SECRET 환경변수가 없습니다. ' +
        '.env 또는 systemd 서비스 파일의 Environment= 로 설정하세요.'
    );
  }
  if (!baseUrl) {
    throw new Error(
      '[exchange] BINANCE_FUTURES_BASE_URL 환경변수가 없습니다. ' +
        '테스트넷: https://demo-fapi.binance.com (실계좌 URL은 검증 끝나기 전까지 쓰지 마세요).'
    );
  }
  const doFetch = fetchImpl || fetch;

  async function signedRequest(method, path, params = {}) {
    const now = Date.now();
    const body = signParams(params, apiSecret, now);
    const isGetOrDelete = method === 'GET' || method === 'DELETE';
    const url = isGetOrDelete ? `${baseUrl}${path}?${body}` : `${baseUrl}${path}`;
    const res = await doFetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': apiKey,
        ...(isGetOrDelete ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
      },
      body: isGetOrDelete ? undefined : body,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      /* 응답 본문이 없거나 JSON이 아님 */
    }
    if (!res.ok) {
      const msg = data && data.msg ? data.msg : `HTTP ${res.status}`;
      const code = data && typeof data.code !== 'undefined' ? data.code : null;
      const err = new Error(`[binance] ${path} 실패: ${msg}${code !== null ? ` (code ${code})` : ''}`);
      err.binanceCode = code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    // 계정/주문 제어(서명 필요) — 상태를 바꾸는 호출이라 일부러 재시도를 안 붙인다.
    // (응답만 못 받았을 뿐 실제로는 체결됐을 수 있어, 재시도하면 주문이 중복 나갈
    // 위험이 있다. 실패하면 그대로 위로 던져서 호출부가 명확한 오류로 처리하게 한다.)
    setLeverage: (symbol) => signedRequest('POST', '/fapi/v1/leverage', buildLeverageParams({ symbol })),
    placeMarketOrder: (symbol, side, quantity, clientOrderId) =>
      signedRequest('POST', '/fapi/v1/order', buildEntryOrderParams({ symbol, side, quantity, clientOrderId })),
    // 우리 주문 ID로 주문 상태 조회(읽기 전용이라 재시도 안전). 주문 결과가 불확실할 때 쓴다.
    getOrderByClientId: (symbol, clientOrderId) =>
      withRetry(() => signedRequest('GET', '/fapi/v1/order', { symbol, origClientOrderId: clientOrderId })),
    // 현재 마크 가격(공개 데이터, 서명 불필요) — 주문 직전 시세 확인(R10)에 쓴다.
    getMarkPrice: async (symbol) => {
      const res = await withRetry(() =>
        doFetch(`${baseUrl}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`)
      );
      const data = await res.json();
      const mark = Number(data && data.markPrice);
      return { markPrice: Number.isFinite(mark) && mark > 0 ? mark : null, time: Number(data && data.time) || null };
    },
    placeStopLoss: (symbol, side, triggerPrice) =>
      signedRequest('POST', '/fapi/v1/algoOrder', buildStopOrderParams({ symbol, side, triggerPrice })),
    flattenPosition: (symbol, side, quantity) =>
      signedRequest('POST', '/fapi/v1/order', buildFlattenParams({ symbol, side, quantity })),
    cancelAllAlgoOrders: (symbol) => signedRequest('DELETE', '/fapi/v1/algoOpenOrders', { symbol }),
    // 조회(읽기 전용)는 몇 번을 다시 물어봐도 안전하므로 재시도를 붙인다.
    getPosition: (symbol) => withRetry(() => signedRequest('GET', '/fapi/v3/positionRisk', { symbol })),
    // 심볼의 열려있는 알고(조건부) 주문 전부 조회 — 손절이 실제로 걸려있는지 확인하는
    // 용도(서버 재시작 시 점검 등). 취소(DELETE /fapi/v1/algoOpenOrders)와는 다른
    // 경로다 — 이름이 비슷해서 헷갈리기 쉬운데, 조회는 GET /fapi/v1/openAlgoOrders다.
    getOpenAlgoOrders: (symbol) => withRetry(() => signedRequest('GET', '/fapi/v1/openAlgoOrders', { symbol })),
    // 공개 데이터(서명 불필요) — 심볼별 수량/가격 정밀도(step) 조회
    getSymbolFilters: async (symbol) => {
      const res = await withRetry(() =>
        doFetch(`${baseUrl}/fapi/v1/exchangeInfo?symbol=${encodeURIComponent(symbol)}`)
      );
      const data = await res.json();
      // 선물 exchangeInfo 는 symbol 파라미터를 무시하고 전 종목을 돌려준다 — 반드시 이름으로 찾는다
      // (2026-10-02: symbols[0] 을 쓰다 ETH 주문이 다른 종목 자릿수로 나가 -1111 로 거부됨).
      return pickSymbolFilters(data, symbol);
    },
    // 손익 기록 조회(서명 필요, 계정 전체 — 심볼 무관). 하루 손실 한도·연속 손실·일간 요약에 쓴다.
    // 종류를 거르지 않는다 — 실현손익만 받으면 수수료·펀딩이 빠져 순손익이 실제보다 좋게 보인다(10/8 발견).
    getIncomeHistory: (opts = {}) =>
      withRetry(() => signedRequest('GET', '/fapi/v1/income', buildIncomeParams(opts))),
  };
}

// --------------------------------------------------------------------------
// 오케스트레이션 — 진입 + 손절을 하나의 흐름으로. client는 주입받는다(테스트 시 가짜로 교체).
// --------------------------------------------------------------------------

// decision: { action:'BUY'|'SELL'|...,  symbol, entry, stop } — 엔진의 최종 판정에서 뽑아 쓴다.
// quantity: riskmath.positionSize()로 이미 계산된 원시 수량(exchange step 반영 전).
// 반환: { ok, entryOrder, stopOrder, stopFailed, flattened, error }
async function openPositionWithStop({ symbol, action, quantity, stopPrice }, client) {
  const side = toBinanceSide(action);
  if (!side) return { ok: false, error: `알 수 없는 방향: ${action}` };
  if (!(Number(quantity) > 0)) return { ok: false, error: '수량이 0 이하입니다' };
  if (!(Number(stopPrice) > 0)) return { ok: false, error: '손절가가 유효하지 않습니다' };

  // 1) 레버리지 1배 강제 — 이게 실패하면 의도한 레버리지를 확신할 수 없으니 진입 자체를 하지 않는다.
  try {
    await client.setLeverage(symbol);
  } catch (e) {
    return { ok: false, error: `레버리지 설정 실패(1배 강제 확인 불가라 진입하지 않음): ${e.message}` };
  }

  // 2) 진입 전 현재 보유 수량 스냅샷 — 진입 결과가 불확실할 때 "주문 전후 수량 차이"로
  // 실제 체결량을 확인하기 위한 기준값이다. 조회 실패 시 null(대사 때 보수적으로 처리).
  let preAmt = null;
  if (typeof client.getPosition === 'function') {
    try {
      preAmt = signedPositionAmt(await client.getPosition(symbol), symbol);
    } catch (_) {
      preAmt = null;
    }
  }

  // 3) 진입(시장가) — 우리가 정한 주문 ID를 붙인다.
  const clientOrderId = makeClientOrderId();
  let entryOrder;
  let entryError = null;
  try {
    entryOrder = await client.placeMarketOrder(symbol, side, quantity, clientOrderId);
  } catch (e) {
    entryError = e;
  }
  let filledQty = Number(entryOrder && entryOrder.executedQty);

  // 응답이 없거나(시간초과·네트워크 오류) 체결 0으로 온 경우, "실패"로 단정하지 않는다 —
  // 거래소는 주문을 받았는데 응답만 못 받았을 수 있다(R11). 이 상태로 그냥 끝내면 손절 없는
  // 포지션이 다음 재시작 점검 때까지 방치된다. 거래소에 직접 물어서 실제 체결량을 확정한다.
  // 절대 같은 주문을 다시 보내지 않는다(중복 진입 방지).
  let reconciled = false;
  if (entryError || !(filledQty > 0)) {
    const r = await reconcileEntryFill({ client, symbol, side, clientOrderId, preAmt });
    if (r.state === 'FILLED') {
      filledQty = r.filledQty;
      reconciled = true;
    } else if (r.state === 'NOT_FILLED') {
      return {
        ok: false,
        error: entryError ? `진입 주문 실패(거래소 확인 결과 체결 없음): ${entryError.message}` : '진입 주문이 체결되지 않았습니다',
        entryOrder,
        clientOrderId,
      };
    } else {
      // 확인 불가 — 포지션이 있을 수도 없을 수도 있다. 재전송하지 않고 사람이 확인하도록 알린다.
      return {
        ok: false,
        unknown: true,
        error:
          `진입 결과를 확인할 수 없습니다(주문 ID ${clientOrderId}). 같은 주문은 다시 보내지 않았습니다 — ` +
          `거래소 앱에서 ${symbol} 포지션을 확인하세요. 서버 재시작 점검이 손절 없는 포지션을 자동 보호합니다.` +
          (entryError ? ` (원래 오류: ${entryError.message})` : ''),
        entryOrder,
        clientOrderId,
      };
    }
  }

  // 3) 손절(조건부, closePosition=true — 체결 수량과 무관하게 보유 포지션 전체를 보호)
  const stopSide = oppositeSide(side);
  try {
    const stopOrder = await client.placeStopLoss(symbol, stopSide, stopPrice);
    return { ok: true, entryOrder, stopOrder, clientOrderId, filledQty, reconciled };
  } catch (e) {
    // 손절 제출 자체가 실패 — 보호 없는 포지션을 남겨두지 않고 즉시 청산을 시도한다.
    try {
      const flattenOrder = await client.flattenPosition(symbol, stopSide, filledQty);
      return {
        ok: false,
        error: `손절 주문 실패라 포지션을 즉시 청산했습니다: ${e.message}`,
        entryOrder,
        stopFailed: true,
        flattened: true,
        flattenOrder,
      };
    } catch (e2) {
      // 청산 시도까지 실패 — 이건 사람이 당장 개입해야 하는 최악의 상황이다.
      return {
        ok: false,
        error:
          `손절 주문도, 긴급 청산도 모두 실패했습니다. 지금 즉시 거래소 앱에서 ` +
          `${symbol} 포지션을 직접 확인하세요. (손절 오류: ${e.message} / 청산 오류: ${e2.message})`,
        entryOrder,
        stopFailed: true,
        flattened: false,
      };
    }
  }
}

// positionRisk 응답에서 해당 심볼의 부호 있는 보유 수량(롱 +, 숏 -)을 뽑는다(단방향 모드).
function signedPositionAmt(raw, symbol) {
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  let amt = 0;
  for (const r of rows) {
    if (!r || (symbol && r.symbol && r.symbol !== symbol)) continue;
    const v = Number(r.positionAmt);
    if (Number.isFinite(v)) amt += v;
  }
  return amt;
}

// 진입 결과가 불확실할 때 실제 체결량을 확정한다(R11). 1순위: 우리 주문 ID로 주문 조회.
// 2순위: 주문 전후 보유 수량 차이. 둘 다 안 되면 UNKNOWN — 추측으로 진행하지 않는다.
// 반환 state: FILLED(filledQty>0) | NOT_FILLED | UNKNOWN
async function reconcileEntryFill({ client, symbol, side, clientOrderId, preAmt }) {
  if (client && typeof client.getOrderByClientId === 'function' && clientOrderId) {
    try {
      const o = await client.getOrderByClientId(symbol, clientOrderId);
      const q = Number(o && o.executedQty);
      if (Number.isFinite(q) && q > 0) return { state: 'FILLED', filledQty: q, via: 'order' };
      const st = String((o && o.status) || '').toUpperCase();
      if (['CANCELED', 'EXPIRED', 'REJECTED'].includes(st)) return { state: 'NOT_FILLED', via: 'order' };
      // NEW·PARTIALLY_FILLED 등 진행 중 — 수량 차이로 한 번 더 본다.
    } catch (e) {
      // 주문 자체가 거래소에 없음(-2013)이면 접수되지 않은 것 — 체결 없음으로 확정.
      if (e && e.binanceCode === -2013) return { state: 'NOT_FILLED', via: 'order' };
    }
  }
  if (client && typeof client.getPosition === 'function' && preAmt != null) {
    try {
      const postAmt = signedPositionAmt(await client.getPosition(symbol), symbol);
      const delta = side === 'BUY' ? postAmt - preAmt : preAmt - postAmt;
      if (delta > 0) return { state: 'FILLED', filledQty: Math.round(delta * 1e8) / 1e8, via: 'position' };
      return { state: 'NOT_FILLED', via: 'position' };
    } catch (_) {
      /* 조회 실패 — 아래 UNKNOWN */
    }
  }
  return { state: 'UNKNOWN' };
}

// 주문 직전 시세 확인(R10) — 분석에 1~3분 걸리는 동안 가격이 움직였을 수 있다. 순수 함수.
//  · 현재가를 모르면 차단: 오래되거나 없는 시세로 새 노출을 늘리지 않는다.
//  · 현재가가 이미 손절선을 넘었으면 차단: 손절 주문이 즉시 발동돼 거부되고, 진입 즉시
//    청산으로 수수료만 두 번 내게 된다.
//  · 계획 진입가에서 "손절까지 거리(1R)"의 maxDriftR배 이상 벗어났으면 차단: 수량은 계획
//    진입가 기준으로 계산됐기 때문에, 실제 체결가가 멀어지면 손실 한도와 손익비가 둘 다
//    계획과 달라진다. 거리를 R 단위로 재서 종목·가격대와 무관하게 같은 기준을 쓴다.
function checkEntryDrift({ side, planEntry, stop, markPrice, maxDriftR }) {
  const s = String(side || '').toUpperCase();
  const isLong = s === 'LONG' || s === 'BUY';
  const isShort = s === 'SHORT' || s === 'SELL';
  const e = Number(planEntry);
  const st = Number(stop);
  const m = Number(markPrice);
  const lim = Number.isFinite(Number(maxDriftR)) && Number(maxDriftR) > 0 ? Number(maxDriftR) : 0.5;
  if (!isLong && !isShort) return { ok: false, reason: `알 수 없는 방향(${side})` };
  if (!(m > 0)) return { ok: false, reason: '현재 시세를 확인하지 못해 신규 진입을 보류했습니다' };
  if (!(e > 0) || !(st > 0) || e === st) return { ok: false, reason: '계획 진입가·손절가가 유효하지 않습니다' };
  if (isLong ? m <= st : m >= st) {
    return { ok: false, reason: `현재가 ${m}가 이미 손절선 ${st}을 넘었습니다(계획 무효)`, driftR: null };
  }
  const oneR = Math.abs(e - st);
  const driftR = Math.round((Math.abs(m - e) / oneR) * 100) / 100;
  if (driftR > lim) {
    return {
      ok: false,
      reason: `현재가 ${m}가 계획 진입가 ${e}에서 ${driftR}R 벗어났습니다(허용 ${lim}R) — 수량·손익비가 계획과 달라져 진입하지 않습니다`,
      driftR,
    };
  }
  return { ok: true, reason: null, driftR };
}

// 실거래 허용 종목 잠금 — 운영 방침: BTC·ETH만 거래한다(2026-09-25). 워치리스트와 별개의
// 마지막 방어선이다. 대시보드에서 다른 종목을 수동 분석하거나 설정이 실수로 바뀌어도 주문이
// 나가지 않는다. 허용 목록이 없거나 잘못됐으면 기본(BTCUSDT·ETHUSDT)을 쓴다(열리지 않는 쪽).
const DEFAULT_ALLOWED_EXEC_SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
function isExecutionSymbolAllowed(exSymbol, allowed) {
  const list =
    Array.isArray(allowed) && allowed.length
      ? allowed.map((x) => String(x).trim().toUpperCase())
      : DEFAULT_ALLOWED_EXEC_SYMBOLS;
  return !!exSymbol && list.includes(String(exSymbol).trim().toUpperCase());
}

// 소득 기록을 종류별로 합산한다(R09 비용 반영). 바이낸스 선물은 실현손익(REALIZED_PNL)과
// 별도로 수수료(COMMISSION, 음수)·펀딩(FUNDING_FEE, ±)이 따로 기록된다. 실현손익만 보면
// 실제 손실보다 작게 보인다 — 손실 한도·일간 요약은 순손익(net)을 써야 한다.
function summarizeIncome(records) {
  const out = { realized: 0, commission: 0, funding: 0, net: 0 };
  if (!Array.isArray(records)) return out;
  for (const r of records) {
    const v = Number(r && r.income);
    if (!Number.isFinite(v)) continue;
    if (r.incomeType === 'REALIZED_PNL') out.realized += v;
    else if (r.incomeType === 'COMMISSION') out.commission += v;
    else if (r.incomeType === 'FUNDING_FEE') out.funding += v;
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  out.realized = r2(out.realized);
  out.commission = r2(out.commission);
  out.funding = r2(out.funding);
  out.net = r2(out.realized + out.commission + out.funding);
  return out;
}

// positionRisk 응답의 행 하나를 보기 좋은 요약으로 바꾼다(내부 공용 — summarizeOpenPosition과
// summarizeAllOpenPositions이 같은 계산을 공유한다).
function summarizePositionRow(row) {
  const amt = Number(row.positionAmt);
  const entry = Number(row.entryPrice);
  const mark = Number(row.markPrice);
  const side = amt > 0 ? 'LONG' : 'SHORT';
  const unrealizedPct =
    Number.isFinite(entry) && entry > 0 && Number.isFinite(mark)
      ? Math.round(((mark - entry) / entry) * (side === 'LONG' ? 100 : -100) * 100) / 100
      : null;
  return {
    symbol: row.symbol,
    side,
    quantity: Math.abs(amt),
    entry,
    markPrice: mark,
    unrealizedPct,
    unrealizedUsd: Number(row.unRealizedProfit),
  };
}

// getPosition() 원본 응답에서 "지금 실제로 열려있는 포지션"이 있으면 보기 좋은 요약으로
// 뽑아준다(없으면 null, 첫 건만). AI 충돌 조정 프롬프트와 로그에 그대로 쓴다.
function summarizeOpenPosition(positionRiskResponse) {
  if (!Array.isArray(positionRiskResponse)) return null;
  const row = positionRiskResponse.find((p) => {
    const amt = Number(p && p.positionAmt);
    return Number.isFinite(amt) && Math.abs(amt) > 0;
  });
  return row ? summarizePositionRow(row) : null;
}

// getPosition()을 심볼 없이(계정 전체) 호출한 응답에서, 열려있는 포지션 전부를 요약해
// 배열로 돌려준다 — "실거래 현황판"에 쓴다. 하나도 없으면 빈 배열([]), null이 아니다.
function summarizeAllOpenPositions(positionRiskResponse) {
  if (!Array.isArray(positionRiskResponse)) return [];
  return positionRiskResponse
    .filter((p) => {
      const amt = Number(p && p.positionAmt);
      return Number.isFinite(amt) && Math.abs(amt) > 0;
    })
    .map(summarizePositionRow);
}

// 여러 포지션의 현재 명목가(수량×현재가) 합계 — 계좌 전체 노출도를 계산하는 데 쓴다.
function totalNotionalOf(positions) {
  if (!Array.isArray(positions)) return 0;
  return positions.reduce((sum, p) => {
    const q = Number(p && p.quantity);
    const mp = Number(p && p.markPrice);
    if (Number.isFinite(q) && Number.isFinite(mp)) return sum + q * mp;
    return sum;
  }, 0);
}

// 종목별 상한(execution.maxPositionPct)은 "이 한 종목에 얼마나"만 본다. 여러 종목이
// 동시에 열리면(워치리스트 10개 중 몇 개가 한꺼번에 트리거되는 경우) 종목별로는 다
// 안전해도 계좌 전체로는 과도하게 몰릴 수 있다 — 이 함수는 "새 포지션을 더하면 계좌
// 전체 노출도가 한도를 넘는가"를 본다. maxPortfolioExposurePct·accountSizeUsd 둘 다
// 설정 안 됐으면(0 이하) 체크 자체를 하지 않는다(다른 한도 체크들과 같은 원칙).
function checkPortfolioExposure({ accountSizeUsd, maxPortfolioExposurePct, currentPositions, newNotional }) {
  const acct = Number(accountSizeUsd);
  const maxPct = Number(maxPortfolioExposurePct);
  if (!(acct > 0) || !(maxPct > 0)) {
    return { blocked: false, checked: false };
  }
  const currentTotal = totalNotionalOf(currentPositions);
  const projectedTotal = currentTotal + (Number(newNotional) || 0);
  const maxAllowed = (acct * maxPct) / 100;
  return {
    blocked: projectedTotal > maxAllowed,
    checked: true,
    currentTotal: Math.round(currentTotal * 100) / 100,
    projectedTotal: Math.round(projectedTotal * 100) / 100,
    maxAllowed: Math.round(maxAllowed * 100) / 100,
  };
}

// 기존 포지션 정리 — 그 포지션을 보호하던 손절(algo) 주문부터 전부 취소한 다음, 남은
// 수량 그대로 시장가로 청산한다. 손절을 먼저 안 지우면 "같은 방향 손절이 이미 있다"고
// 거부당한다(실제로 이 순서 문제 때문에 실전에서 한 번 막혔었다).
async function closeExistingPosition({ symbol, side, quantity }, client) {
  try {
    await client.cancelAllAlgoOrders(symbol);
  } catch (e) {
    return { ok: false, error: `기존 손절 주문 취소 실패: ${e.message}` };
  }
  // side는 'LONG'/'SHORT'(summarizeOpenPosition 형식)로 들어올 수도, 'BUY'/'SELL'로
  // 들어올 수도 있다 — toBinanceSide로 먼저 정규화한 다음 반대 방향을 구한다.
  const normalizedSide = toBinanceSide(side);
  const closeSide = oppositeSide(normalizedSide);
  if (!closeSide) {
    return { ok: false, error: `알 수 없는 방향이라 청산하지 못했습니다: ${side}` };
  }
  try {
    const flattenOrder = await client.flattenPosition(symbol, closeSide, quantity);
    return { ok: true, flattenOrder };
  } catch (e) {
    return {
      ok: false,
      error:
        `손절은 취소했지만 청산 주문이 실패했습니다 — 포지션이 손절 없이 남아있을 수 ` +
        `있습니다. 지금 즉시 거래소 앱에서 ${symbol}을 직접 확인하세요. (${e.message})`,
    };
  }
}

// 거래소에 실제로 걸린 손절가(STOP 계열 algo 주문의 triggerPrice). 없으면 null.
// 손절의 기준은 장부가 아니라 거래소다 — 장부가 어긋나 손절을 느슨하게 되돌린 사고가 있었다(2026-10-09).
function findExchangeStop(algoOrders, positionSide) {
  const list = Array.isArray(algoOrders) ? algoOrders : algoOrders && Array.isArray(algoOrders.orders) ? algoOrders.orders : [];
  const ps = String(positionSide || '').toUpperCase();
  const wantSide = ps === 'LONG' || ps === 'BUY' ? 'SELL' : ps === 'SHORT' || ps === 'SELL' ? 'BUY' : null;
  const prices = list
    .filter((o) => {
      if (!o) return false;
      const kind = String(o.orderType || o.type || '').toUpperCase();
      if (!kind.includes('STOP')) return false;
      const st = String(o.algoStatus || '').toUpperCase();
      if (st && !['NEW', 'PARTIALLY_FILLED'].includes(st)) return false;
      if (wantSide && o.side && String(o.side).toUpperCase() !== wantSide) return false;
      return true;
    })
    .map((o) => Number(o.triggerPrice != null ? o.triggerPrice : o.stopPrice))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (!prices.length) return null;
  // 여러 개면 가장 유리한(포지션에 가장 가까운) 것 — 롱은 가장 높은, 숏은 가장 낮은 손절.
  return wantSide === 'SELL' ? Math.max(...prices) : Math.min(...prices);
}

// 손절가를 거래소 가격 단위로 맞춘다. 느슨해지지 않게: 롱 손절은 올림, 숏 손절은 내림.
function roundStopToTick(positionSide, price, tick) {
  const p = Number(price);
  const t = Number(tick);
  if (!Number.isFinite(p) || !(t > 0)) return p;
  const decimals = Math.max(0, Math.min(12, Math.ceil(-Math.log10(t) - 1e-9)));
  const ps = String(positionSide || '').toUpperCase();
  const steps = p / t;
  const n = ps === 'LONG' || ps === 'BUY' ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9);
  return Number((n * t).toFixed(decimals));
}

// 새 손절이 기존보다 느슨한가(롱은 더 낮음, 숏은 더 높음).
function isLooserStop(positionSide, newStop, oldStop) {
  const n = Number(newStop);
  const o = Number(oldStop);
  if (!Number.isFinite(n) || !Number.isFinite(o)) return false;
  const ps = String(positionSide || '').toUpperCase();
  if (ps === 'LONG' || ps === 'BUY') return n < o;
  if (ps === 'SHORT' || ps === 'SELL') return n > o;
  return false;
}

// 손절이 이미 현재가를 넘어 "즉시 체결될" 자리인지. 롱 손절은 현재가보다 아래, 숏 손절은 위여야 한다.
// 거래소가 마크가 기준으로 거부(-2021)하기 전에 0.1% 여유를 두고 미리 걸러낸다.
const STOP_MARK_BUFFER = 0.001;
function stopWouldTriggerNow(side, stopPrice, markPrice) {
  const st = Number(stopPrice);
  const mk = Number(markPrice);
  if (!(st > 0) || !(mk > 0)) return false;
  const s = toBinanceSide(side);
  if (s === 'BUY') return st >= mk * (1 - STOP_MARK_BUFFER); // 롱 포지션
  if (s === 'SELL') return st <= mk * (1 + STOP_MARK_BUFFER); // 숏 포지션
  return false;
}

// 손절선 재조정 — 포지션 검토(TIGHTEN_STOP)·트레일링에서 쓴다.
// side는 'LONG'/'SHORT'든 'BUY'/'SELL'든 받는다.
//
// 철칙 "손절 필수"를 지키는 순서(2026-10-02 수정 — 실전에서 손절이 사라진 사고가 있었다):
//   1) 새 손절가가 현재가를 이미 넘었으면(-2021 "즉시 체결") 아무것도 취소하지 않고 기존 손절을 둔다.
//   2) 취소 후 새 손절 제출이 실패하면 기존 손절가(previousStopPrice)로 즉시 되돌린다.
//   3) 되돌리기도 실패하거나 기존 값을 모르면 수량(quantity)만큼 시장가로 청산한다 — 보호 없는 포지션을 남기지 않는다.
//   4) 그것마저 실패했을 때만 사람에게 긴급 확인을 요청한다.
async function updateStopLoss({ symbol, side, newStopPrice, previousStopPrice, quantity }, client) {
  if (!(Number(newStopPrice) > 0)) {
    return { ok: false, error: '새 손절가가 유효하지 않습니다' };
  }
  const normalizedSide = toBinanceSide(side);
  const stopSide = oppositeSide(normalizedSide);
  if (!stopSide) {
    return { ok: false, error: `알 수 없는 방향이라 손절을 다시 걸지 못했습니다: ${side}` };
  }
  // 0) 거래소 가격 단위로 맞춘다(안 맞추면 -1111 로 거부 — 2026-10-09 트레일링 연속 실패).
  let tick = null;
  if (typeof client.getSymbolFilters === 'function') {
    try {
      const f = await client.getSymbolFilters(symbol);
      tick = f && f.priceStep ? f.priceStep : null;
    } catch (_) {
      tick = null;
    }
  }
  if (tick) newStopPrice = roundStopToTick(normalizedSide, newStopPrice, tick);
  // 1) 거래소에 실제로 걸린 손절을 기준으로 삼는다. 느슨하게 옮기는 요청은 거절한다(철칙: 손절은 당기기만).
  let exchangeStop = null;
  if (typeof client.getOpenAlgoOrders === 'function') {
    try {
      exchangeStop = findExchangeStop(await client.getOpenAlgoOrders(symbol), normalizedSide);
    } catch (_) {
      exchangeStop = null;
    }
  }
  if (exchangeStop != null) {
    if (isLooserStop(normalizedSide, newStopPrice, exchangeStop) || Number(newStopPrice) === exchangeStop) {
      return {
        ok: false,
        kept: true,
        notTighter: true,
        exchangeStop,
        error: `새 손절 ${newStopPrice} 가 지금 걸린 손절 ${exchangeStop} 보다 유리하지 않아 바꾸지 않았습니다.`,
      };
    }
    previousStopPrice = exchangeStop; // 실패 시 복구할 값도 장부가 아니라 실제 걸려 있던 값
  }
  if (tick && Number(previousStopPrice) > 0) previousStopPrice = roundStopToTick(normalizedSide, previousStopPrice, tick);
  if (typeof client.getMarkPrice === 'function') {
    try {
      const m = await client.getMarkPrice(symbol);
      const mark = m && m.markPrice;
      if (stopWouldTriggerNow(normalizedSide, newStopPrice, mark)) {
        return {
          ok: false,
          kept: true,
          error:
            `새 손절가 ${newStopPrice} 가 이미 현재가(${mark})를 넘어 즉시 체결될 자리라 적용하지 않았습니다 — ` +
            `기존 손절은 그대로 걸려 있습니다.`,
        };
      }
    } catch (_) {
      // 시세 조회 실패 — 아래 2)~3) 복구 경로가 보호를 책임진다.
    }
  }
  try {
    await client.cancelAllAlgoOrders(symbol);
  } catch (e) {
    return { ok: false, kept: true, error: `기존 손절 주문 취소 실패(기존 손절 유지): ${e.message}` };
  }
  try {
    const stopOrder = await client.placeStopLoss(symbol, stopSide, newStopPrice);
    return { ok: true, stopOrder, appliedStop: Number(newStopPrice), previousStop: exchangeStop };
  } catch (e) {
    const why = e && e.message ? e.message : String(e);
    if (Number(previousStopPrice) > 0) {
      try {
        const restored = await client.placeStopLoss(symbol, stopSide, previousStopPrice);
        return {
          ok: false,
          restored: true,
          stopOrder: restored,
          error: `새 손절 제출 실패 → 기존 손절 ${previousStopPrice} 로 즉시 되돌렸습니다. (${why})`,
        };
      } catch (_) {
        // 되돌리기도 실패 — 청산으로 넘어간다.
      }
    }
    if (Number(quantity) > 0 && typeof client.flattenPosition === 'function') {
      try {
        const flattenOrder = await client.flattenPosition(symbol, stopSide, quantity);
        return {
          ok: false,
          flattened: true,
          flattenOrder,
          error: `새 손절도 기존 손절 복구도 실패해 보호 없는 포지션을 남기지 않으려고 시장가로 청산했습니다. (${why})`,
        };
      } catch (_) {
        // 청산까지 실패 — 사람에게 넘긴다.
      }
    }
    return {
      ok: false,
      error:
        `기존 손절은 취소됐는데 새 손절 제출이 실패했습니다 — 포지션이 보호 없이 남아있습니다. ` +
        `지금 즉시 거래소 앱에서 ${symbol}을 직접 확인하세요. (${why})`,
    };
  }
}

// 최근 24시간 실현손익을 바이낸스에 직접 물어보고, maxLossUsd를 넘겼으면 신규 진입을
// 막는다(막는 것은 이 함수를 호출한 쪽의 몫이다 — 여기는 "막아야 하는지"만 판단한다).
// 이미 열려있는 포지션은 이 체크와 무관하다 — 걸려있는 손절이 계속 보호한다.
// 조회 자체가 실패하면(네트워크 등) 차단하지 않는다 — API 일시 오류로 하루 종일 거래가
// 막히는 것보다, 각 주문마다 이미 걸려있는 포지션 상한선이 최악의 피해를 제한해준다는
// 판단이다. 대신 checked:false로 표시해 호출부가 로그에 남길 수 있게 한다.
async function checkDailyLossLimit({ maxLossUsd, now }, client) {
  if (!(Number(maxLossUsd) > 0)) return { blocked: false, realizedPnl: 0, checked: false };
  const end = Number.isFinite(now) ? now : Date.now();
  const start = end - 24 * 60 * 60 * 1000;
  let records;
  try {
    records = await client.getIncomeHistory({ startTime: start, endTime: end, limit: 1000 });
  } catch (e) {
    return { blocked: false, realizedPnl: null, checked: false, error: e.message };
  }
  // 순손익(실현손익 + 수수료 + 펀딩) 기준으로 판정한다 — 수수료를 빼고 보면 한도가
  // 실제보다 늦게 걸린다. realizedPnl 필드는 호환을 위해 순손익을 담고, 내역을 따로 준다.
  const income = summarizeIncome(records);
  return {
    blocked: isDailyLossLimitExceeded(income.net, maxLossUsd),
    realizedPnl: income.net,
    grossRealizedPnl: income.realized,
    commission: income.commission,
    funding: income.funding,
    checked: true,
    maxLossUsd,
  };
}

// --- 연속 손실 서킷 브레이커 -------------------------------------------------------
// 하루 손실 한도(금액 기준)와는 다른 문제를 본다: 포지션이 작으면 연속으로 여러 번
// 틀려도 금액 한도엔 안 걸릴 수 있다. 근데 "연속으로 계속 틀린다"는 건 지금 이 전략이
// 지금 시장 상황과 안 맞는다는 신호일 가능성이 높다 — 금액과 무관하게 잠깐 멈추고
// 시장이 바뀌길 기다리는 게 합리적이다.

// records(REALIZED_PNL, 아무 순서)에서 가장 최근 건부터 몇 연속으로 손실인지 센다.
// 첫 승리(또는 본전, income>=0)를 만나면 거기서 멈춘다 — 그게 연속 기록의 끝이다.
// 실현손익 기록(체결 조각 단위)을 "청산 건" 단위로 묶는다. 시장가 청산 한 번이 여러 체결로
// 나뉘면 REALIZED_PNL 기록도 여러 줄 생긴다 — 줄 단위로 세면 손실 거래 1건이 "연속 손실
// 3회"로 잡혀 서킷 브레이커가 헛돌 수 있다(행 단위 모집단과 거래 단위 모집단의 혼동).
// 같은 심볼에서 windowMs 이내에 붙은 기록을 한 건으로 보고, 같은 tradeId의 수수료도 더한다.
function groupCloseEvents(records, windowMs = 500) {
  if (!Array.isArray(records)) return [];
  const realized = records.filter(
    (r) => r && r.incomeType === 'REALIZED_PNL' && r.income != null && r.time != null
  );
  const commByTrade = new Map();
  for (const r of records) {
    if (r && r.incomeType === 'COMMISSION' && r.tradeId != null) {
      const v = Number(r.income);
      if (Number.isFinite(v)) commByTrade.set(String(r.tradeId), (commByTrade.get(String(r.tradeId)) || 0) + v);
    }
  }
  const sorted = [...realized].sort((a, b) => Number(a.time) - Number(b.time));
  const events = [];
  for (const r of sorted) {
    const v = Number(r.income);
    if (!Number.isFinite(v)) continue;
    const t = Number(r.time);
    const fee = r.tradeId != null ? commByTrade.get(String(r.tradeId)) || 0 : 0;
    const last = events[events.length - 1];
    if (last && last.symbol === (r.symbol || null) && t - last.lastTime <= windowMs) {
      last.income += v + fee;
      last.lastTime = t;
      last.fills += 1;
    } else {
      events.push({ symbol: r.symbol || null, time: t, lastTime: t, income: v + fee, fills: 1 });
    }
  }
  return events;
}

function countConsecutiveLosses(records, windowMs = 500) {
  if (!Array.isArray(records)) return { count: 0, lastLossTime: null };
  const sorted = groupCloseEvents(records, windowMs)
    .map((e) => ({ income: e.income, time: e.lastTime }))
    .sort((a, b) => Number(b.time) - Number(a.time));
  let count = 0;
  let lastLossTime = null;
  for (const r of sorted) {
    const v = Number(r.income);
    if (!Number.isFinite(v)) continue;
    if (v < 0) {
      count += 1;
      if (lastLossTime == null) lastLossTime = Number(r.time);
    } else {
      break; // 승리(또는 본전)를 만났다 — 연속 기록은 여기서 끊긴다
    }
  }
  return { count, lastLossTime };
}

// threshold번 연속 손실이면, 그 마지막 손실 시점부터 cooldownMs 동안 일시정지 활성.
// cooldownMs가 지나면 자동으로 풀린다(그 다음 거래가 이기면 연속 기록 자체가 끊기고,
// 지면 다시 그 시점부터 새로 cooldown이 걸린다 — 사람이 풀어줄 필요가 없다).
function isConsecutiveLossPauseActive({ count, lastLossTime, threshold, cooldownMs, now }) {
  if (!(Number(threshold) > 0)) return false;
  if (count < threshold) return false;
  if (lastLossTime == null) return false;
  const n = Number.isFinite(now) ? now : Date.now();
  return n - lastLossTime < cooldownMs;
}

// 오케스트레이션 — 최근 실현손익 기록을 조회해서 연속 손실 일시정지 여부를 판단한다.
// threshold가 0 이하면 기능 자체를 끈다. 조회 실패는 하루 손실 한도와 같은 원칙으로
// 막지 않는다(API 일시 오류로 계속 멈춰있게 하지 않는다).
async function checkConsecutiveLossPause({ threshold, cooldownHours, now }, client) {
  if (!(Number(threshold) > 0)) return { paused: false, checked: false };
  const n = Number.isFinite(now) ? now : Date.now();
  const lookbackMs = 30 * 24 * 60 * 60 * 1000; // 30일 — 연속 손실이 며칠에 걸쳐 나올 수 있다
  let records;
  try {
    records = await client.getIncomeHistory({ startTime: n - lookbackMs, endTime: n, limit: 1000 });
  } catch (e) {
    return { paused: false, checked: false, error: e.message };
  }
  const { count, lastLossTime } = countConsecutiveLosses(records);
  const cooldownMs = (Number(cooldownHours) || 0) * 60 * 60 * 1000;
  const paused = isConsecutiveLossPauseActive({ count, lastLossTime, threshold, cooldownMs, now: n });
  return { paused, checked: true, consecutiveLosses: count, lastLossTime, threshold, cooldownHours };
}

// --- 트레일링 스탑(따라가는 손절) ---------------------------------------------------
// AI 판단 없이 순수 계산만으로 동작한다 — 한도가 다 떨어져도(익절 검토 AI 호출이 아예
// 안 되는 상황이어도) 손절선을 "본전 이하로는 절대 안 내려가게" 계속 따라 올릴 수
// 있다. 사용자 시나리오: +10% 수익 상태에서 한도가 없어 AI 검토가 안 되는 사이 큰
// 음봉이 뜨면, 원래 손절선(-2% 등)까지 다 밀려야 정리된다 — 트레일링 스탑은 이 공백을
// 메운다. "본전 고정"이 아니라 "따라가는" 방식을 쓴다 — 그래야 정상적인 되돌림(예:
// +10%에서 -1%로 눌렸다가 다시 +10%로 가는 흐름)에 쫓겨나지 않는다.
//
// 공식: LONG이면 (진입 이후 최고가 − ATR×배수), SHORT면 (진입 이후 최저가 + ATR×배수).
// 기존 손절보다 더 유리한 방향일 때만 갱신 대상으로 삼는다 — 손절선은 절대 불리한
// 방향으로 움직이지 않는다(한 번 올라간 손절이 다시 내려가는 일은 없다).
function computeTrailingStop({ side, highSinceEntry, lowSinceEntry, atr, atrMultiple, currentStop }) {
  const mult = Number.isFinite(atrMultiple) && atrMultiple > 0 ? atrMultiple : 2.5;
  const atrN = Number(atr);
  if (!(atrN > 0)) return null; // ATR 계산이 안 되면(데이터 부족 등) 지어내지 않는다
  const cur = Number(currentStop);
  const s = String(side || '').toUpperCase();

  if (s === 'LONG' || s === 'BUY') {
    const high = Number(highSinceEntry);
    if (!(high > 0)) return null;
    const desired = high - mult * atrN;
    if (Number.isFinite(cur) && desired <= cur) return null; // 기존보다 안 유리하면 갱신 안 함
    return desired;
  }
  if (s === 'SHORT' || s === 'SELL') {
    const low = Number(lowSinceEntry);
    if (!(low > 0)) return null;
    const desired = low + mult * atrN;
    if (Number.isFinite(cur) && desired >= cur) return null;
    return desired;
  }
  return null;
}

module.exports = {
  HARD_LEVERAGE,
  buildIncomeParams,
  pickSymbolFilters,
  HARD_MIN_EV_R,
  checkEdge,
  hmacSha256Hex,
  toQueryString,
  signParams,
  floorToStep,
  toBinanceFuturesSymbol,
  toBinanceSide,
  oppositeSide,
  buildEntryOrderParams,
  buildStopOrderParams,
  buildLeverageParams,
  buildFlattenParams,
  sumRealizedPnl,
  summarizeIncome,
  isExecutionSymbolAllowed,
  DEFAULT_ALLOWED_EXEC_SYMBOLS,
  groupCloseEvents,
  signedPositionAmt,
  reconcileEntryFill,
  checkEntryDrift,
  makeClientOrderId,
  isDailyLossLimitExceeded,
  isRetryableError,
  withRetry,
  hasOpenPosition,
  summarizeOpenPosition,
  summarizeAllOpenPositions,
  totalNotionalOf,
  checkPortfolioExposure,
  createClient,
  openPositionWithStop,
  closeExistingPosition,
  updateStopLoss,
  stopWouldTriggerNow,
  findExchangeStop,
  roundStopToTick,
  isLooserStop,
  checkDailyLossLimit,
  countConsecutiveLosses,
  isConsecutiveLossPauseActive,
  checkConsecutiveLossPause,
  computeTrailingStop,
};

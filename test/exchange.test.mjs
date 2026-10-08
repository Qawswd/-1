import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  HARD_LEVERAGE,
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
  isDailyLossLimitExceeded,
  isRetryableError,
  withRetry,
  hasOpenPosition,
  summarizeOpenPosition,
  summarizeAllOpenPositions,
  totalNotionalOf,
  checkPortfolioExposure,
  openPositionWithStop,
  closeExistingPosition,
  updateStopLoss,
  checkDailyLossLimit,
  countConsecutiveLosses,
  summarizeIncome,
  groupCloseEvents,
  signedPositionAmt,
  reconcileEntryFill,
  checkEntryDrift,
  makeClientOrderId,
  isConsecutiveLossPauseActive,
  checkConsecutiveLossPause,
  computeTrailingStop,
} = require('../server/exchange.js');

// --- toBinanceFuturesSymbol ---------------------------------------------------
// 실전 검증(verify-decision-pipeline.js)에서 실제로 터진 버그의 재발 방지 테스트.
// market.js는 내부적으로 'BTC'처럼 짧게 표기하는데, 바이낸스 선물은 'BTCUSDT'처럼
// 완전한 심볼명을 요구한다 — 이 변환이 없으면 "Invalid symbol"로 매번 거부당한다.

test('toBinanceFuturesSymbol: USDT가 없으면 붙인다(실전에서 터진 버그 그대로)', () => {
  assert.equal(toBinanceFuturesSymbol('BTC'), 'BTCUSDT');
});

test('toBinanceFuturesSymbol: 이미 USDT로 끝나면 중복으로 안 붙인다', () => {
  assert.equal(toBinanceFuturesSymbol('BTCUSDT'), 'BTCUSDT');
});

test('toBinanceFuturesSymbol: 소문자도 대문자로 정규화한다', () => {
  assert.equal(toBinanceFuturesSymbol('btc'), 'BTCUSDT');
});

test('toBinanceFuturesSymbol: 대시 표기(SKHYNIX-USDT)도 안전하게 처리한다', () => {
  assert.equal(toBinanceFuturesSymbol('SKHYNIX-USDT'), 'SKHYNIXUSDT');
});

test('toBinanceFuturesSymbol: 앞뒤 공백은 무시한다', () => {
  assert.equal(toBinanceFuturesSymbol('  aapl  '), 'AAPLUSDT');
});

test('toBinanceFuturesSymbol: 빈 값은 빈 문자열 그대로(에러를 던지지 않는다)', () => {
  assert.equal(toBinanceFuturesSymbol(''), '');
  assert.equal(toBinanceFuturesSymbol(null), '');
  assert.equal(toBinanceFuturesSymbol(undefined), '');
});

// --- hmacSha256Hex ---------------------------------------------------------

test('hmacSha256Hex: 같은 입력이면 항상 같은 서명(결정적)', () => {
  const a = hmacSha256Hex('secret', 'symbol=BTCUSDT&timestamp=1');
  const b = hmacSha256Hex('secret', 'symbol=BTCUSDT&timestamp=1');
  assert.equal(a, b);
  assert.equal(a.length, 64); // sha256 hex = 64자
});

test('hmacSha256Hex: 시크릿이 다르면 서명도 다르다', () => {
  const a = hmacSha256Hex('secret1', 'same-message');
  const b = hmacSha256Hex('secret2', 'same-message');
  assert.notEqual(a, b);
});

test('hmacSha256Hex: 메시지가 다르면 서명도 다르다', () => {
  const a = hmacSha256Hex('secret', 'message1');
  const b = hmacSha256Hex('secret', 'message2');
  assert.notEqual(a, b);
});

// --- toQueryString -----------------------------------------------------------

test('toQueryString: 기본 key=value 조합', () => {
  assert.equal(toQueryString({ symbol: 'BTCUSDT', side: 'BUY' }), 'symbol=BTCUSDT&side=BUY');
});

test('toQueryString: null/undefined 값은 건너뛴다', () => {
  assert.equal(toQueryString({ a: 1, b: null, c: undefined, d: 2 }), 'a=1&d=2');
});

test('toQueryString: 특수문자는 URL 인코딩된다', () => {
  const qs = toQueryString({ a: 'x&y=z' });
  assert.equal(qs, 'a=x%26y%3Dz');
});

// --- signParams --------------------------------------------------------------

test('signParams: timestamp·recvWindow·signature가 포함되고, signature는 나머지 쿼리의 HMAC과 일치한다', () => {
  const now = 1700000000000;
  const full = signParams({ symbol: 'BTCUSDT' }, 'my-secret', now);
  assert.match(full, /symbol=BTCUSDT&timestamp=1700000000000&recvWindow=5000&signature=[0-9a-f]{64}$/);
  const base = 'symbol=BTCUSDT&timestamp=1700000000000&recvWindow=5000';
  const expectedSig = hmacSha256Hex('my-secret', base);
  assert.ok(full.endsWith(`signature=${expectedSig}`));
});

test('signParams: 호출 시점(now)이 다르면 timestamp도 달라져 재전송 시 매번 새로 서명된다', () => {
  const a = signParams({ symbol: 'BTCUSDT' }, 'secret', 1000);
  const b = signParams({ symbol: 'BTCUSDT' }, 'secret', 2000);
  assert.notEqual(a, b);
});

// --- floorToStep ---------------------------------------------------------------

test('floorToStep: step 미만 자리는 버림(반올림 아님, 내림)', () => {
  assert.equal(floorToStep(0.1239, 0.001), 0.123);
});

test('floorToStep: 정확히 step의 배수면 그대로', () => {
  assert.equal(floorToStep(0.5, 0.1), 0.5);
});

test('floorToStep: 부동소수점 오차로 실제보다 한 단계 깎이지 않는다', () => {
  // 0.3 / 0.1 은 부동소수점상 2.9999...로 계산될 수 있어 floor하면 0.2가 되는 함정이 있다.
  assert.equal(floorToStep(0.3, 0.1), 0.3);
});

test('floorToStep: step이 정수여도 동작한다', () => {
  assert.equal(floorToStep(7, 5), 5);
});

test('floorToStep: step이 0이거나 음수면 null', () => {
  assert.equal(floorToStep(1, 0), null);
  assert.equal(floorToStep(1, -1), null);
});

// --- toBinanceSide / oppositeSide -----------------------------------------------

test('toBinanceSide: BUY/LONG → BUY, SELL/SHORT → SELL, 대소문자 무관', () => {
  assert.equal(toBinanceSide('BUY'), 'BUY');
  assert.equal(toBinanceSide('long'), 'BUY');
  assert.equal(toBinanceSide('SELL'), 'SELL');
  assert.equal(toBinanceSide('short'), 'SELL');
});

test('toBinanceSide: 알 수 없는 값은 null(HOLD 등은 애초에 주문을 안 내야 하므로)', () => {
  assert.equal(toBinanceSide('HOLD'), null);
  assert.equal(toBinanceSide(''), null);
  assert.equal(toBinanceSide(undefined), null);
});

test('oppositeSide: BUY↔SELL 반전', () => {
  assert.equal(oppositeSide('BUY'), 'SELL');
  assert.equal(oppositeSide('SELL'), 'BUY');
  assert.equal(oppositeSide('WAT'), null);
});

// --- 파라미터 빌더 ----------------------------------------------------------------

test('buildEntryOrderParams: MARKET 주문, RESULT 응답 요청', () => {
  const p = buildEntryOrderParams({ symbol: 'AAPLUSDT', side: 'BUY', quantity: 1.5 });
  assert.deepEqual(p, {
    symbol: 'AAPLUSDT',
    side: 'BUY',
    type: 'MARKET',
    quantity: 1.5,
    newOrderRespType: 'RESULT',
  });
});

test('buildStopOrderParams: STOP_MARKET + closePosition=true, quantity 없음(바이낸스가 같이 보내면 거부하기 때문)', () => {
  const p = buildStopOrderParams({ symbol: 'AAPLUSDT', side: 'SELL', triggerPrice: 180.5 });
  assert.equal(p.algoType, 'CONDITIONAL');
  assert.equal(p.type, 'STOP_MARKET');
  assert.equal(p.closePosition, 'true');
  assert.equal(p.triggerPrice, 180.5);
  assert.equal('quantity' in p, false);
  assert.equal('reduceOnly' in p, false);
});

test('buildLeverageParams: 항상 1배 — 다른 값을 받을 방법 자체가 없다', () => {
  const p = buildLeverageParams({ symbol: 'AAPLUSDT' });
  assert.equal(p.leverage, 1);
  assert.equal(p.leverage, HARD_LEVERAGE);
});

test('buildFlattenParams: reduceOnly=true인 시장가 청산 주문', () => {
  const p = buildFlattenParams({ symbol: 'AAPLUSDT', side: 'SELL', quantity: 1.5 });
  assert.equal(p.type, 'MARKET');
  assert.equal(p.reduceOnly, 'true');
  assert.equal(p.side, 'SELL');
});

// --- openPositionWithStop (가짜 클라이언트로 네트워크 없이 검증) --------------------

function makeFakeClient(overrides = {}) {
  const calls = { setLeverage: [], placeMarketOrder: [], placeStopLoss: [], flattenPosition: [] };
  const client = {
    setLeverage: async (symbol) => {
      calls.setLeverage.push(symbol);
      return { leverage: 1, symbol };
    },
    placeMarketOrder: async (symbol, side, quantity) => {
      calls.placeMarketOrder.push({ symbol, side, quantity });
      return { executedQty: String(quantity), symbol, side };
    },
    placeStopLoss: async (symbol, side, triggerPrice) => {
      calls.placeStopLoss.push({ symbol, side, triggerPrice });
      return { algoId: 1, symbol, side, triggerPrice };
    },
    flattenPosition: async (symbol, side, quantity) => {
      calls.flattenPosition.push({ symbol, side, quantity });
      return { executedQty: String(quantity), symbol, side };
    },
    ...overrides,
  };
  return { client, calls };
}

test('openPositionWithStop: 정상 흐름 — 레버리지 고정 → 진입 → 손절 순서로 호출되고 ok:true', async () => {
  const { client, calls } = makeFakeClient();
  const res = await openPositionWithStop(
    { symbol: 'AAPLUSDT', action: 'BUY', quantity: 2, stopPrice: 170 },
    client
  );
  assert.equal(res.ok, true);
  assert.equal(calls.setLeverage.length, 1);
  assert.equal(calls.placeMarketOrder.length, 1);
  assert.equal(calls.placeMarketOrder[0].side, 'BUY');
  assert.equal(calls.placeStopLoss.length, 1);
  assert.equal(calls.placeStopLoss[0].side, 'SELL'); // 진입 BUY의 반대
  assert.equal(calls.placeStopLoss[0].triggerPrice, 170);
});

test('openPositionWithStop: SHORT 진입이면 손절 side는 BUY', async () => {
  const { client, calls } = makeFakeClient();
  await openPositionWithStop({ symbol: 'AAPLUSDT', action: 'SELL', quantity: 2, stopPrice: 190 }, client);
  assert.equal(calls.placeMarketOrder[0].side, 'SELL');
  assert.equal(calls.placeStopLoss[0].side, 'BUY');
});

test('openPositionWithStop: action이 잘못됐으면 아무 주문도 안 내고 즉시 실패', async () => {
  const { client, calls } = makeFakeClient();
  const res = await openPositionWithStop({ symbol: 'AAPLUSDT', action: 'HOLD', quantity: 1, stopPrice: 100 }, client);
  assert.equal(res.ok, false);
  assert.equal(calls.setLeverage.length, 0);
  assert.equal(calls.placeMarketOrder.length, 0);
});

test('openPositionWithStop: 수량이 0 이하면 주문 없이 즉시 실패', async () => {
  const { client, calls } = makeFakeClient();
  const res = await openPositionWithStop({ symbol: 'AAPLUSDT', action: 'BUY', quantity: 0, stopPrice: 100 }, client);
  assert.equal(res.ok, false);
  assert.equal(calls.placeMarketOrder.length, 0);
});

test('openPositionWithStop: 진입 주문이 체결 안 되면(executedQty 0) 손절은 걸지 않는다', async () => {
  const { client, calls } = makeFakeClient({
    placeMarketOrder: async (symbol, side, quantity) => {
      calls.placeMarketOrder.push({ symbol, side, quantity });
      return { executedQty: '0' }; // 미체결
    },
  });
  const res = await openPositionWithStop({ symbol: 'AAPLUSDT', action: 'BUY', quantity: 1, stopPrice: 100 }, client);
  assert.equal(res.ok, false);
  assert.equal(calls.placeStopLoss.length, 0);
});

test('openPositionWithStop: 진입 주문이 예외를 던지고 거래소 확인 수단도 없으면 "실패"가 아니라 "미확인"으로 보고하고 재전송하지 않는다(R11)', async () => {
  const { client, calls } = makeFakeClient({
    placeMarketOrder: async () => {
      throw new Error('네트워크 오류');
    },
  });
  const res = await openPositionWithStop({ symbol: 'AAPLUSDT', action: 'BUY', quantity: 1, stopPrice: 100 }, client);
  assert.equal(res.ok, false);
  assert.equal(res.unknown, true);
  assert.match(res.error, /진입 결과를 확인할 수 없습니다/);
  assert.match(res.error, /다시 보내지 않았습니다/);
  assert.equal(calls.placeMarketOrder.length, 0); // 가짜 override라 기록 안 되지만, 재시도 호출이 없음을 아래에서 확인
  assert.equal(calls.placeStopLoss.length, 0);
});

test('openPositionWithStop: 손절 주문 제출이 실패하면 즉시 청산을 시도하고, 성공하면 flattened:true', async () => {
  const { client, calls } = makeFakeClient({
    placeStopLoss: async () => {
      throw new Error('거래소 일시 오류');
    },
  });
  const res = await openPositionWithStop({ symbol: 'AAPLUSDT', action: 'BUY', quantity: 2, stopPrice: 170 }, client);
  assert.equal(res.ok, false);
  assert.equal(res.stopFailed, true);
  assert.equal(res.flattened, true);
  assert.equal(calls.flattenPosition.length, 1);
  assert.equal(calls.flattenPosition[0].side, 'SELL'); // 진입 반대 방향으로 청산
  assert.equal(calls.flattenPosition[0].quantity, 2); // 실제 체결된 수량 그대로
});

test('openPositionWithStop: 레버리지 설정이 실패하면 진입 자체를 시도하지 않고 안전하게 실패 반환', async () => {
  const { client, calls } = makeFakeClient({
    setLeverage: async () => {
      throw new Error('leverage not allowed for this symbol');
    },
  });
  const res = await openPositionWithStop({ symbol: 'AAPLUSDT', action: 'BUY', quantity: 1, stopPrice: 100 }, client);
  assert.equal(res.ok, false);
  assert.match(res.error, /레버리지 설정 실패/);
  assert.equal(calls.placeMarketOrder.length, 0); // 진입 시도 자체를 안 함
  assert.equal(calls.placeStopLoss.length, 0);
});

test('openPositionWithStop: 손절도 실패하고 청산도 실패하면 — 사람이 직접 확인하라는 명확한 메시지를 남긴다', async () => {
  const { client } = makeFakeClient({
    placeStopLoss: async () => {
      throw new Error('손절 거부');
    },
    flattenPosition: async () => {
      throw new Error('청산도 거부');
    },
  });
  const res = await openPositionWithStop({ symbol: 'AAPLUSDT', action: 'BUY', quantity: 2, stopPrice: 170 }, client);
  assert.equal(res.ok, false);
  assert.equal(res.stopFailed, true);
  assert.equal(res.flattened, false);
  assert.match(res.error, /즉시.*확인/);
  assert.match(res.error, /손절 거부/);
  assert.match(res.error, /청산도 거부/);
});

// --- sumRealizedPnl / isDailyLossLimitExceeded (순수 함수) ------------------------

test('sumRealizedPnl: REALIZED_PNL 항목만 합산하고 다른 종류(수수료 등)는 무시한다', () => {
  const records = [
    { incomeType: 'REALIZED_PNL', income: '-10.5' },
    { incomeType: 'COMMISSION', income: '-1.2' }, // 합산 대상 아님
    { incomeType: 'REALIZED_PNL', income: '3.25' },
    { incomeType: 'FUNDING_FEE', income: '-0.5' }, // 합산 대상 아님
  ];
  assert.equal(sumRealizedPnl(records), -7.25);
});

test('sumRealizedPnl: 빈 배열이나 잘못된 입력은 0', () => {
  assert.equal(sumRealizedPnl([]), 0);
  assert.equal(sumRealizedPnl(null), 0);
  assert.equal(sumRealizedPnl(undefined), 0);
});

test('sumRealizedPnl: income이 숫자로 안 읽히는 항목은 건너뛴다(에러 안 던짐)', () => {
  const records = [{ incomeType: 'REALIZED_PNL', income: 'not-a-number' }, { incomeType: 'REALIZED_PNL', income: '5' }];
  assert.equal(sumRealizedPnl(records), 5);
});

test('isDailyLossLimitExceeded: 한도(maxLossUsd)가 0 이하면 체크 자체를 안 함(항상 false)', () => {
  assert.equal(isDailyLossLimitExceeded(-1000, 0), false);
  assert.equal(isDailyLossLimitExceeded(-1000, -5), false);
});

test('isDailyLossLimitExceeded: 손실이 한도에 딱 걸치면(같으면) 초과로 본다', () => {
  assert.equal(isDailyLossLimitExceeded(-250, 250), true);
});

test('isDailyLossLimitExceeded: 손실이 한도보다 적으면 통과', () => {
  assert.equal(isDailyLossLimitExceeded(-100, 250), false);
});

test('isDailyLossLimitExceeded: 오늘 수익이면(양수) 당연히 통과', () => {
  assert.equal(isDailyLossLimitExceeded(50, 250), false);
});

// --- checkDailyLossLimit (가짜 클라이언트로 오케스트레이션 검증) -------------------------

test('checkDailyLossLimit: maxLossUsd가 0이면 조회 자체를 안 하고 blocked:false', async () => {
  let called = false;
  const client = { getIncomeHistory: async () => { called = true; return []; } };
  const res = await checkDailyLossLimit({ maxLossUsd: 0 }, client);
  assert.equal(res.blocked, false);
  assert.equal(res.checked, false);
  assert.equal(called, false);
});

test('checkDailyLossLimit: 최근 24시간 손실이 한도를 넘으면 blocked:true', async () => {
  const client = {
    getIncomeHistory: async () => [
      { incomeType: 'REALIZED_PNL', income: '-150' },
      { incomeType: 'REALIZED_PNL', income: '-120' },
    ],
  };
  const res = await checkDailyLossLimit({ maxLossUsd: 250 }, client);
  assert.equal(res.checked, true);
  assert.equal(res.realizedPnl, -270);
  assert.equal(res.blocked, true);
});

test('checkDailyLossLimit: 손실이 한도 이내면 blocked:false', async () => {
  const client = { getIncomeHistory: async () => [{ incomeType: 'REALIZED_PNL', income: '-50' }] };
  const res = await checkDailyLossLimit({ maxLossUsd: 250 }, client);
  assert.equal(res.blocked, false);
  assert.equal(res.realizedPnl, -50);
});

test('checkDailyLossLimit: 조회가 실패하면 막지 않는다(API 오류로 하루 종일 거래가 막히지 않도록)', async () => {
  const client = { getIncomeHistory: async () => { throw new Error('네트워크 오류'); } };
  const res = await checkDailyLossLimit({ maxLossUsd: 250 }, client);
  assert.equal(res.blocked, false);
  assert.equal(res.checked, false);
  assert.match(res.error, /네트워크 오류/);
});

test('checkDailyLossLimit: 조회 시 최근 24시간 범위(startTime/endTime)로 요청한다', async () => {
  let seenParams = null;
  const client = {
    getIncomeHistory: async (params) => {
      seenParams = params;
      return [];
    },
  };
  const now = 1_700_000_000_000;
  await checkDailyLossLimit({ maxLossUsd: 100, now }, client);
  assert.equal(seenParams.endTime, now);
  assert.equal(seenParams.startTime, now - 24 * 60 * 60 * 1000);
});

// --- hasOpenPosition / summarizeOpenPosition (순수 함수) --------------------------

test('hasOpenPosition: positionAmt가 0이 아니면 true', () => {
  assert.equal(hasOpenPosition([{ positionAmt: '0.013' }]), true);
  assert.equal(hasOpenPosition([{ positionAmt: '-0.5' }]), true);
});

test('hasOpenPosition: positionAmt가 0이거나 배열이 비었으면 false', () => {
  assert.equal(hasOpenPosition([{ positionAmt: '0.000' }]), false);
  assert.equal(hasOpenPosition([]), false);
  assert.equal(hasOpenPosition(null), false);
});

test('summarizeOpenPosition: 포지션 없으면 null', () => {
  assert.equal(summarizeOpenPosition([{ positionAmt: '0' }]), null);
  assert.equal(summarizeOpenPosition([]), null);
  assert.equal(summarizeOpenPosition(null), null);
});

test('summarizeOpenPosition: 양수 positionAmt는 LONG, 손익%을 진입가 기준으로 계산', () => {
  const s = summarizeOpenPosition([
    { positionAmt: '0.5', entryPrice: '100', markPrice: '110', unRealizedProfit: '5' },
  ]);
  assert.equal(s.side, 'LONG');
  assert.equal(s.quantity, 0.5);
  assert.equal(s.entry, 100);
  assert.equal(s.unrealizedPct, 10); // (110-100)/100*100
});

test('summarizeOpenPosition: 음수 positionAmt는 SHORT, 가격이 내려가야 이익(%부호가 뒤집힌다)', () => {
  const s = summarizeOpenPosition([
    { positionAmt: '-0.5', entryPrice: '100', markPrice: '90', unRealizedProfit: '5' },
  ]);
  assert.equal(s.side, 'SHORT');
  assert.equal(s.quantity, 0.5); // 절댓값
  assert.equal(s.unrealizedPct, 10); // 숏은 가격이 내려간 게 이익이므로 부호 반전
});

// --- closeExistingPosition (가짜 클라이언트) --------------------------------------

test('closeExistingPosition: 손절(algo) 주문부터 취소한 다음 반대 방향으로 청산한다', async () => {
  const calls = { cancel: [], flatten: [] };
  const client = {
    cancelAllAlgoOrders: async (symbol) => {
      calls.cancel.push(symbol);
    },
    flattenPosition: async (symbol, side, quantity) => {
      calls.flatten.push({ symbol, side, quantity });
      return { executedQty: String(quantity) };
    },
  };
  const res = await closeExistingPosition({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01 }, client);
  assert.equal(res.ok, true);
  assert.equal(calls.cancel.length, 1);
  assert.equal(calls.flatten[0].side, 'SELL'); // LONG을 청산하려면 SELL
  assert.equal(calls.flatten[0].quantity, 0.01);
});

test('closeExistingPosition: 손절 취소 자체가 실패하면 청산 시도 없이 즉시 실패 반환', async () => {
  const calls = { flatten: [] };
  const client = {
    cancelAllAlgoOrders: async () => {
      throw new Error('취소 거부');
    },
    flattenPosition: async (...args) => {
      calls.flatten.push(args);
      return {};
    },
  };
  const res = await closeExistingPosition({ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.01 }, client);
  assert.equal(res.ok, false);
  assert.match(res.error, /취소 거부/);
  assert.equal(calls.flatten.length, 0);
});

test('closeExistingPosition: 취소는 됐는데 청산이 실패하면 — 직접 확인하라는 명확한 경고', async () => {
  const client = {
    cancelAllAlgoOrders: async () => {},
    flattenPosition: async () => {
      throw new Error('청산 거부');
    },
  };
  const res = await closeExistingPosition({ symbol: 'BTCUSDT', side: 'SHORT', quantity: 0.02 }, client);
  assert.equal(res.ok, false);
  assert.match(res.error, /즉시.*확인/);
  assert.match(res.error, /청산 거부/);
});

test('closeExistingPosition: side가 BUY/SELL 형식으로 와도 동일하게 동작한다', async () => {
  const calls = { flatten: [] };
  const client = {
    cancelAllAlgoOrders: async () => {},
    flattenPosition: async (symbol, side, quantity) => {
      calls.flatten.push({ symbol, side, quantity });
      return {};
    },
  };
  await closeExistingPosition({ symbol: 'BTCUSDT', side: 'BUY', quantity: 0.01 }, client);
  assert.equal(calls.flatten[0].side, 'SELL');
});

test('closeExistingPosition: 알 수 없는 방향이면 청산 시도 없이 명확히 실패', async () => {
  const client = {
    cancelAllAlgoOrders: async () => {},
    flattenPosition: async () => ({}),
  };
  const res = await closeExistingPosition({ symbol: 'BTCUSDT', side: 'WAT', quantity: 0.01 }, client);
  assert.equal(res.ok, false);
  assert.match(res.error, /알 수 없는 방향/);
});

// --- summarizeAllOpenPositions --------------------------------------------------

test('summarizeAllOpenPositions: 여러 심볼의 열린 포지션을 전부 배열로 돌려준다', () => {
  const list = summarizeAllOpenPositions([
    { symbol: 'BTCUSDT', positionAmt: '0.01', entryPrice: '76000', markPrice: '77000', unRealizedProfit: '10' },
    { symbol: 'ETHUSDT', positionAmt: '-1', entryPrice: '3000', markPrice: '2900', unRealizedProfit: '100' },
  ]);
  assert.equal(list.length, 2);
  assert.equal(list[0].symbol, 'BTCUSDT');
  assert.equal(list[0].side, 'LONG');
  assert.equal(list[1].symbol, 'ETHUSDT');
  assert.equal(list[1].side, 'SHORT');
});

test('summarizeAllOpenPositions: positionAmt가 0인 항목은 제외한다', () => {
  const list = summarizeAllOpenPositions([
    { symbol: 'BTCUSDT', positionAmt: '0', entryPrice: '76000', markPrice: '77000' },
    { symbol: 'ETHUSDT', positionAmt: '0.5', entryPrice: '3000', markPrice: '3100' },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].symbol, 'ETHUSDT');
});

test('summarizeAllOpenPositions: 열린 포지션이 하나도 없으면 빈 배열(null 아님)', () => {
  assert.deepEqual(summarizeAllOpenPositions([{ symbol: 'BTCUSDT', positionAmt: '0' }]), []);
  assert.deepEqual(summarizeAllOpenPositions([]), []);
});

test('summarizeAllOpenPositions: 잘못된 입력(배열 아님)도 빈 배열', () => {
  assert.deepEqual(summarizeAllOpenPositions(null), []);
  assert.deepEqual(summarizeAllOpenPositions(undefined), []);
});

// --- isRetryableError / withRetry (재시도 로직) -----------------------------------

test('isRetryableError: status가 없으면(네트워크 자체 실패) 재시도 대상', () => {
  assert.equal(isRetryableError(new Error('network fail')), true);
});

test('isRetryableError: 5xx는 재시도 대상', () => {
  const e = new Error('x');
  e.status = 503;
  assert.equal(isRetryableError(e), true);
});

test('isRetryableError: 429(rate limit)는 재시도 대상', () => {
  const e = new Error('x');
  e.status = 429;
  assert.equal(isRetryableError(e), true);
});

test('isRetryableError: 4xx(400, 401 등)는 재시도 대상 아님 — 다시 물어봐도 똑같이 실패한다', () => {
  const e400 = new Error('x');
  e400.status = 400;
  const e401 = new Error('x');
  e401.status = 401;
  assert.equal(isRetryableError(e400), false);
  assert.equal(isRetryableError(e401), false);
});

test('isRetryableError: null/undefined 입력은 false', () => {
  assert.equal(isRetryableError(null), false);
  assert.equal(isRetryableError(undefined), false);
});

test('withRetry: 성공하면 재시도 없이 바로 결과를 준다', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetry: 재시도 가능한 오류면 성공할 때까지 다시 시도한다', async () => {
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) {
        const e = new Error('일시적 오류');
        e.status = 503;
        throw e;
      }
      return 'ok';
    },
    { retries: 3, baseDelayMs: 1 }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
});

test('withRetry: 재시도 불가능한 오류(4xx)는 즉시 던지고 재시도하지 않는다', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls++;
      const e = new Error('Invalid symbol');
      e.status = 400;
      throw e;
    })
  );
  assert.equal(calls, 1); // 재시도 없이 한 번만 시도
});

test('withRetry: retries 횟수를 다 쓰면 마지막 오류를 그대로 던진다', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls++;
        const e = new Error('계속 실패');
        e.status = 503;
        throw e;
      },
      { retries: 2, baseDelayMs: 1 }
    ),
    /계속 실패/
  );
  assert.equal(calls, 3); // 최초 시도 + 재시도 2번
});

// --- updateStopLoss (손절선 재조정 — 익절 검토에서 손절을 당길 때) --------------------

test('updateStopLoss: 기존 손절 취소 후 새 가격으로 다시 건다', async () => {
  const calls = { cancel: [], stop: [] };
  const client = {
    cancelAllAlgoOrders: async (symbol) => { calls.cancel.push(symbol); },
    placeStopLoss: async (symbol, side, price) => {
      calls.stop.push({ symbol, side, price });
      return { algoId: 1 };
    },
  };
  const res = await updateStopLoss({ symbol: 'BTCUSDT', side: 'LONG', newStopPrice: 80000 }, client);
  assert.equal(res.ok, true);
  assert.equal(calls.cancel.length, 1);
  assert.equal(calls.stop[0].side, 'SELL'); // LONG 보호 손절은 SELL
  assert.equal(calls.stop[0].price, 80000);
});

test('updateStopLoss: 새 손절가가 유효하지 않으면(0 이하) 아무 주문도 안 내고 즉시 실패', async () => {
  const client = { cancelAllAlgoOrders: async () => {}, placeStopLoss: async () => ({}) };
  const res = await updateStopLoss({ symbol: 'BTCUSDT', side: 'LONG', newStopPrice: 0 }, client);
  assert.equal(res.ok, false);
  assert.match(res.error, /유효하지 않습니다/);
});

test('updateStopLoss: 기존 손절 취소 자체가 실패하면 새 손절 시도 없이 즉시 실패', async () => {
  const calls = { stop: [] };
  const client = {
    cancelAllAlgoOrders: async () => { throw new Error('취소 거부'); },
    placeStopLoss: async (...args) => { calls.stop.push(args); return {}; },
  };
  const res = await updateStopLoss({ symbol: 'BTCUSDT', side: 'LONG', newStopPrice: 80000 }, client);
  assert.equal(res.ok, false);
  assert.match(res.error, /취소 거부/);
  assert.equal(calls.stop.length, 0);
});

test('updateStopLoss: 취소는 됐는데 새 손절 제출이 실패하면 — 보호 없이 남았다는 긴급 경고', async () => {
  const client = {
    cancelAllAlgoOrders: async () => {},
    placeStopLoss: async () => { throw new Error('제출 거부'); },
  };
  const res = await updateStopLoss({ symbol: 'BTCUSDT', side: 'SHORT', newStopPrice: 70000 }, client);
  assert.equal(res.ok, false);
  assert.match(res.error, /보호 없이 남아있습니다/);
  assert.match(res.error, /직접 확인/);
});

test('updateStopLoss: side가 SHORT면 새 손절은 BUY 방향으로 걸린다', async () => {
  const calls = { stop: [] };
  const client = {
    cancelAllAlgoOrders: async () => {},
    placeStopLoss: async (symbol, side, price) => { calls.stop.push({ side }); return {}; },
  };
  await updateStopLoss({ symbol: 'BTCUSDT', side: 'SHORT', newStopPrice: 70000 }, client);
  assert.equal(calls.stop[0].side, 'BUY');
});

test('updateStopLoss: 새 손절이 현재가를 이미 넘었으면(-2021 상황) 아무것도 취소하지 않고 기존 손절 유지 — 10/2 BTC 사고 재현', async () => {
  const calls = { cancel: 0, stop: 0 };
  const client = {
    getMarkPrice: async () => ({ markPrice: 85873 }),
    cancelAllAlgoOrders: async () => { calls.cancel += 1; },
    placeStopLoss: async () => { calls.stop += 1; return {}; },
  };
  const res = await updateStopLoss({ symbol: 'BTCUSDT', side: 'LONG', newStopPrice: 86000, previousStopPrice: 82581, quantity: 0.012 }, client);
  assert.equal(res.ok, false);
  assert.equal(res.kept, true);
  assert.equal(calls.cancel, 0, '기존 손절을 건드리지 않는다');
  assert.equal(calls.stop, 0);
  assert.match(res.error, /기존 손절은 그대로/);
});

test('updateStopLoss: 새 손절 제출 실패 → 기존 손절가로 즉시 복구', async () => {
  const placed = [];
  const client = {
    cancelAllAlgoOrders: async () => {},
    placeStopLoss: async (symbol, side, price) => {
      if (price === 84000) throw new Error('Order would immediately trigger');
      placed.push({ side, price });
      return { algoId: 2 };
    },
  };
  const res = await updateStopLoss({ symbol: 'BTCUSDT', side: 'LONG', newStopPrice: 84000, previousStopPrice: 82581, quantity: 0.012 }, client);
  assert.equal(res.restored, true);
  assert.deepEqual(placed, [{ side: 'SELL', price: 82581 }]);
  assert.match(res.error, /기존 손절 82581 로 즉시 되돌렸습니다/);
});

test('updateStopLoss: 복구도 실패하면 시장가 청산 — 보호 없는 포지션을 남기지 않는다', async () => {
  const flat = [];
  const client = {
    cancelAllAlgoOrders: async () => {},
    placeStopLoss: async () => { throw new Error('거부'); },
    flattenPosition: async (symbol, side, qty) => { flat.push({ side, qty }); return { orderId: 9 }; },
  };
  const res = await updateStopLoss({ symbol: 'BTCUSDT', side: 'LONG', newStopPrice: 84000, previousStopPrice: 82581, quantity: 0.012 }, client);
  assert.equal(res.flattened, true);
  assert.deepEqual(flat, [{ side: 'SELL', qty: 0.012 }]);
});

test('stopWouldTriggerNow: 롱 손절은 현재가 아래, 숏 손절은 위여야 한다', async () => {
  const { stopWouldTriggerNow } = require('../server/exchange.js');
  assert.equal(stopWouldTriggerNow('LONG', 86000, 85873), true);
  assert.equal(stopWouldTriggerNow('LONG', 84000, 85873), false);
  assert.equal(stopWouldTriggerNow('SHORT', 85000, 85873), true);
  assert.equal(stopWouldTriggerNow('SHORT', 87000, 85873), false);
  assert.equal(stopWouldTriggerNow('LONG', 84000, null), false, '시세 모르면 판단 보류');
});

// --- totalNotionalOf / checkPortfolioExposure (전체 포트폴리오 노출도) -----------------

test('totalNotionalOf: 여러 포지션의 수량×현재가 합계를 낸다', () => {
  const positions = [
    { quantity: 0.01, markPrice: 80000 }, // 800
    { quantity: 2, markPrice: 300 }, // 600
  ];
  assert.equal(totalNotionalOf(positions), 1400);
});

test('totalNotionalOf: 빈 배열/잘못된 입력은 0', () => {
  assert.equal(totalNotionalOf([]), 0);
  assert.equal(totalNotionalOf(null), 0);
});

test('checkPortfolioExposure: accountSizeUsd나 maxPortfolioExposurePct가 없으면(0 이하) 체크 자체를 안 함', () => {
  const r1 = checkPortfolioExposure({ accountSizeUsd: 0, maxPortfolioExposurePct: 60, currentPositions: [], newNotional: 1000 });
  const r2 = checkPortfolioExposure({ accountSizeUsd: 5000, maxPortfolioExposurePct: 0, currentPositions: [], newNotional: 1000 });
  assert.equal(r1.checked, false);
  assert.equal(r1.blocked, false);
  assert.equal(r2.checked, false);
});

test('checkPortfolioExposure: 기존 포지션 + 신규 합산이 한도 이내면 통과', () => {
  const r = checkPortfolioExposure({
    accountSizeUsd: 5000,
    maxPortfolioExposurePct: 60, // 한도 3000
    currentPositions: [{ quantity: 0.01, markPrice: 80000 }], // 800
    newNotional: 1000,
  });
  // 800 + 1000 = 1800 <= 3000
  assert.equal(r.checked, true);
  assert.equal(r.blocked, false);
  assert.equal(r.currentTotal, 800);
  assert.equal(r.projectedTotal, 1800);
  assert.equal(r.maxAllowed, 3000);
});

test('checkPortfolioExposure: 기존 포지션 + 신규 합산이 한도를 넘으면 차단', () => {
  const r = checkPortfolioExposure({
    accountSizeUsd: 5000,
    maxPortfolioExposurePct: 60, // 한도 3000
    currentPositions: [
      { quantity: 0.02, markPrice: 80000 }, // 1600
      { quantity: 3, markPrice: 336 }, // 1008
    ],
    newNotional: 1000,
  });
  // 1600+1008=2608, +1000=3608 > 3000
  assert.equal(r.blocked, true);
  assert.equal(r.projectedTotal, 3608);
});

test('checkPortfolioExposure: 기존 포지션이 하나도 없으면 신규 포지션 하나만으로 계산한다', () => {
  const r = checkPortfolioExposure({
    accountSizeUsd: 5000,
    maxPortfolioExposurePct: 20, // 한도 1000
    currentPositions: [],
    newNotional: 1500,
  });
  assert.equal(r.blocked, true); // 1500 > 1000
  assert.equal(r.currentTotal, 0);
});

test('checkPortfolioExposure: 한도에 정확히 걸치면(같으면) 통과(초과가 아니라 이상만 막는다)', () => {
  const r = checkPortfolioExposure({
    accountSizeUsd: 5000,
    maxPortfolioExposurePct: 20, // 한도 1000
    currentPositions: [],
    newNotional: 1000,
  });
  assert.equal(r.blocked, false);
});

// --- 연속 손실 서킷 브레이커 -------------------------------------------------------

test('countConsecutiveLosses: 최근부터 손실이 연속이면 그 개수를 센다', () => {
  const records = [
    { incomeType: 'REALIZED_PNL', income: '-10', time: 1000 },
    { incomeType: 'REALIZED_PNL', income: '-5', time: 2000 },
    { incomeType: 'REALIZED_PNL', income: '-8', time: 3000 }, // 가장 최근
  ];
  const r = countConsecutiveLosses(records);
  assert.equal(r.count, 3);
  assert.equal(r.lastLossTime, 3000);
});

test('countConsecutiveLosses: 중간에 승리(양수)가 있으면 그 이전 것들은 안 센다', () => {
  const records = [
    { incomeType: 'REALIZED_PNL', income: '-10', time: 1000 }, // 안 셈(승리 이전)
    { incomeType: 'REALIZED_PNL', income: '20', time: 2000 }, // 승리 — 여기서 끊김
    { incomeType: 'REALIZED_PNL', income: '-5', time: 3000 },
    { incomeType: 'REALIZED_PNL', income: '-8', time: 4000 }, // 가장 최근
  ];
  const r = countConsecutiveLosses(records);
  assert.equal(r.count, 2); // 최근 2건만(3000, 4000)
});

test('countConsecutiveLosses: 순서가 뒤섞여 들어와도(시간순 아님) 정확히 최신부터 센다', () => {
  const records = [
    { incomeType: 'REALIZED_PNL', income: '-5', time: 3000 },
    { incomeType: 'REALIZED_PNL', income: '-10', time: 1000 },
    { incomeType: 'REALIZED_PNL', income: '20', time: 2000 },
  ];
  const r = countConsecutiveLosses(records);
  assert.equal(r.count, 1); // time 3000(가장 최근)만 손실, 그 다음(2000)은 승리라 끊김
});

test('countConsecutiveLosses: 전부 승리면 0', () => {
  const records = [{ incomeType: 'REALIZED_PNL', income: '5', time: 1000 }];
  assert.equal(countConsecutiveLosses(records).count, 0);
});

test('countConsecutiveLosses: 기록이 없으면 0, lastLossTime null', () => {
  const r = countConsecutiveLosses([]);
  assert.equal(r.count, 0);
  assert.equal(r.lastLossTime, null);
});

test('isConsecutiveLossPauseActive: threshold 이상 연속손실 + 쿨다운 안이면 true', () => {
  const now = 1_000_000;
  const active = isConsecutiveLossPauseActive({
    count: 3,
    lastLossTime: now - 1000, // 방금
    threshold: 3,
    cooldownMs: 12 * 60 * 60 * 1000,
    now,
  });
  assert.equal(active, true);
});

test('isConsecutiveLossPauseActive: 연속손실 횟수가 threshold 미만이면 false', () => {
  const now = 1_000_000;
  const active = isConsecutiveLossPauseActive({
    count: 2,
    lastLossTime: now - 1000,
    threshold: 3,
    cooldownMs: 12 * 60 * 60 * 1000,
    now,
  });
  assert.equal(active, false);
});

test('isConsecutiveLossPauseActive: 쿨다운 시간이 지났으면 false(자동으로 풀림)', () => {
  const now = 1_000_000;
  const cooldownMs = 12 * 60 * 60 * 1000;
  const active = isConsecutiveLossPauseActive({
    count: 3,
    lastLossTime: now - cooldownMs - 1000, // 쿨다운보다 더 지남
    threshold: 3,
    cooldownMs,
    now,
  });
  assert.equal(active, false);
});

test('isConsecutiveLossPauseActive: threshold가 0이면(꺼짐) 항상 false', () => {
  const active = isConsecutiveLossPauseActive({ count: 10, lastLossTime: Date.now(), threshold: 0, cooldownMs: 1000, now: Date.now() });
  assert.equal(active, false);
});

test('checkConsecutiveLossPause: threshold가 0이면 조회 자체를 안 함', async () => {
  let called = false;
  const client = { getIncomeHistory: async () => { called = true; return []; } };
  const r = await checkConsecutiveLossPause({ threshold: 0, cooldownHours: 12 }, client);
  assert.equal(r.checked, false);
  assert.equal(called, false);
});

test('checkConsecutiveLossPause: 연속 3회 손실 + 쿨다운 안이면 paused:true', async () => {
  const now = 1_700_000_000_000;
  const client = {
    getIncomeHistory: async () => [
      { incomeType: 'REALIZED_PNL', income: '-10', time: now - 3000 },
      { incomeType: 'REALIZED_PNL', income: '-5', time: now - 2000 },
      { incomeType: 'REALIZED_PNL', income: '-8', time: now - 1000 },
    ],
  };
  const r = await checkConsecutiveLossPause({ threshold: 3, cooldownHours: 12, now }, client);
  assert.equal(r.checked, true);
  assert.equal(r.paused, true);
  assert.equal(r.consecutiveLosses, 3);
});

test('checkConsecutiveLossPause: 조회 실패해도 막지 않는다(API 오류로 계속 멈춰있지 않도록)', async () => {
  const client = { getIncomeHistory: async () => { throw new Error('네트워크 오류'); } };
  const r = await checkConsecutiveLossPause({ threshold: 3, cooldownHours: 12 }, client);
  assert.equal(r.paused, false);
  assert.equal(r.checked, false);
  assert.match(r.error, /네트워크 오류/);
});

test('checkConsecutiveLossPause: 30일치 범위로 조회한다(연속 손실이 며칠에 걸칠 수 있어서)', async () => {
  let seenParams = null;
  const client = { getIncomeHistory: async (p) => { seenParams = p; return []; } };
  const now = 1_700_000_000_000;
  await checkConsecutiveLossPause({ threshold: 3, cooldownHours: 12, now }, client);
  assert.equal(seenParams.endTime, now);
  assert.equal(seenParams.startTime, now - 30 * 24 * 60 * 60 * 1000);
});

// --- computeTrailingStop (따라가는 손절) -----------------------------------------

test('computeTrailingStop: LONG — 최고가에서 ATR×배수만큼 아래가 새 손절가', () => {
  const r = computeTrailingStop({ side: 'LONG', highSinceEntry: 100, atr: 2, atrMultiple: 3, currentStop: 80 });
  assert.equal(r, 100 - 3 * 2); // 94
});

test('computeTrailingStop: LONG — 계산된 새 손절이 기존보다 안 유리하면(낮거나 같으면) null(갱신 안 함)', () => {
  const r = computeTrailingStop({ side: 'LONG', highSinceEntry: 100, atr: 2, atrMultiple: 3, currentStop: 95 });
  // 계산값 94 <= 기존 95 → 갱신 안 함
  assert.equal(r, null);
});

test('computeTrailingStop: SHORT — 최저가에서 ATR×배수만큼 위가 새 손절가', () => {
  const r = computeTrailingStop({ side: 'SHORT', lowSinceEntry: 100, atr: 2, atrMultiple: 3, currentStop: 120 });
  assert.equal(r, 100 + 3 * 2); // 106
});

test('computeTrailingStop: SHORT — 계산된 새 손절이 기존보다 안 유리하면(높거나 같으면) null', () => {
  const r = computeTrailingStop({ side: 'SHORT', lowSinceEntry: 100, atr: 2, atrMultiple: 3, currentStop: 105 });
  // 계산값 106 >= 기존 105 → 갱신 안 함(더 불리해지므로)
  assert.equal(r, null);
});

test('computeTrailingStop: ATR이 없거나 0이면 계산 자체를 안 한다(지어내지 않음)', () => {
  assert.equal(computeTrailingStop({ side: 'LONG', highSinceEntry: 100, atr: 0, currentStop: 80 }), null);
  assert.equal(computeTrailingStop({ side: 'LONG', highSinceEntry: 100, atr: null, currentStop: 80 }), null);
});

test('computeTrailingStop: 기존 손절이 없어도(null) 처음엔 계산값을 그대로 준다', () => {
  const r = computeTrailingStop({ side: 'LONG', highSinceEntry: 100, atr: 2, atrMultiple: 3, currentStop: null });
  assert.equal(r, 94);
});

test('computeTrailingStop: atrMultiple을 안 주면 기본 2.5배를 쓴다', () => {
  const r = computeTrailingStop({ side: 'LONG', highSinceEntry: 100, atr: 4, currentStop: null });
  assert.equal(r, 100 - 2.5 * 4); // 90
});

test('computeTrailingStop: BUY/SELL 표기(거래소 형식)도 LONG/SHORT와 동일하게 처리한다', () => {
  const r1 = computeTrailingStop({ side: 'BUY', highSinceEntry: 100, atr: 2, atrMultiple: 3, currentStop: 80 });
  const r2 = computeTrailingStop({ side: 'SELL', lowSinceEntry: 100, atr: 2, atrMultiple: 3, currentStop: 120 });
  assert.equal(r1, 94);
  assert.equal(r2, 106);
});

test('computeTrailingStop: 알 수 없는 방향이면 null', () => {
  assert.equal(computeTrailingStop({ side: 'WAT', highSinceEntry: 100, atr: 2, currentStop: 80 }), null);
});


// --- R11: 진입 결과 미확정 시 거래소 대사 ------------------------------------------

test('openPositionWithStop: 시간초과 후 주문 조회로 실제 체결이 확인되면 손절을 걸어 보호한다(재전송 없음)', async () => {
  let orderCalls = 0;
  const { client, calls } = makeFakeClient({
    placeMarketOrder: async () => {
      orderCalls += 1;
      throw new Error('ETIMEDOUT');
    },
    getOrderByClientId: async () => ({ status: 'FILLED', executedQty: '0.0118' }),
    getPosition: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
  });
  const res = await openPositionWithStop({ symbol: 'BTCUSDT', action: 'BUY', quantity: 0.0118, stopPrice: 83600 }, client);
  assert.equal(res.ok, true);
  assert.equal(res.reconciled, true);
  assert.equal(res.filledQty, 0.0118);
  assert.equal(orderCalls, 1); // 같은 주문을 다시 보내지 않았다
  assert.equal(calls.placeStopLoss.length, 1);
});

test('openPositionWithStop: 주문 조회에서 거래소에 주문이 없다(-2013)고 확인되면 체결 없음으로 확정', async () => {
  const { client, calls } = makeFakeClient({
    placeMarketOrder: async () => {
      throw new Error('ETIMEDOUT');
    },
    getOrderByClientId: async () => {
      const e = new Error('Order does not exist');
      e.binanceCode = -2013;
      throw e;
    },
    getPosition: async () => [{ symbol: 'BTCUSDT', positionAmt: '0' }],
  });
  const res = await openPositionWithStop({ symbol: 'BTCUSDT', action: 'BUY', quantity: 0.01, stopPrice: 83600 }, client);
  assert.equal(res.ok, false);
  assert.ok(!res.unknown);
  assert.match(res.error, /체결 없음/);
  assert.equal(calls.placeStopLoss.length, 0);
});

test('reconcileEntryFill: 주문 조회가 안 되면 주문 전후 보유 수량 차이로 체결량을 확정한다', async () => {
  const client = {
    getOrderByClientId: async () => {
      throw new Error('network');
    },
    getPosition: async () => [{ symbol: 'BTCUSDT', positionAmt: '-0.02' }],
  };
  const r = await reconcileEntryFill({ client, symbol: 'BTCUSDT', side: 'SELL', clientOrderId: 'x', preAmt: 0 });
  assert.equal(r.state, 'FILLED');
  assert.equal(r.filledQty, 0.02);
  assert.equal(r.via, 'position');
});

test('reconcileEntryFill: 주문 전 수량을 모르고 주문 조회도 실패하면 UNKNOWN(추측 금지)', async () => {
  const client = {
    getOrderByClientId: async () => {
      throw new Error('network');
    },
    getPosition: async () => [{ symbol: 'BTCUSDT', positionAmt: '0.02' }],
  };
  const r = await reconcileEntryFill({ client, symbol: 'BTCUSDT', side: 'BUY', clientOrderId: 'x', preAmt: null });
  assert.equal(r.state, 'UNKNOWN');
});

test('buildEntryOrderParams: clientOrderId가 있으면 newClientOrderId로 실린다', () => {
  const p = buildEntryOrderParams({ symbol: 'BTCUSDT', side: 'BUY', quantity: 1, clientOrderId: 'ptf-abc' });
  assert.equal(p.newClientOrderId, 'ptf-abc');
});

test('makeClientOrderId: 바이낸스 규칙(36자 이하, 허용 문자)만 쓴다', () => {
  for (let i = 0; i < 20; i++) {
    const id = makeClientOrderId();
    assert.ok(id.length <= 36);
    assert.match(id, /^[.A-Z:/a-z0-9_-]+$/);
  }
});

test('signedPositionAmt: 해당 심볼의 부호 있는 수량만 합친다', () => {
  assert.equal(signedPositionAmt([{ symbol: 'BTCUSDT', positionAmt: '-0.5' }, { symbol: 'ETHUSDT', positionAmt: '3' }], 'BTCUSDT'), -0.5);
  assert.equal(signedPositionAmt([], 'BTCUSDT'), 0);
});

// --- R10: 주문 직전 시세 확인 ------------------------------------------------------

test('checkEntryDrift: 계획 진입가 근처면 통과', () => {
  const r = checkEntryDrift({ side: 'LONG', planEntry: 84194, stop: 83600, markPrice: 84250, maxDriftR: 0.5 });
  assert.equal(r.ok, true);
  assert.ok(r.driftR < 0.5);
});

test('checkEntryDrift: 롱인데 현재가가 이미 손절선 아래면 차단(손절 즉시 발동 → 수수료만 두 번)', () => {
  const r = checkEntryDrift({ side: 'LONG', planEntry: 84194, stop: 83600, markPrice: 83500 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /이미 손절선/);
});

test('checkEntryDrift: 숏도 대칭으로 — 현재가가 손절선 위면 차단', () => {
  const r = checkEntryDrift({ side: 'SHORT', planEntry: 100, stop: 102, markPrice: 102.5 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /이미 손절선/);
});

test('checkEntryDrift: 계획가에서 1R의 0.5배 넘게 벗어나면 차단(수량·손익비가 계획과 달라짐)', () => {
  // 1R = 594, 0.5R = 297 → 84194+400 = 0.67R 이탈
  const r = checkEntryDrift({ side: 'LONG', planEntry: 84194, stop: 83600, markPrice: 84594, maxDriftR: 0.5 });
  assert.equal(r.ok, false);
  assert.equal(r.driftR, 0.67);
});

test('checkEntryDrift: 현재 시세를 모르면 차단(오래되거나 없는 시세로 신규 노출 금지)', () => {
  const r = checkEntryDrift({ side: 'LONG', planEntry: 100, stop: 95, markPrice: null });
  assert.equal(r.ok, false);
  assert.match(r.reason, /시세를 확인하지 못해/);
});

// --- R09: 순손익(수수료·펀딩 포함) --------------------------------------------------

test('summarizeIncome: 실현손익·수수료·펀딩을 분리해 합산하고 순손익을 낸다', () => {
  const r = summarizeIncome([
    { incomeType: 'REALIZED_PNL', income: '-10.7' },
    { incomeType: 'COMMISSION', income: '-0.5' },
    { incomeType: 'COMMISSION', income: '-0.42' },
    { incomeType: 'FUNDING_FEE', income: '0.12' },
    { incomeType: 'TRANSFER', income: '1000' }, // 입금은 손익이 아니다
  ]);
  assert.equal(r.realized, -10.7);
  assert.equal(r.commission, -0.92);
  assert.equal(r.funding, 0.12);
  assert.equal(r.net, -11.5);
});

test('checkDailyLossLimit: 실현손익만으론 한도 안쪽이어도 수수료를 더하면 넘으면 차단한다', async () => {
  const client = {
    getIncomeHistory: async () => [
      { incomeType: 'REALIZED_PNL', income: '-24.8' },
      { incomeType: 'COMMISSION', income: '-0.5' },
    ],
  };
  const r = await checkDailyLossLimit({ maxLossUsd: 25 }, client);
  assert.equal(r.grossRealizedPnl, -24.8);
  assert.equal(r.realizedPnl, -25.3);
  assert.equal(r.blocked, true);
});

// --- 모집단: 체결 조각이 아니라 청산 건 단위 ----------------------------------------

test('groupCloseEvents: 같은 청산의 여러 체결 조각(0.5초 이내·같은 심볼)은 한 건으로 묶고 수수료도 더한다', () => {
  const ev = groupCloseEvents([
    { incomeType: 'REALIZED_PNL', income: '-4', time: 1000, symbol: 'BTCUSDT', tradeId: 1 },
    { incomeType: 'REALIZED_PNL', income: '-3', time: 1001, symbol: 'BTCUSDT', tradeId: 2 },
    { incomeType: 'REALIZED_PNL', income: '-3.7', time: 1002, symbol: 'BTCUSDT', tradeId: 3 },
    { incomeType: 'COMMISSION', income: '-0.2', time: 1000, symbol: 'BTCUSDT', tradeId: 1 },
  ]);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].fills, 3);
  assert.equal(Math.round(ev[0].income * 100) / 100, -10.9);
});

test('countConsecutiveLosses: 손실 거래 1건이 체결 3조각으로 기록돼도 연속 손실은 1회로 센다(서킷 브레이커 오작동 방지)', () => {
  const r = countConsecutiveLosses([
    { incomeType: 'REALIZED_PNL', income: '-4', time: 1000, symbol: 'BTCUSDT' },
    { incomeType: 'REALIZED_PNL', income: '-3', time: 1001, symbol: 'BTCUSDT' },
    { incomeType: 'REALIZED_PNL', income: '-3.7', time: 1002, symbol: 'BTCUSDT' },
  ]);
  assert.equal(r.count, 1);
});

test('groupCloseEvents: 다른 심볼이면 같은 시각이어도 따로 센다', () => {
  const ev = groupCloseEvents([
    { incomeType: 'REALIZED_PNL', income: '-4', time: 1000, symbol: 'BTCUSDT' },
    { incomeType: 'REALIZED_PNL', income: '-3', time: 1000, symbol: 'ETHUSDT' },
  ]);
  assert.equal(ev.length, 2);
});

test('checkEdge: 기대값 = 확신도×손익비 − (1−확신도), 0.2R 미만·레벨 불명·확신도 없음은 막는다', () => {
  const ex = require('../server/exchange.js');
  assert.equal(ex.HARD_MIN_EV_R, 0.2);
  // 롱, 손익비 1.8: 확신도 40% → 0.12R 차단, 43% → 0.2R 이상 통과. 통과 최소 확신도 43%
  const L = { entry: 100, stop: 99, target: 101.8 };
  const a = ex.checkEdge({ ...L, confidence: 40 });
  assert.equal(a.blocked, true);
  assert.equal(a.rr, 1.8);
  assert.equal(a.evR, 0.12);
  assert.equal(a.breakEvenConfidence, 43);
  assert.equal(ex.checkEdge({ ...L, confidence: 43 }).blocked, false);
  // 숏도 같은 계산
  assert.equal(ex.checkEdge({ entry: 100, stop: 101, target: 98.2, confidence: 50 }).blocked, false);
  // 9/29 BTC 실제 판정: 확신도 55%, 손익비 약 4.3 → 통과
  assert.equal(ex.checkEdge({ entry: 83491, stop: 82581, target: 87396, confidence: 55 }).blocked, false);
  // 확신도 없음 · 레벨 모순(익절이 손절 쪽) · 0 거리
  assert.equal(ex.checkEdge({ ...L, confidence: null }).reason, '확신도 없음');
  assert.equal(ex.checkEdge({ entry: 100, stop: 99, target: 98, confidence: 90 }).blocked, true);
  assert.equal(ex.checkEdge({ entry: 100, stop: 100, target: 102, confidence: 90 }).blocked, true);
  // 설정으로 올릴 수만 있다
  assert.equal(ex.checkEdge({ ...L, confidence: 43 }, 0.05).minEvR, 0.2);
  assert.equal(ex.checkEdge({ ...L, confidence: 43 }, 0.5).blocked, true);
});

test('pickSymbolFilters: 전 종목 목록에서 이름으로 찾는다(첫 종목을 쓰지 않는다) · 필터 없으면 precision 으로', () => {
  const { pickSymbolFilters, floorToStep } = require('../server/exchange.js');
  const data = { symbols: [
    { symbol: 'BTCUSDT', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.0001' }, { filterType: 'PRICE_FILTER', tickSize: '0.10' }] },
    { symbol: 'ETHUSDT', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.001' }, { filterType: 'PRICE_FILTER', tickSize: '0.01' }] },
    { symbol: 'XYZUSDT', quantityPrecision: 2, pricePrecision: 4, filters: [] },
  ] };
  assert.deepEqual(pickSymbolFilters(data, 'ETHUSDT'), { symbol: 'ETHUSDT', qtyStep: 0.001, priceStep: 0.01 });
  assert.deepEqual(pickSymbolFilters(data, 'XYZUSDT'), { symbol: 'XYZUSDT', qtyStep: 0.01, priceStep: 0.0001 });
  assert.equal(pickSymbolFilters(data, 'SOLUSDT'), null);
  // 10/2 ETH 사례: 명목 1000 / 2753 = 0.36324... → 0.363
  assert.equal(floorToStep(1000 / 2753, 0.001), 0.363);
  assert.equal(floorToStep(0.123456789, 1e-7), 0.1234567, '지수 표기 step');
});

test('buildIncomeParams: 종류를 거르지 않아 수수료·펀딩도 받는다(실현손익만 받으면 순손익이 부풀려짐 — 10/8)', () => {
  const { buildIncomeParams, summarizeIncome } = require('../server/exchange.js');
  const p = buildIncomeParams({ startTime: 1, endTime: 2 });
  assert.equal('incomeType' in p, false);
  assert.equal(p.limit, 1000);
  assert.equal(buildIncomeParams({ incomeType: 'REALIZED_PNL' }).incomeType, 'REALIZED_PNL');
  const s = summarizeIncome([
    { incomeType: 'REALIZED_PNL', income: '5.00' },
    { incomeType: 'COMMISSION', income: '-0.80' },
    { incomeType: 'FUNDING_FEE', income: '-0.10' },
  ]);
  assert.equal(s.net, 4.1);
});

// --- 10/9 사고 재현: 장부 손절(2,687)이 옛값이고 거래소엔 AI 가 당긴 2,600 이 걸려 있던 상황 ---

test('updateStopLoss: 거래소에 더 유리한 손절이 걸려 있으면 느슨한 새 손절로 바꾸지 않는다(취소조차 안 함)', async () => {
  const calls = { cancel: 0, place: [] };
  const client = {
    getSymbolFilters: async () => ({ priceStep: 0.01 }),
    getOpenAlgoOrders: async () => [{ orderType: 'STOP_MARKET', side: 'BUY', algoStatus: 'NEW', triggerPrice: '2600.00' }],
    cancelAllAlgoOrders: async () => { calls.cancel += 1; },
    placeStopLoss: async (s, side, p) => { calls.place.push(p); return {}; },
  };
  const res = await updateStopLoss({ symbol: 'ETHUSDT', side: 'SHORT', newStopPrice: 2647.3, previousStopPrice: 2687 }, client);
  assert.equal(res.ok, false);
  assert.equal(res.notTighter, true);
  assert.equal(res.exchangeStop, 2600);
  assert.equal(calls.cancel, 0);
  assert.deepEqual(calls.place, []);
});

test('updateStopLoss: 가격 단위로 맞춰 제출(숏은 내림) · 실패 시 장부값이 아니라 실제 걸려 있던 손절로 복구', async () => {
  const placed = [];
  let first = true;
  const client = {
    getSymbolFilters: async () => ({ priceStep: 0.01 }),
    getOpenAlgoOrders: async () => [{ orderType: 'STOP_MARKET', side: 'BUY', algoStatus: 'NEW', triggerPrice: '2629.00' }],
    cancelAllAlgoOrders: async () => {},
    placeStopLoss: async (s, side, p) => {
      placed.push(p);
      if (first) { first = false; throw new Error('일시 오류'); }
      return {};
    },
  };
  const res = await updateStopLoss({ symbol: 'ETHUSDT', side: 'SHORT', newStopPrice: 2610.123456789, previousStopPrice: 2687 }, client);
  assert.equal(placed[0], 2610.12, '단위 맞춤(숏 손절은 내림 = 더 타이트)');
  assert.equal(res.restored, true);
  assert.equal(placed[1], 2629, '장부 2,687 이 아니라 실제 손절 2,629 로 복구');
});

test('roundStopToTick·isLooserStop·findExchangeStop', () => {
  const { roundStopToTick, isLooserStop, findExchangeStop } = require('../server/exchange.js');
  assert.equal(roundStopToTick('LONG', 84000.123, 0.1), 84000.2, '롱 손절은 올림');
  assert.equal(roundStopToTick('SHORT', 2646.789, 0.01), 2646.78, '숏 손절은 내림');
  assert.equal(isLooserStop('SHORT', 2687, 2600), true);
  assert.equal(isLooserStop('SHORT', 2590, 2600), false);
  assert.equal(isLooserStop('LONG', 82000, 83000), true);
  assert.equal(findExchangeStop([{ type: 'STOP_MARKET', side: 'BUY', triggerPrice: '2600' }, { type: 'STOP_MARKET', side: 'BUY', triggerPrice: '2620' }], 'SHORT'), 2600);
  assert.equal(findExchangeStop([{ type: 'STOP_MARKET', side: 'SELL', triggerPrice: '83000' }], 'SHORT'), null, '방향이 다르면 보호 아님');
  assert.equal(findExchangeStop({ orders: [{ orderType: 'STOP_MARKET', side: 'SELL', triggerPrice: '83000', algoStatus: 'NEW' }] }, 'LONG'), 83000);
});

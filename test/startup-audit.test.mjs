import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasStopOrder, findLedgerMatch, auditAndFixUnprotectedPositions } = require('../server/startup-audit.js');

// --- hasStopOrder (순수 함수) ----------------------------------------------------

test('hasStopOrder: STOP_MARKET 주문이 있으면 true', () => {
  assert.equal(hasStopOrder([{ type: 'STOP_MARKET' }]), true);
});

test('hasStopOrder: STOP류가 아닌 주문만 있으면 false', () => {
  assert.equal(hasStopOrder([{ type: 'TAKE_PROFIT_MARKET' }]), false);
});

test('hasStopOrder: 빈 배열/null/undefined는 false', () => {
  assert.equal(hasStopOrder([]), false);
  assert.equal(hasStopOrder(null), false);
  assert.equal(hasStopOrder(undefined), false);
});

test('hasStopOrder: 대소문자 무관하게 판단한다', () => {
  assert.equal(hasStopOrder([{ type: 'stop_market' }]), true);
});

// --- findLedgerMatch (순수 함수) --------------------------------------------------

test('findLedgerMatch: execSymbol이 명시돼 있으면 그걸로 매칭한다', () => {
  const open = [{ symbol: 'SKHYNIX', execSymbol: 'SKHYUSDT', stop: 1200 }];
  const r = findLedgerMatch(open, 'SKHYUSDT', (s) => `${s}USDT`);
  assert.equal(r.stop, 1200);
});

test('findLedgerMatch: execSymbol이 없으면 toBinanceFuturesSymbol로 변환해 매칭한다', () => {
  const open = [{ symbol: 'BTC', stop: 78000 }]; // execSymbol 없음(크립토)
  const r = findLedgerMatch(open, 'BTCUSDT', (s) => `${s}USDT`);
  assert.equal(r.stop, 78000);
});

test('findLedgerMatch: 매칭 안 되면 null', () => {
  const open = [{ symbol: 'BTC', stop: 78000 }];
  const r = findLedgerMatch(open, 'AAPLUSDT', (s) => `${s}USDT`);
  assert.equal(r, null);
});

test('findLedgerMatch: 여러 건이면 가장 최근 오픈 기록을 쓴다', () => {
  const open = [
    { symbol: 'BTC', stop: 78000, openedAt: '2026-09-01T00:00:00Z' },
    { symbol: 'BTC', stop: 80000, openedAt: '2026-09-19T00:00:00Z' },
  ];
  const r = findLedgerMatch(open, 'BTCUSDT', (s) => `${s}USDT`);
  assert.equal(r.stop, 80000);
});

test('findLedgerMatch: 빈 배열/잘못된 입력은 null', () => {
  assert.equal(findLedgerMatch([], 'BTCUSDT', (s) => `${s}USDT`), null);
  assert.equal(findLedgerMatch(null, 'BTCUSDT', (s) => `${s}USDT`), null);
});

// --- auditAndFixUnprotectedPositions (오케스트레이션, 가짜 모듈) ----------------------

function makeAuditDeps({
  positions = [],
  algoOrdersBySymbol = {},
  ledgerOpen = [],
  updateResult = { ok: true },
  closeResult = { ok: true },
} = {}) {
  const calls = { update: [], close: [], notify: [], ledgerClose: [] };
  const exchangeMod = {
    createClient: () => ({
      getPosition: async () => ({}),
      getOpenAlgoOrders: async (symbol) => algoOrdersBySymbol[symbol] || [],
    }),
    summarizeAllOpenPositions: () => positions,
    toBinanceFuturesSymbol: (s) => `${s}USDT`,
    updateStopLoss: async (args) => {
      calls.update.push(args);
      return updateResult;
    },
    closeExistingPosition: async (args) => {
      calls.close.push(args);
      return closeResult;
    },
  };
  const positionsMod = {
    listPositions: () => ({ open: ledgerOpen }),
    closePosition: (id, opts) => {
      calls.ledgerClose.push({ id, opts });
      return { id, status: 'closed' };
    },
  };
  const notifyMod = {
    sendExecutionEvent: async (payload) => {
      calls.notify.push(payload);
      return { ok: true };
    },
  };
  return { exchangeMod, positionsMod, notifyMod, calls };
}

test('auditAndFixUnprotectedPositions: 환경변수가 없으면 아무것도 안 하고 빈 리포트', async () => {
  const prevKey = process.env.BINANCE_API_KEY;
  delete process.env.BINANCE_API_KEY;
  try {
    const { exchangeMod, positionsMod, notifyMod } = makeAuditDeps({ positions: [{ symbol: 'BTCUSDT' }] });
    const report = await auditAndFixUnprotectedPositions({ exchangeMod, positionsMod, notifyMod, cfg: {} });
    assert.equal(report.checked, 0);
  } finally {
    if (prevKey !== undefined) process.env.BINANCE_API_KEY = prevKey;
  }
});

test('auditAndFixUnprotectedPositions: 열려있는 포지션이 없으면 checked:0, 알림 없음', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { exchangeMod, positionsMod, notifyMod, calls } = makeAuditDeps({ positions: [] });
  const report = await auditAndFixUnprotectedPositions({ exchangeMod, positionsMod, notifyMod, cfg: {} });
  assert.equal(report.checked, 0);
  assert.equal(calls.notify.length, 0);
});

test('auditAndFixUnprotectedPositions: 손절이 정상적으로 걸려있으면 아무 조치도 안 하고, 알림도 안 보낸다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { exchangeMod, positionsMod, notifyMod, calls } = makeAuditDeps({
    positions: [{ symbol: 'BTCUSDT', side: 'LONG', quantity: 1, markPrice: 80000 }],
    algoOrdersBySymbol: { BTCUSDT: [{ type: 'STOP_MARKET' }] },
  });
  const report = await auditAndFixUnprotectedPositions({ exchangeMod, positionsMod, notifyMod, cfg: {} });
  assert.equal(report.unprotected.length, 0);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.close.length, 0);
  assert.equal(calls.notify.length, 0);
});

test('auditAndFixUnprotectedPositions: 무보호 + 로컬 장부에 원래 손절가 있음 → 자동으로 복원한다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { exchangeMod, positionsMod, notifyMod, calls } = makeAuditDeps({
    positions: [{ symbol: 'BTCUSDT', side: 'LONG', quantity: 1, markPrice: 80000 }],
    algoOrdersBySymbol: { BTCUSDT: [] }, // 손절 없음
    ledgerOpen: [{ id: 'pos-1', symbol: 'BTC', stop: 78000, openedAt: '2026-09-19T00:00:00Z' }],
  });
  const report = await auditAndFixUnprotectedPositions({ exchangeMod, positionsMod, notifyMod, cfg: {} });
  assert.equal(report.unprotected.length, 1);
  assert.equal(report.fixed.length, 1);
  assert.equal(report.fixed[0].stop, 78000);
  assert.equal(calls.update[0].newStopPrice, 78000);
  assert.equal(calls.close.length, 0); // 청산까지는 안 감
  assert.equal(calls.notify.length, 1);
});

test('auditAndFixUnprotectedPositions: 무보호 + 원래 손절가를 모름(장부 매칭 없음) → 안전하게 청산한다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { exchangeMod, positionsMod, notifyMod, calls } = makeAuditDeps({
    positions: [{ symbol: 'BTCUSDT', side: 'LONG', quantity: 1, markPrice: 80000 }],
    algoOrdersBySymbol: { BTCUSDT: [] },
    ledgerOpen: [], // 매칭 없음
  });
  const report = await auditAndFixUnprotectedPositions({ exchangeMod, positionsMod, notifyMod, cfg: {} });
  assert.equal(report.flattened.length, 1);
  assert.equal(calls.close.length, 1);
  assert.equal(calls.update.length, 0);
});

test('auditAndFixUnprotectedPositions: 원래 손절가 복원 시도가 실패하면 청산으로 넘어간다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { exchangeMod, positionsMod, notifyMod, calls } = makeAuditDeps({
    positions: [{ symbol: 'BTCUSDT', side: 'LONG', quantity: 1, markPrice: 80000 }],
    algoOrdersBySymbol: { BTCUSDT: [] },
    ledgerOpen: [{ id: 'pos-1', symbol: 'BTC', stop: 78000, openedAt: '2026-09-19T00:00:00Z' }],
    updateResult: { ok: false, error: '재발주 거부' },
  });
  const report = await auditAndFixUnprotectedPositions({ exchangeMod, positionsMod, notifyMod, cfg: {} });
  assert.equal(report.fixed.length, 0);
  assert.equal(report.flattened.length, 1); // 복원 실패 → 청산으로 대체
});

test('auditAndFixUnprotectedPositions: 청산까지 실패하면 failed에 기록되고(사람이 봐야 함), 로컬 장부는 안 건드린다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { exchangeMod, positionsMod, notifyMod, calls } = makeAuditDeps({
    positions: [{ symbol: 'BTCUSDT', side: 'LONG', quantity: 1, markPrice: 80000 }],
    algoOrdersBySymbol: { BTCUSDT: [] },
    ledgerOpen: [],
    closeResult: { ok: false, error: '청산 거부' },
  });
  const report = await auditAndFixUnprotectedPositions({ exchangeMod, positionsMod, notifyMod, cfg: {} });
  assert.equal(report.failed.length, 1);
  assert.equal(report.failed[0].symbol, 'BTCUSDT');
  assert.equal(calls.ledgerClose.length, 0);
});

test('auditAndFixUnprotectedPositions: 청산 성공 시 로컬 장부도 함께 닫는다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { exchangeMod, positionsMod, notifyMod, calls } = makeAuditDeps({
    positions: [{ symbol: 'BTCUSDT', side: 'LONG', quantity: 1, markPrice: 80000 }],
    algoOrdersBySymbol: { BTCUSDT: [] },
    ledgerOpen: [{ id: 'pos-1', symbol: 'BTC', openedAt: '2026-09-19T00:00:00Z' }], // stop 없음 → 복원 불가 → 청산
  });
  await auditAndFixUnprotectedPositions({ exchangeMod, positionsMod, notifyMod, cfg: {} });
  assert.equal(calls.ledgerClose.length, 1);
  assert.equal(calls.ledgerClose[0].id, 'pos-1');
});

test('auditAndFixUnprotectedPositions: 여러 포지션 중 일부만 무보호면 그것만 조치한다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { exchangeMod, positionsMod, notifyMod, calls } = makeAuditDeps({
    positions: [
      { symbol: 'BTCUSDT', side: 'LONG', quantity: 1, markPrice: 80000 },
      { symbol: 'AAPLUSDT', side: 'LONG', quantity: 1, markPrice: 336 },
    ],
    algoOrdersBySymbol: {
      BTCUSDT: [{ type: 'STOP_MARKET' }], // 정상
      AAPLUSDT: [], // 무보호
    },
    ledgerOpen: [{ id: 'pos-2', symbol: 'AAPL', stop: 320, openedAt: '2026-09-19T00:00:00Z' }],
  });
  const report = await auditAndFixUnprotectedPositions({ exchangeMod, positionsMod, notifyMod, cfg: {} });
  assert.equal(report.checked, 2);
  assert.equal(report.unprotected.length, 1);
  assert.equal(report.unprotected[0], 'AAPLUSDT');
  assert.equal(calls.update.length, 1);
});

// --- 실제 거래소 응답 형식 회귀 방지 (2026-09-24 실전 오작동) ------------------------
// 아래는 테스트넷 GET /fapi/v1/openAlgoOrders의 실제 응답 한 건(비밀값 없음)이다.
const REAL_ALGO_ORDER = {
  algoId: 1000000216582401,
  clientAlgoId: 'HQ1QlFTVfgoAsxlRjsXFt2',
  algoType: 'CONDITIONAL',
  orderType: 'STOP_MARKET',
  symbol: 'BTCUSDT',
  side: 'SELL',
  positionSide: 'BOTH',
  quantity: '0.0',
  algoStatus: 'NEW',
  triggerPrice: '83600.0',
  closePosition: true,
  reduceOnly: true,
};

test('hasStopOrder: 실제 응답 형식(orderType 필드)의 손절을 정확히 인식한다', () => {
  assert.equal(hasStopOrder([REAL_ALGO_ORDER]), true);
  assert.equal(hasStopOrder([REAL_ALGO_ORDER], 'LONG'), true);
});

test('hasStopOrder: 롱 포지션인데 손절 방향이 BUY면 보호로 보지 않는다', () => {
  assert.equal(hasStopOrder([{ ...REAL_ALGO_ORDER, side: 'BUY' }], 'LONG'), false);
  assert.equal(hasStopOrder([{ ...REAL_ALGO_ORDER, side: 'BUY' }], 'SHORT'), true);
});

test('hasStopOrder: 취소·만료된 손절은 보호로 보지 않는다', () => {
  assert.equal(hasStopOrder([{ ...REAL_ALGO_ORDER, algoStatus: 'CANCELED' }]), false);
});

test('auditAndFixUnprotectedPositions: 실제 응답 형식의 손절이 걸려 있으면 취소·재발주하지 않는다(오작동 회귀 방지)', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { exchangeMod, positionsMod, notifyMod, calls } = makeAuditDeps({
    positions: [{ symbol: 'BTCUSDT', side: 'LONG', quantity: 0.0118, markPrice: 84515.6 }],
    algoOrdersBySymbol: { BTCUSDT: [REAL_ALGO_ORDER] },
    ledgerOpen: [], // 장부에 손절가가 없어도 — 예전엔 이 경우 보호된 포지션을 청산했을 것이다
  });
  const report = await auditAndFixUnprotectedPositions({ exchangeMod, positionsMod, notifyMod, cfg: {} });
  assert.equal(report.unprotected.length, 0);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.close.length, 0);
  assert.equal(calls.notify.length, 0);
});

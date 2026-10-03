import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { diffPositions, reconcilePositions } = require('../server/reconcile.js');

// --- diffPositions (순수 함수) -----------------------------------------------

test('diffPositions: 로컬·거래소가 완전히 일치하면 어긋남이 없다', () => {
  const ledger = [{ symbol: 'BTC', id: 'p1' }];
  const exchange = [{ symbol: 'BTCUSDT' }];
  const r = diffPositions(ledger, exchange, (s) => `${s}USDT`);
  assert.equal(r.staleInLedger.length, 0);
  assert.equal(r.orphanOnExchange.length, 0);
});

test('diffPositions: 로컬엔 열려있는데 거래소엔 없으면 stale로 잡힌다', () => {
  const ledger = [{ symbol: 'BTC', id: 'p1' }];
  const exchange = [];
  const r = diffPositions(ledger, exchange, (s) => `${s}USDT`);
  assert.equal(r.staleInLedger.length, 1);
  assert.equal(r.staleInLedger[0].symbol, 'BTC');
});

test('diffPositions: 거래소엔 있는데 로컬 기록이 없으면 orphan으로 잡힌다', () => {
  const ledger = [];
  const exchange = [{ symbol: 'AAPLUSDT' }];
  const r = diffPositions(ledger, exchange, (s) => `${s}USDT`);
  assert.equal(r.orphanOnExchange.length, 1);
  assert.equal(r.orphanOnExchange[0].symbol, 'AAPLUSDT');
});

test('diffPositions: execSymbol이 명시돼 있으면 그걸 우선해서 매칭한다', () => {
  const ledger = [{ symbol: 'SKHYNIX', execSymbol: 'SKHYUSDT', id: 'p1' }];
  const exchange = [{ symbol: 'SKHYUSDT' }];
  const r = diffPositions(ledger, exchange, (s) => `${s}USDT`); // 일반 변환이면 SKHYNIXUSDT라 매칭 실패했을 것
  assert.equal(r.staleInLedger.length, 0);
  assert.equal(r.orphanOnExchange.length, 0);
});

test('diffPositions: 여러 종목이 섞여도 각각 정확히 분류된다', () => {
  const ledger = [
    { symbol: 'BTC', id: 'p1' }, // 거래소에도 있음 — 정상
    { symbol: 'NVDA', id: 'p2' }, // 거래소엔 없음 — stale
  ];
  const exchange = [
    { symbol: 'BTCUSDT' },
    { symbol: 'AAPLUSDT' }, // 로컬엔 없음 — orphan
  ];
  const r = diffPositions(ledger, exchange, (s) => `${s}USDT`);
  assert.equal(r.staleInLedger.length, 1);
  assert.equal(r.staleInLedger[0].symbol, 'NVDA');
  assert.equal(r.orphanOnExchange.length, 1);
  assert.equal(r.orphanOnExchange[0].symbol, 'AAPLUSDT');
});

test('diffPositions: 빈 배열/잘못된 입력도 에러 없이 빈 결과를 준다', () => {
  const r1 = diffPositions([], [], (s) => `${s}USDT`);
  assert.equal(r1.staleInLedger.length, 0);
  assert.equal(r1.orphanOnExchange.length, 0);
  const r2 = diffPositions(null, null, (s) => `${s}USDT`);
  assert.equal(r2.staleInLedger.length, 0);
  assert.equal(r2.orphanOnExchange.length, 0);
});

// --- reconcilePositions (오케스트레이션, 가짜 모듈) -------------------------------

function makeReconcileDeps({ ledgerOpen = [], exchangePositions = [] } = {}) {
  const calls = { close: [], notify: [] };
  const exchangeMod = {
    createClient: () => ({ getPosition: async () => ({}) }),
    summarizeAllOpenPositions: () => exchangePositions,
    toBinanceFuturesSymbol: (s) => `${s}USDT`,
  };
  const positionsMod = {
    listPositions: () => ({ open: ledgerOpen }),
    closePosition: (id, opts) => {
      calls.close.push({ id, opts });
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

test('reconcilePositions: 환경변수가 없으면 아무것도 안 함', async () => {
  const prevKey = process.env.BINANCE_API_KEY;
  delete process.env.BINANCE_API_KEY;
  try {
    const { exchangeMod, positionsMod, notifyMod, calls } = makeReconcileDeps({ ledgerOpen: [{ symbol: 'BTC', id: 'p1' }] });
    const report = await reconcilePositions({ exchangeMod, positionsMod, notifyMod, cfg: {} });
    assert.equal(report.staleClosedCount, 0);
    assert.equal(calls.notify.length, 0);
  } finally {
    if (prevKey !== undefined) process.env.BINANCE_API_KEY = prevKey;
  }
});

test('reconcilePositions: 일치하면 아무 조치도 알림도 없다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { exchangeMod, positionsMod, notifyMod, calls } = makeReconcileDeps({
    ledgerOpen: [{ symbol: 'BTC', id: 'p1' }],
    exchangePositions: [{ symbol: 'BTCUSDT' }],
  });
  const report = await reconcilePositions({ exchangeMod, positionsMod, notifyMod, cfg: {} });
  assert.equal(report.staleClosedCount, 0);
  assert.equal(report.orphanCount, 0);
  assert.equal(calls.close.length, 0);
  assert.equal(calls.notify.length, 0);
});

test('reconcilePositions: stale 기록은 자동으로 로컬 장부에서 닫는다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { exchangeMod, positionsMod, notifyMod, calls } = makeReconcileDeps({
    ledgerOpen: [{ symbol: 'BTC', id: 'p1' }],
    exchangePositions: [], // 거래소엔 없음
  });
  const report = await reconcilePositions({ exchangeMod, positionsMod, notifyMod, cfg: {} });
  assert.equal(report.staleClosedCount, 1);
  assert.equal(calls.close.length, 1);
  assert.equal(calls.close[0].id, 'p1');
  assert.equal(calls.notify.length, 1);
  assert.equal(calls.notify[0].reconcile.staleClosedCount, 1);
});

test('reconcilePositions: orphan은 자동 조치 없이 보고만 한다(로컬 장부·거래소 둘 다 안 건드림)', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { exchangeMod, positionsMod, notifyMod, calls } = makeReconcileDeps({
    ledgerOpen: [],
    exchangePositions: [{ symbol: 'AAPLUSDT' }],
  });
  const report = await reconcilePositions({ exchangeMod, positionsMod, notifyMod, cfg: {} });
  assert.equal(report.orphanCount, 1);
  assert.deepEqual(report.orphanSymbols, ['AAPLUSDT']);
  assert.equal(calls.close.length, 0); // 자동 조치 없음
  assert.equal(calls.notify.length, 1); // 보고는 감
});

test('reconcilePositions: stale 기록에 id가 없으면(비정상 데이터) 안전하게 건너뛴다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { exchangeMod, positionsMod, notifyMod, calls } = makeReconcileDeps({
    ledgerOpen: [{ symbol: 'BTC' }], // id 없음
    exchangePositions: [],
  });
  await assert.doesNotReject(reconcilePositions({ exchangeMod, positionsMod, notifyMod, cfg: {} }));
  assert.equal(calls.close.length, 0);
});

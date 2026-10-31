import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isExecutionSymbolAllowed } = require('../server/exchange.js');
const { applyWatchlist } = require('../server/set-watchlist.js');
const { isTestRow } = require('../server/cleanup-test-triggers.js');
const { DEFAULTS } = require('../server/config.js');

test('isExecutionSymbolAllowed: BTC·ETH만 허용, 나머지는 차단', () => {
  const allowed = ['BTCUSDT', 'ETHUSDT'];
  assert.equal(isExecutionSymbolAllowed('BTCUSDT', allowed), true);
  assert.equal(isExecutionSymbolAllowed('ETHUSDT', allowed), true);
  assert.equal(isExecutionSymbolAllowed('SKHYUSDT', allowed), false);
  assert.equal(isExecutionSymbolAllowed('SOLUSDT', allowed), false);
});

test('isExecutionSymbolAllowed: 허용 목록이 없거나 비어도 기본값(BTC·ETH)으로 막는다(열리지 않는 쪽)', () => {
  assert.equal(isExecutionSymbolAllowed('SOLUSDT', undefined), false);
  assert.equal(isExecutionSymbolAllowed('SOLUSDT', []), false);
  assert.equal(isExecutionSymbolAllowed('BTCUSDT', undefined), true);
  assert.equal(isExecutionSymbolAllowed(null, undefined), false);
});

test('config 기본값: 감시는 BTC·ETH, 실거래 허용도 BTCUSDT·ETHUSDT', () => {
  assert.deepEqual(DEFAULTS.watchlist, ['BTC', 'ETH']);
  assert.deepEqual(DEFAULTS.execution.allowedSymbols, ['BTCUSDT', 'ETHUSDT']);
});

test('applyWatchlist: 감시 종목과 허용 심볼을 바꾸고 다른 설정은 보존한다', () => {
  const cfg = { watchlist: ['AAPL', 'BTC'], telegram: { chatId: '1' }, execution: { enabled: true, riskPct: 0.5 } };
  const next = applyWatchlist(cfg, ['btc', 'ETH']);
  assert.deepEqual(next.watchlist, ['BTC', 'ETH']);
  assert.deepEqual(next.execution.allowedSymbols, ['BTCUSDT', 'ETHUSDT']);
  assert.equal(next.execution.riskPct, 0.5);
  assert.equal(next.telegram.chatId, '1');
  assert.deepEqual(cfg.watchlist, ['AAPL', 'BTC']); // 원본은 건드리지 않는다
});

test('isTestRow: 종류(kind)가 빈 트리거 행만 테스트 흔적으로 본다', () => {
  assert.equal(isTestRow({ symbol: 'BTC', kind: null }), true);
  assert.equal(isTestRow({ symbol: 'BTC' }), true);
  assert.equal(isTestRow({ symbol: 'BTC', kind: 'move' }), false);
});

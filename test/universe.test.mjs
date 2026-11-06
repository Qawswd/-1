import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const uni = require('../server/universe.js');

test('isInUniverse: BTC·ETH는 여러 표기 모두 허용', () => {
  for (const s of ['BTC', 'btc', 'BTCUSDT', 'BTC-USDT', ' eth ', 'ETHUSDT', '비트코인', '이더리움']) {
    assert.equal(uni.isInUniverse(s), true, s);
  }
});

test('isInUniverse: 그 외 종목은 전부 거부', () => {
  for (const s of ['SKHYNIX', 'SAMSUNG', 'AAPL', 'QQQ', 'SOL', 'SOLUSDT', '', null]) {
    assert.equal(uni.isInUniverse(s), false, String(s));
  }
});

test('filterToUniverse: 기존 10종목 워치리스트에서 BTC·ETH만 남긴다', () => {
  const old = ['SKHYNIX', 'QQQ', 'BTC', 'AAPL', 'MSFT', 'NVDA', 'META', 'JPM', 'WMT', 'V'];
  assert.deepEqual(uni.filterToUniverse(old), ['BTC']);
  assert.deepEqual(uni.filterToUniverse(['eth', 'BTCUSDT', 'btc']), ['ETH', 'BTC']);
});

test('filterToUniverse: 하나도 안 남으면 고정 종목 전체(BTC·ETH)', () => {
  assert.deepEqual(uni.filterToUniverse(['AAPL']), ['BTC', 'ETH']);
  assert.deepEqual(uni.filterToUniverse(undefined), ['BTC', 'ETH']);
});

test('FIXED_UNIVERSE는 코드에서 바꿀 수 없다(동결)', () => {
  assert.throws(() => {
    'use strict';
    uni.FIXED_UNIVERSE.push('SOL');
  });
});

test('loadConfig: config.json에 다른 종목이 남아 있어도 워치리스트는 BTC·ETH만', () => {
  const p = path.join(os.tmpdir(), `cfg-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify({ watchlist: ['SKHYNIX', 'QQQ', 'BTC', 'AAPL', 'ETH'] }), 'utf8');
  const prev = process.env.TRADING_FLOOR_CONFIG;
  process.env.TRADING_FLOOR_CONFIG = p;
  try {
    delete require.cache[require.resolve('../server/config.js')];
    const { loadConfig } = require('../server/config.js');
    assert.deepEqual(loadConfig().watchlist, ['BTC', 'ETH']);
  } finally {
    if (prev === undefined) delete process.env.TRADING_FLOOR_CONFIG;
    else process.env.TRADING_FLOOR_CONFIG = prev;
    fs.rmSync(p, { force: true });
  }
});

test('engine.run: BTC·ETH가 아니면 분석을 시작하지 않고 거부한다(다른 분석도 막지 않음)', async () => {
  const { Engine } = require('../server/engine.js');
  const e = new Engine();
  await assert.rejects(e.run('AAPL', { mock: true }), /BTC·ETH만 분석합니다/);
  assert.equal(e.running, false);
});

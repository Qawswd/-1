import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const U = require('../server/backtest/stock-universe.js');

test('씨앗 고정 난수 · 서로 다른 k 개 고르기 · 분위수', () => {
  const a = U.rng(1);
  const b = U.rng(1);
  assert.equal(a(), b(), '같은 씨앗이면 같은 수열');
  const pick = U.pickK(10, 3, U.rng(5));
  assert.equal(new Set(pick).size, 3);
  assert.ok(pick.every((i) => i >= 0 && i < 10));
  assert.equal(U.quant([5, 1, 3, null, 2, 4], 0.5), 3);
  assert.equal(U.quant([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1), 2);
  assert.equal(U.quant([], 0.5), null);
});

test('롱 보유 비용(연%)을 날마다 고르게 · 들고 있기 수익률은 첫날만 비용', () => {
  const D = 86400000;
  const bars = [{ t: 0, c: 100 }, { t: D, c: 110 }, { t: 2 * D, c: 99 }];
  const f = U.flatFunding(bars, 36.5);
  assert.ok(Math.abs(f.get(D) - 0.001) < 1e-12);
  assert.equal(U.flatFunding(bars, null).size, 0);
  const h = U.holdDays(bars, 0.001, f);
  assert.ok(Math.abs(h[0].ret - (0.1 - 0.001 - 0.001)) < 1e-12);
  assert.ok(Math.abs(h[1].ret - (-0.1 - 0.001)) < 1e-12);
});

test('종목 목록: meta.json 의 ok 만 · 2020 전부터 기록 있는 것만(짧은 것은 따로 센다)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'universe-'));
  try {
    fs.mkdirSync(path.join(dir, 'tradfi'));
    const csv = (from) => 't,o,h,l,c,v\n' + [0, 1, 2].map((k) => `${Date.parse(from) + k * 86400000},1,1,1,1,1`).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'tradfi', 'OLD-1d.csv'), csv('2016-01-04'));
    fs.writeFileSync(path.join(dir, 'tradfi', 'NEW-1d.csv'), csv('2023-01-03'));
    fs.writeFileSync(path.join(dir, 'tradfi', 'meta.json'), JSON.stringify({ symbols: [{ yahoo: 'OLD', ok: true, fundingAnnualPct: 5 }, { yahoo: 'NEW', ok: true }, { binance: 'XAU', ok: false }] }));
    const u = U.loadUniverse(dir);
    assert.deepEqual(u.stocks.map((s) => s.name), ['OLD']);
    assert.deepEqual(u.short, ['NEW']);
    assert.equal(U.loadUniverse(path.join(dir, 'none')).missing, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

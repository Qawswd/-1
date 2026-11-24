import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const f = require('../server/backtest/fetch-data.js');

test('BASE: 테스트넷이 아니라 실거래 시장 공개 데이터 주소를 쓴다', () => {
  assert.equal(f.BASE, 'https://fapi.binance.com');
  assert.ok(!f.BASE.includes('demo') && !f.BASE.includes('testnet'));
});

test('대상 종목은 BTC·ETH 두 개뿐이다', () => {
  assert.deepEqual(f.SYMBOLS, ['BTCUSDT', 'ETHUSDT']);
});

test('parseKlineRow: 바이낸스 배열 형식을 숫자 객체로 바꾼다', () => {
  const k = f.parseKlineRow([1700000000000, '100.5', '101', '99', '100.8', '12.3', 1700000899999, 'x']);
  assert.deepEqual(k, { t: 1700000000000, o: 100.5, h: 101, l: 99, c: 100.8, v: 12.3, ct: 1700000899999 });
});

test('parseKlineRow: 형식이 깨졌거나 숫자가 아니면 null(지어내지 않음)', () => {
  assert.equal(f.parseKlineRow([1, 'x', 1, 1, 1, 1, 2]), null);
  assert.equal(f.parseKlineRow([1, 2]), null);
  assert.equal(f.parseKlineRow(null), null);
});

test('checkContinuity: 빠진 구간·중복·역순을 정확히 찾는다', () => {
  const step = 900000;
  const c = [0, 1, 2, 5, 5, 4].map((i) => ({ t: i * step }));
  const r = f.checkContinuity(c, step);
  assert.equal(r.gaps.length, 1);
  assert.equal(r.gaps[0].missing, 2); // 3·4번 봉이 빠짐
  assert.equal(r.duplicates, 1);
  assert.equal(r.unsorted, 1);
});

test('checkContinuity: 연속된 봉이면 문제 없음', () => {
  const step = 900000;
  const r = f.checkContinuity([0, 1, 2, 3].map((i) => ({ t: i * step })), step);
  assert.equal(r.gaps.length + r.duplicates + r.unsorted, 0);
  assert.equal(r.rows, 4);
});

test('toCsv: 헤더와 행 형식', () => {
  assert.equal(f.toCsv([{ t: 1, o: 2, h: 3, l: 1, c: 2, v: 5 }]), 't,o,h,l,c,v\n1,2,3,1,2,5\n');
});

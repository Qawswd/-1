import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const V = require('../server/backtest/video-v1.js');

const BAR = 15 * 60 * 1000;
function mk(closes, start = 0) {
  return closes.map((c, i) => ({ t: start + i * BAR, o: c, h: c + 0.2, l: c - 0.2, c, v: 1 }));
}

test('emaSeries: 상수 입력이면 상수, 길이 유지', () => {
  const e = V.emaSeries([5, 5, 5, 5], 3);
  assert.equal(e.length, 4);
  assert.equal(e[3], 5);
});

test('rsiSeries: 계속 오르면 100, 계속 내리면 0, 앞 period 개는 null', () => {
  const up = V.rsiSeries(Array.from({ length: 20 }, (_, i) => 100 + i), 14);
  assert.equal(up[5], null);
  assert.equal(up[19], 100);
  const down = V.rsiSeries(Array.from({ length: 20 }, (_, i) => 100 - i), 14);
  assert.equal(down[19], 0);
});

test('signalAt: 상승 리본 + RSI 가 rsiLow 를 아래에서 위로 돌파할 때만 LONG, 하락 리본 + rsiHigh 하향 이탈이면 SHORT', () => {
  const p = { ...V.DEFAULTS };
  const closes = [1, 1, 1];
  const fast = [2, 2, 2];
  const slow = [1, 1, 1];
  assert.equal(V.signalAt(2, closes, fast, slow, [null, 30, 40], p), 'LONG');
  assert.equal(V.signalAt(2, closes, fast, slow, [null, 40, 45], p), null, '이미 위에 있었으면 신호 아님');
  assert.equal(V.signalAt(2, closes, [0, 0, 0], [1, 1, 1], [null, 70, 60], p), 'SHORT');
  assert.equal(V.signalAt(2, closes, [0, 0, 0], [1, 1, 1], [null, 70, 60], { ...p, longOnly: true }), null);
  assert.equal(V.signalAt(0, closes, fast, slow, [null, 30, 40], p), null);
});

test('simulatePct: 롱 목표 1.2% 먼저 → target, 손절 0.5%, 비용 0.14% 차감, R = pct/0.5', () => {
  const bars = mk([100, 100, 100, 100, 100, 100]);
  bars[3].h = 101.3;
  const tr = V.simulatePct(bars, 1, 'LONG', V.DEFAULTS);
  assert.equal(tr.reason, 'target');
  assert.ok(Math.abs(tr.pct - (1.2 - 0.14)) < 1e-6);
  assert.ok(Math.abs(tr.r - (1.2 - 0.14) / 0.5) < 1e-3);
  const bars2 = mk([100, 100, 100, 100]);
  bars2[3].l = 99.4;
  assert.equal(V.simulatePct(bars2, 1, 'LONG', V.DEFAULTS).reason, 'stop');
  assert.equal(V.simulatePct(bars2, 3, 'LONG', V.DEFAULTS), null);
});

test('runV1: 합성 데이터에서 신호·거래가 만들어지고 포지션 보유 중엔 새 신호를 무시한다', () => {
  // 60봉 상승(리본 상승) 후 RSI 가 눌렸다가 다시 오르는 구간을 만든다
  const closes = [];
  for (let i = 0; i < 80; i++) closes.push(100 + i * 0.3);
  for (let i = 0; i < 12; i++) closes.push(closes[closes.length - 1] - 0.9); // 눌림 → RSI 하락
  for (let i = 0; i < 40; i++) closes.push(closes[closes.length - 1] + 0.5); // 해소 → RSI 상향 돌파
  const bars = mk(closes);
  const r = V.runV1(bars, { maxHoldBars: 8 });
  assert.ok(r.signals >= 1, '눌림 해소에서 신호가 나야 한다');
  assert.ok(r.trades.length >= 1);
  for (let k = 1; k < r.trades.length; k++) assert.ok(r.trades[k].entryIdx > r.trades[k - 1].exitIdx, '겹치지 않는다');
});

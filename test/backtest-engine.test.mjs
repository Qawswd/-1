import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../server/backtest/engine.js');
const R = require('../server/backtest/run.js');

const M15 = 15 * 60 * 1000;
const T0 = Date.UTC(2024, 0, 1); // 2024-01-01 00:00 UTC

// 평탄한 봉 시퀀스 생성기 — 필요한 봉만 덮어써서 시나리오를 만든다
function flat(n, price = 100, start = T0) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ t: start + i * M15, o: price, h: price + 0.5, l: price - 0.5, c: price, v: 10 });
  return out;
}

test('parseCandleCsv: 헤더·깨진 줄 무시, 시간순 정렬, 중복 시각은 마지막 값', () => {
  const csv = 't,o,h,l,c,v\n2000,1,2,0.5,1.5,10\n1000,1,1,1,1,1\nbad,line\n2000,9,9,9,9,9\n';
  const bars = E.parseCandleCsv(csv);
  assert.equal(bars.length, 2);
  assert.equal(bars[0].t, 1000);
  assert.equal(bars[1].c, 9);
});

test('atrSeries: 최근 14개 True Range 평균, 앞부분은 null', () => {
  const bars = flat(30);
  const atr = E.atrSeries(bars, 14);
  assert.equal(atr[5], null);
  assert.ok(Math.abs(atr[20] - 1.0) < 1e-9, 'h-l=1 이므로 ATR=1');
});

test('moveTrigger: 직전 종가 대비 |변동| ≥ 임계일 때만, 방향 포함', () => {
  const bars = flat(3);
  bars[2].c = 102; // +2%
  assert.deepEqual(E.moveTrigger(bars, 2, 1.5), { direction: 'up', movePct: 2 });
  bars[2].c = 99; // -1%
  assert.equal(E.moveTrigger(bars, 2, 1.5), null);
  bars[2].c = 98; // -2%
  assert.equal(E.moveTrigger(bars, 2, 1.5).direction, 'down');
  assert.equal(E.moveTrigger(bars, 0, 1.5), null);
});

test('DailyAggregator: UTC 날짜별로 묶고 진행 중인 당일 봉을 갱신한다', () => {
  const agg = new E.DailyAggregator();
  const bars = flat(96 + 4); // 하루(96봉) + 다음날 4봉
  bars[3].h = 105;
  bars[97].l = 90;
  for (const b of bars) agg.push(b);
  assert.equal(agg.daily.length, 2);
  assert.equal(agg.daily[0].h, 105);
  assert.equal(agg.daily[1].l, 90);
  assert.equal(agg.daily[1].c, bars[99].c);
  const rec = agg.recent(1);
  rec[0].c = -1; // 사본이어야 원본이 안 바뀐다
  assert.notEqual(agg.daily[1].c, -1);
});

test('simulateTrade: 롱 — 목표 먼저 닿으면 target, 비용 차감, R 계산', () => {
  const bars = flat(10);
  // i=2 트리거, e=3 진입 시가 100, ATR 1 → 손절거리 1.5, 목표 +2.7
  bars[5].h = 103; // 목표 도달
  const tr = E.simulateTrade(bars, 2, 'LONG', 1, { ...E.DEFAULTS, feePct: 0.05, slipPct: 0.02 });
  assert.equal(tr.reason, 'target');
  assert.equal(tr.exitIdx, 5);
  assert.ok(Math.abs(tr.grossPct - 2.7) < 1e-6);
  assert.ok(Math.abs(tr.pct - (2.7 - 0.14)) < 1e-6);
  assert.ok(Math.abs(tr.r - (2.7 - 0.14) / 1.5) < 1e-3);
});

test('simulateTrade: 같은 봉에서 손절·목표 둘 다 닿으면 손절로 본다(보수적)', () => {
  const bars = flat(10);
  bars[4].h = 110;
  bars[4].l = 90;
  const tr = E.simulateTrade(bars, 2, 'LONG', 1, E.DEFAULTS);
  assert.equal(tr.reason, 'stop');
  assert.ok(tr.pct < 0);
});

test('simulateTrade: 숏 — 손절은 위, 목표는 아래. 시간 만료면 종가 청산', () => {
  const bars = flat(60);
  const tr = E.simulateTrade(bars, 2, 'SHORT', 1, { ...E.DEFAULTS, maxHoldBars: 5 });
  assert.equal(tr.reason, 'time');
  assert.equal(tr.exitIdx, 3 + 5);
  assert.ok(tr.stop > tr.entry && tr.target < tr.entry);
  assert.ok(tr.pct < 0, '가격 변화 0 이면 비용만큼 손실');
});

test('simulateTrade: ATR 없음(null)이나 데이터 끝이면 null', () => {
  const bars = flat(5);
  assert.equal(E.simulateTrade(bars, 2, 'LONG', null, E.DEFAULTS), null);
  assert.equal(E.simulateTrade(bars, 4, 'LONG', 1, E.DEFAULTS), null);
});

test('decideSide: 전략별 방향 규칙', () => {
  const f = (trend, reversal) => ({ trend, reversal });
  assert.equal(E.decideSide('trend', 'up', f(true, false)), 'LONG');
  assert.equal(E.decideSide('trend', 'up', f(false, true)), null);
  assert.equal(E.decideSide('reversal', 'down', f(false, true)), 'LONG');
  assert.equal(E.decideSide('reversal', 'up', f(false, true)), 'SHORT');
  assert.equal(E.decideSide('any-trend', 'down', f(false, true)), 'SHORT');
  assert.equal(E.decideSide('any-trend', 'down', f(false, false)), null);
  assert.equal(E.decideSide('raw', 'down', f(false, false)), 'SHORT');
  assert.equal(E.decideSide('raw-rev', 'down', f(false, false)), 'LONG');
  assert.throws(() => E.decideSide('nope', 'up', f(true, true)));
});

test('runStrategy(raw): 트리거 수·쿨다운·포지션 중 무시가 규칙대로 동작한다', () => {
  const bars = flat(400);
  // 봉 100 에서 +2% 급등, 101 에서 또 +2% (쿨다운·보유 중이라 무시돼야 함), 300 에서 -2%
  bars[100].c = 102;
  for (let i = 101; i < 400; i++) { bars[i].o = 102; bars[i].h = 102.5; bars[i].l = 101.5; bars[i].c = 102; }
  bars[101].c = 104.04;
  for (let i = 102; i < 400; i++) { bars[i].o = 104.04; bars[i].h = 104.54; bars[i].l = 103.54; bars[i].c = 104.04; }
  bars[300].c = 101.9;
  for (let i = 301; i < 400; i++) { bars[i].o = 101.9; bars[i].h = 102.4; bars[i].l = 101.4; bars[i].c = 101.9; }
  const r = E.runStrategy(bars, 'raw', { maxHoldBars: 10 });
  assert.equal(r.triggers, 2, '101 은 쿨다운·포지션 보유 중이라 트리거로 세지 않는다');
  assert.equal(r.trades.length, 2);
  assert.equal(r.trades[0].side, 'LONG');
  assert.equal(r.trades[1].side, 'SHORT');
  assert.equal(r.filtered, 0);
});

test('runStrategy(trend): 일봉이 minDailyBars 미만이면 필터가 거절해 거래가 없다', () => {
  const bars = flat(200);
  bars[100].c = 102;
  const r = E.runStrategy(bars, 'trend', { maxHoldBars: 10 });
  assert.equal(r.triggers, 1);
  assert.equal(r.filtered, 1);
  assert.equal(r.trades.length, 0);
});

test('summarize / byYear / bySide: 승률·PF·기대값·최대DD 를 정직하게 계산한다(표본 없으면 null)', () => {
  const mk = (pct, side, y) => ({ pct, r: pct / 1, side, bars: 3, reason: pct > 0 ? 'target' : 'stop', entryTime: Date.UTC(y, 5, 1) });
  const trades = [mk(2, 'LONG', 2024), mk(-1, 'LONG', 2024), mk(-1, 'SHORT', 2025), mk(3, 'SHORT', 2025)];
  const s = E.summarize(trades);
  assert.equal(s.n, 4);
  assert.equal(s.winRate, 50);
  assert.equal(s.profitFactor, 2.5); // 5 / 2
  assert.equal(s.expectancyPct, 0.75);
  assert.equal(s.totalPct, 3);
  assert.equal(s.maxDrawdownPct, 2); // 2 → 1 → 0 : 고점 2 에서 0 까지
  assert.equal(s.positionPct, 20);
  assert.equal(s.equityMaxDrawdownPct, 0.4); // 계좌 기준 = 명목 × 20%
  assert.equal(s.equityTotalPct, 0.6);
  assert.equal(E.summarize(trades, 50).equityMaxDrawdownPct, 1);
  assert.deepEqual(Object.keys(E.byYear(trades)), ['2024', '2025']);
  assert.equal(E.bySide(trades).SHORT.n, 2);
  const empty = E.summarize([]);
  assert.equal(empty.winRate, null);
  assert.equal(empty.expectancyPct, null);
});

test('run.js: 인자 파싱과 판정 기준', () => {
  const a = R.parseArgs(['--symbol', 'btcusdt', '--strategy', 'trend,reversal', '--move', '2', '--rr', '2.5', '--sweep']);
  assert.deepEqual(a.symbols, ['BTCUSDT']);
  assert.deepEqual(a.strategies, ['trend', 'reversal']);
  assert.equal(a.params.movePct, 2);
  assert.equal(a.params.rr, 2.5);
  assert.equal(a.sweep, true);
  assert.throws(() => R.parseArgs(['--strategy', 'magic']));
  assert.throws(() => R.parseArgs(['--move', 'abc']));
  assert.equal(R.verdict({ n: 10 }), '표본 부족');
  assert.equal(R.verdict({ n: 50, expectancyPct: 0.2, profitFactor: 1.4, maxDrawdownPct: 10 }), '✅ 기준 통과');
  assert.equal(R.verdict({ n: 50, expectancyPct: 0.2, profitFactor: 1.4, maxDrawdownPct: 60, equityMaxDrawdownPct: 12 }), '✅ 기준 통과', '계좌DD 로 판정');
  assert.equal(R.verdict({ n: 50, expectancyPct: 0.2, profitFactor: 1.4, maxDrawdownPct: 60, equityMaxDrawdownPct: 20 }), '△ 양(+)이지만 기준 미달');
  assert.equal(R.verdict({ n: 50, expectancyPct: 0.2, profitFactor: 1.1, maxDrawdownPct: 10 }), '△ 양(+)이지만 기준 미달');
  assert.equal(R.verdict({ n: 50, expectancyPct: -0.2, profitFactor: 0.8, maxDrawdownPct: 30 }), '❌ 음(−)');
});

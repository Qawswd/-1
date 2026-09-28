import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const X = require('../server/backtest/evaluate-hypotheses.js');

const BAR = 15 * 60 * 1000;
const T0 = Date.UTC(2026, 8, 27, 0, 0); // 15분 경계

function bars(n, start, price = 100, range = 1) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ t: start + i * BAR, o: price, h: price + range / 2, l: price - range / 2, c: price, v: 1 });
  return out;
}

test('readRows: 깨진 줄은 건너뛴다', () => {
  const rows = X.readRows('{"a":1}\nnot json\n\n{"b":2}\n');
  assert.equal(rows.length, 2);
});

test('groupByCandidate: 가설이 실린 마지막 후보 행 + plan + execution 을 candidateId 로 묶는다', () => {
  const rows = [
    { type: 'candidate', candidateId: 'c1', symbol: 'BTC', ts: 1, features: { hypotheses: [{ id: 'H1' }] } },
    { type: 'candidate', candidateId: 'c1', symbol: 'BTC', ts: 2, features: { hypotheses: [{ id: 'H1', applies: true }] } },
    { type: 'plan', candidateId: 'c1', symbol: 'BTC', ts: 3, action: 'BUY' },
    { type: 'execution', candidateId: 'c1', symbol: 'BTC', ts: 4, status: 'entered' },
    { type: 'candidate', candidateId: 'c2', symbol: 'ETH', ts: 5, features: null }, // 가설 없음 → 후보로 안 잡힘
    { type: 'plan', candidateId: 'c3', symbol: 'ETH', ts: 6, action: 'HOLD' },
  ];
  const g = X.groupByCandidate(rows);
  assert.equal(g.length, 2);
  const c1 = g.find((x) => x.candidateId === 'c1');
  assert.equal(c1.candidate.ts, 2);
  assert.equal(c1.plan.action, 'BUY');
  assert.equal(c1.execution.status, 'entered');
  assert.equal(g.find((x) => x.candidateId === 'c3').candidate, null);
});

test('toFuturesSymbol / parseKlines', () => {
  assert.equal(X.toFuturesSymbol('BTC'), 'BTCUSDT');
  assert.equal(X.toFuturesSymbol('ETHUSDT'), 'ETHUSDT');
  const k = X.parseKlines([[1, '2', '3', '1', '2.5', '9', 2, '0', 1, '0', '0', '0'], ['bad']]);
  assert.equal(k.length, 1);
  assert.equal(k[0].c, 2.5);
});

test('simulateLevels: 롱 — 목표 먼저 → target, 비용 차감, R', () => {
  const b = bars(10, T0);
  b[3].h = 105;
  const r = X.simulateLevels(b, 'LONG', 98, 104, 96);
  assert.equal(r.status, 'resolved');
  assert.equal(r.reason, 'target');
  assert.equal(r.bars, 4);
  assert.ok(Math.abs(r.pct - (4 - 0.14)) < 1e-6);
  assert.ok(Math.abs(r.r - (4 - 0.14) / 2) < 1e-3);
});

test('simulateLevels: 같은 봉 동시 도달은 손절 · 방향 모순 레벨은 invalid · 봉 부족은 pending', () => {
  const b = bars(10, T0);
  b[2].h = 110;
  b[2].l = 90;
  assert.equal(X.simulateLevels(b, 'LONG', 98, 104, 96).reason, 'stop');
  assert.equal(X.simulateLevels(b, 'LONG', 104, 98, 96).status, 'invalid');
  assert.equal(X.simulateLevels(bars(5, T0), 'SHORT', 102, 98, 96).status, 'pending');
  assert.equal(X.simulateLevels([], 'LONG', 98, 104, 96).status, 'pending');
  assert.equal(X.simulateLevels(b, 'HOLD', 98, 104, 96).status, 'invalid');
});

test('simulateLevels: 보유 한도가 지나면 그 봉 종가로 time 청산', () => {
  const b = bars(10, T0);
  const r = X.simulateLevels(b, 'SHORT', 102, 98, 4);
  assert.equal(r.reason, 'time');
  assert.equal(r.bars, 5);
  assert.ok(r.pct < 0, '가격 변화 없으면 비용만큼 손실');
});

test('simulateHypothesis: 기록된 ATR 거리·손익비를 진입가 기준으로 다시 잡아 판정, 미적용은 skipped', () => {
  const h = { id: 'H1', applies: true, side: 'LONG', atr: 1, entry: 100, stop: 98.5, target: 103.75, maxHoldBars: 96 };
  const b = bars(10, T0, 100);
  b[5].h = 104; // 목표 103.75 도달
  const r = X.simulateHypothesis(b, h);
  assert.equal(r.status, 'resolved');
  assert.equal(r.reason, 'target');
  assert.equal(X.simulateHypothesis(b, { id: 'H2', applies: false, reason: '대상 종목 아님' }).status, 'skipped');
  assert.equal(X.simulateHypothesis([], h).status, 'pending');
});

test('stats: 판정된 것만 승률·PF·기대값에 넣고 대기·미적용은 따로 센다', () => {
  const s = X.stats([
    { status: 'resolved', pct: 2, r: 1 },
    { status: 'resolved', pct: -1, r: -0.5 },
    { status: 'pending' },
    { status: 'skipped' },
    { status: 'invalid' },
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.resolved, 2);
  assert.equal(s.pending, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.invalid, 1);
  assert.equal(s.winRate, 50);
  assert.equal(s.profitFactor, 2);
  assert.equal(s.expectancyPct, 0.5);
  assert.equal(X.stats([]).winRate, null);
});

test('evaluate: 주입한 klines 로 가설과 AI 계획을 나란히 판정하고 요약을 만든다', async () => {
  const trigTs = T0 + 5 * 60 * 1000; // 봉 중간에 트리거 → 다음 봉(T0+BAR)부터 판정
  const rows = [
    {
      type: 'candidate', candidateId: 'c1', symbol: 'BTC', ts: trigTs, stage: 'analyzed', passed: true,
      features: { hypotheses: [
        { id: 'H1', applies: true, side: 'LONG', atr: 1, entry: 100, stop: 98.5, target: 103.75, maxHoldBars: 96 },
        { id: 'M0', applies: true, side: 'SHORT', atr: 1, entry: 100, stop: 101.5, target: 97.3, maxHoldBars: 48 },
        { id: 'H2', applies: false, reason: '대상 종목 아님' },
      ] },
    },
    { type: 'plan', candidateId: 'c1', symbol: 'BTC', ts: trigTs + 3 * 60 * 1000, action: 'BUY', confidence: 66, stopNum: 99, targetNum: 102 },
    { type: 'plan', candidateId: 'c9', symbol: 'ETH', ts: trigTs, action: 'HOLD' },
  ];
  const calls = [];
  const fetchKlines = async (symbol, start, limit) => {
    calls.push({ symbol, start, limit });
    const b = bars(100, start, 100);
    b[4].h = 104; // 롱 목표(103.75 / 102) 도달, 숏 손절(101.5) 도달
    return b;
  };
  const { summary, details } = await X.evaluate({ rows, fetchKlines, now: T0 + 86400000 });
  assert.equal(calls[0].symbol, 'BTCUSDT');
  assert.equal(calls[0].start, T0 + BAR, '트리거 봉의 다음 봉부터');
  assert.equal(summary.candidates, 2);
  assert.equal(summary.H1.resolved, 1);
  assert.equal(summary.H1.wins, 1);
  assert.equal(summary.M0.losses, 1);
  assert.equal(summary.H2.skipped, 1);
  assert.equal(summary.AI.resolved, 1);
  assert.equal(summary.AI.wins, 1);
  assert.equal(summary.AI.skipped, 1, 'HOLD 는 미적용');
  assert.ok(details.some((d) => d.who === 'AI' && d.reason === 'target'));
  assert.match(X.renderSummary(summary), /H1/);
});

test('evaluate: klines 조회가 실패해도 죽지 않고 pending 으로 남긴다', async () => {
  const rows = [{ type: 'candidate', candidateId: 'c1', symbol: 'BTC', ts: T0, features: { hypotheses: [{ id: 'H1', applies: true, side: 'LONG', atr: 1, entry: 100, stop: 98.5, target: 103.75, maxHoldBars: 96 }] } }];
  const { summary } = await X.evaluate({ rows, fetchKlines: async () => { throw new Error('network'); } });
  assert.equal(summary.H1.pending, 1);
});

test('evaluate: 예약(정기) 판정과 트리거 판정을 source 로 나눠 집계하고 계획 손익비 평균을 낸다', async () => {
  const rows = [
    { type: 'candidate', candidateId: 's1', source: 'schedule', symbol: 'BTC', ts: T0, stage: 'analyzed', passed: true },
    { type: 'plan', candidateId: 's1', symbol: 'BTC', ts: T0 + 60000, action: 'BUY', stopNum: 99, targetNum: 102, rr: 2 },
    { type: 'candidate', candidateId: 'w1', source: 'watcher', symbol: 'BTC', ts: T0, stage: 'analyzed', passed: true,
      features: { hypotheses: [{ id: 'H1', applies: false, reason: 'x' }] } },
    { type: 'plan', candidateId: 'w1', symbol: 'BTC', ts: T0 + 60000, action: 'SELL', stopNum: 101, targetNum: 98, rr: 1.8 },
  ];
  const fetchKlines = async (symbol, start) => {
    const b = bars(100, start, 100);
    b[3].h = 102.5; // 롱 목표 도달 → 예약 판정 승, 숏 손절 도달 → 트리거 판정 패
    return b;
  };
  const { summary, avgPlannedRR, verdict } = await X.evaluate({ rows, fetchKlines, now: T0 + 86400000 });
  assert.equal(summary['AI-sched'].wins, 1);
  assert.equal(summary['AI-trig'].losses, 1);
  assert.equal(summary.AI.resolved, 2);
  assert.equal(avgPlannedRR, 1.9);
  assert.equal(verdict.pass, false, '표본 30건 미만');
  assert.match(verdict.lines[0], /표본 2\/30건/);
});

test('phase2Verdict: 30건 이상 · 기대값 > 0 · PF ≥ 1.3 이면 통과', () => {
  assert.equal(X.phase2Verdict({ resolved: 30, expectancyPct: 0.4, profitFactor: 1.5, winRate: 47 }).pass, true);
  assert.equal(X.phase2Verdict({ resolved: 30, expectancyPct: 0.1, profitFactor: 1.1, winRate: 40 }).pass, false);
  assert.equal(X.phase2Verdict({ resolved: 0 }).pass, false);
  assert.equal(X.phase2Verdict(null).pass, false);
});

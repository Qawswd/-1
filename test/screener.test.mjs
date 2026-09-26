import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scoreCandidate, rankCandidates, countDirectionSignals } = require('../server/screener.js');

// --- countDirectionSignals ---------------------------------------------------

test('countDirectionSignals: 모든 지표가 강세면 bull만 쌓인다', () => {
  const r = countDirectionSignals({
    price: 110,
    sma20: 100,
    sma50: 95,
    sma200: 90,
    macd: { hist: 2 },
    rsi14: 60,
  });
  assert.equal(r.bull, 6); // sma20·sma50·sma200·sma20vs50·macd·rsi
  assert.equal(r.bear, 0);
  assert.equal(r.total, 6);
});

test('countDirectionSignals: 모든 지표가 약세면 bear만 쌓인다', () => {
  const r = countDirectionSignals({
    price: 100,
    sma20: 105,
    sma50: 110,
    sma200: 115,
    macd: { hist: -1 },
    rsi14: 40,
  });
  assert.equal(r.bull, 0);
  assert.equal(r.bear, 6);
  assert.equal(r.total, 6);
});

test('countDirectionSignals: RSI 45~55(중립)은 신호로 세지 않는다', () => {
  const r = countDirectionSignals({ price: 100, sma20: null, sma50: null, sma200: null, macd: null, rsi14: 50 });
  assert.equal(r.total, 0, 'RSI 50은 신호가 아니므로 total 0이어야 한다');
});

test('countDirectionSignals: 데이터 없는 지표(null)는 총합에서 빠진다', () => {
  const r = countDirectionSignals({ price: 100, sma20: 95, sma50: null, sma200: null, macd: null, rsi14: null });
  assert.equal(r.total, 1); // sma20만
  assert.equal(r.bull, 1);
});

// --- scoreCandidate ----------------------------------------------------------

test('scoreCandidate: 가격이 없으면 NEUTRAL·score -Infinity', () => {
  const r = scoreCandidate({ price: null });
  assert.equal(r.direction, 'NEUTRAL');
  assert.equal(r.score, -Infinity);
});

test('scoreCandidate: 지표가 하나도 없으면 NEUTRAL', () => {
  const r = scoreCandidate({ price: 100 });
  assert.equal(r.direction, 'NEUTRAL');
  assert.equal(r.score, -Infinity);
});

test('scoreCandidate: 강한 상승 합의 + 유효한 20일 레인지 → LONG, 손익비·점수가 양수', () => {
  const r = scoreCandidate({
    price: 100,
    sma20: 95,
    sma50: 90,
    sma200: 85,
    macd: { hist: 1 },
    rsi14: 60,
    high20: 130,
    low20: 90,
    volatilityPct: 20,
  });
  assert.equal(r.direction, 'LONG');
  assert.equal(r.confidence, 1); // 6개 지표 전부 강세 합의
  assert.equal(r.stop, 90);
  assert.equal(r.target, 130);
  assert.equal(r.rr, 3); // (130-100)/(100-90) = 30/10
  assert.equal(r.score, 2.8); // 3*1 - 20/100
});

test('scoreCandidate: 강한 하락 합의 + 유효한 20일 레인지 → SHORT, 손익비·점수가 양수', () => {
  const r = scoreCandidate({
    price: 100,
    sma20: 105,
    sma50: 110,
    sma200: 115,
    macd: { hist: -1 },
    rsi14: 40,
    high20: 110,
    low20: 70,
    volatilityPct: 30,
  });
  assert.equal(r.direction, 'SHORT');
  assert.equal(r.confidence, 1);
  assert.equal(r.stop, 110);
  assert.equal(r.target, 70);
  assert.equal(r.rr, 3); // (100-70)/(110-100) = 30/10
  assert.equal(r.score, 2.7); // 3*1 - 30/100
});

test('scoreCandidate: 지표가 반반으로 엇갈리면(합의 60% 미만) NEUTRAL', () => {
  const r = scoreCandidate({
    price: 100,
    sma20: 105, // 약세 신호
    sma50: null,
    sma200: null,
    macd: { hist: 1 }, // 강세 신호
    rsi14: 50, // 중립(신호 아님)
    high20: 130,
    low20: 90,
  });
  assert.equal(r.direction, 'NEUTRAL');
  assert.equal(r.score, -Infinity);
  assert.equal(r.signals.bull, 1);
  assert.equal(r.signals.bear, 1);
});

test('scoreCandidate: 방향은 잡혔지만 손익비가 0 이하면(고점 돌파 상태) score -Infinity', () => {
  // 가격이 이미 20일 고점과 같음 → LONG 목표(고점)가 진입가와 같아 reward=0
  const r = scoreCandidate({
    price: 130,
    sma20: 120,
    sma50: 110,
    sma200: 100,
    macd: { hist: 1 },
    rsi14: 60,
    high20: 130,
    low20: 100,
  });
  assert.equal(r.direction, 'LONG');
  assert.equal(r.rr, null);
  assert.equal(r.score, -Infinity);
  assert.match(r.reason, /손익비/);
});

test('scoreCandidate: 변동성이 높을수록 같은 손익비·확신도라도 점수가 낮다', () => {
  const base = {
    price: 100,
    sma20: 95,
    sma50: 90,
    sma200: 85,
    macd: { hist: 1 },
    rsi14: 60,
    high20: 130,
    low20: 90,
  };
  const low = scoreCandidate({ ...base, volatilityPct: 10 });
  const high = scoreCandidate({ ...base, volatilityPct: 80 });
  assert.ok(low.score > high.score, '변동성이 낮은 쪽 점수가 더 높아야 한다');
  assert.equal(low.rr, high.rr); // 손익비 자체는 동일 — 변동성만 감점 요인
});

test('scoreCandidate: 확신도가 낮으면(합의 60%대) 100% 합의보다 점수가 낮다', () => {
  const full = scoreCandidate({
    price: 100,
    sma20: 95,
    sma50: 90,
    sma200: 85,
    macd: { hist: 1 },
    rsi14: 60,
    high20: 130,
    low20: 90,
    volatilityPct: 20,
  });
  // 6개 중 4개만 강세(66.7%) — sma200을 약세로 뒤집는다
  const partial = scoreCandidate({
    price: 100,
    sma20: 95,
    sma50: 90,
    sma200: 999, // price < sma200 → 약세 신호로 뒤집힘
    macd: { hist: 1 },
    rsi14: 60,
    high20: 130,
    low20: 90,
    volatilityPct: 20,
  });
  assert.equal(full.confidence, 1);
  assert.ok(partial.confidence < 1);
  assert.ok(partial.score < full.score);
});

// --- rankCandidates ------------------------------------------------------------

test('rankCandidates: 점수 내림차순으로 정렬한다', () => {
  const items = [{ symbol: 'A', score: 1 }, { symbol: 'B', score: 3 }, { symbol: 'C', score: 2 }];
  const ranked = rankCandidates(items);
  assert.deepEqual(ranked.map((i) => i.symbol), ['B', 'C', 'A']);
});

test('rankCandidates: NEUTRAL(-Infinity)은 입력 순서와 무관하게 맨 뒤로 밀린다', () => {
  const items = [
    { symbol: 'NEUTRAL1', score: -Infinity },
    { symbol: 'GOOD', score: 1.5 },
    { symbol: 'NEUTRAL2', score: -Infinity },
  ];
  const ranked = rankCandidates(items);
  assert.equal(ranked[0].symbol, 'GOOD');
  assert.equal(ranked[1].score, -Infinity);
  assert.equal(ranked[2].score, -Infinity);
});

test('rankCandidates: 원본 배열을 변형하지 않는다', () => {
  const items = [{ symbol: 'A', score: 1 }, { symbol: 'B', score: 3 }];
  const original = [...items];
  rankCandidates(items);
  assert.deepEqual(items, original);
});

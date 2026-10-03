'use strict';

// screener.js — AI 호출 없는 1차 스크리닝 ("한 종목만 죽어라 파지 않는다")
//
// 설계 원칙
// - AI(claude CLI) 호출 0. indicators.js가 이미 계산해둔 숫자(SMA20/50/200, RSI, MACD,
//   최근 20일 고저, 변동성)만 갖고 방향·손익비·점수를 매긴다 — 비용이 사실상 0에 가깝다.
// - 워치리스트 전체를 이걸로 훑고, 점수 상위 1~2개만 골라 그 위에서 12명 AI 정밀분석
//   (engine.run)을 돌리는 게 이 모듈의 존재 이유다. AI 한도는 그 정밀분석에서만 쓴다.
// - 점수 = 손익비(RR) × 방향성 확신도 − 변동성 페널티 (사용자 확정 기준).
// - 데이터에 없는 값을 지어내지 않는다 — 지표가 부족하면 신호에서 빼고, 판단 근거가
//   하나도 없으면 NEUTRAL·score:-Infinity로 순위 밖으로 보낸다.
// - 외부 npm 의존성 0.

// --------------------------------------------------------------------------
// 순수 함수 — indicators 객체 하나만 받아서 계산한다. 네트워크 없음, 완전 테스트 가능.
// --------------------------------------------------------------------------

// 몇 개 지표가 같은 방향을 가리키는지 센다. RSI는 40~60(중립)이면 신호로 안 친다 —
// 애매한 RSI로 억지 방향을 만들지 않기 위해서다.
function countDirectionSignals({ price, sma20, sma50, sma200, macd, rsi14 }) {
  let bull = 0;
  let bear = 0;
  let total = 0;

  if (Number.isFinite(sma20)) {
    total++;
    if (price >= sma20) bull++;
    else bear++;
  }
  if (Number.isFinite(sma50)) {
    total++;
    if (price >= sma50) bull++;
    else bear++;
  }
  if (Number.isFinite(sma200)) {
    total++; // 장기 추세 — SMA20만으로는 못 보는 것
    if (price >= sma200) bull++;
    else bear++;
  }
  if (Number.isFinite(sma20) && Number.isFinite(sma50)) {
    total++; // 골든/데드크로스
    if (sma20 >= sma50) bull++;
    else bear++;
  }
  if (macd && Number.isFinite(macd.hist)) {
    total++;
    if (macd.hist >= 0) bull++;
    else bear++;
  }
  if (Number.isFinite(rsi14)) {
    if (rsi14 >= 55) {
      total++;
      bull++;
    } else if (rsi14 <= 45) {
      total++;
      bear++;
    }
    // 45~55는 중립 — 신호에 안 넣는다
  }

  return { bull, bear, total };
}

// indicators 하나(한 심볼)를 받아 방향·손익비·점수를 계산한다.
// direction: 'LONG' | 'SHORT' | 'NEUTRAL'. NEUTRAL은 항상 score:-Infinity(순위 밖).
function scoreCandidate(indicators, opts = {}) {
  const ind = indicators || {};
  const price = Number(ind.price);
  const minAgreeRatio = Number.isFinite(opts.minAgreeRatio) ? opts.minAgreeRatio : 0.6;

  if (!(price > 0)) {
    return { direction: 'NEUTRAL', score: -Infinity, reason: '가격 데이터 없음' };
  }

  const { bull, bear, total } = countDirectionSignals({
    price,
    sma20: ind.sma20,
    sma50: ind.sma50,
    sma200: ind.sma200,
    macd: ind.macd,
    rsi14: ind.rsi14,
  });

  if (total === 0) {
    return { direction: 'NEUTRAL', score: -Infinity, reason: '판단할 지표가 없음' };
  }

  const bullRatio = bull / total;
  const bearRatio = bear / total;

  let direction;
  let confidence;
  if (bullRatio >= minAgreeRatio && bullRatio > bearRatio) {
    direction = 'LONG';
    confidence = bullRatio;
  } else if (bearRatio >= minAgreeRatio && bearRatio > bullRatio) {
    direction = 'SHORT';
    confidence = bearRatio;
  } else {
    direction = 'NEUTRAL';
    confidence = Math.max(bullRatio, bearRatio);
  }

  if (direction === 'NEUTRAL') {
    return {
      direction,
      confidence,
      score: -Infinity,
      reason: `지표가 엇갈려 방향이 불명확(상승 ${bull}/${total} · 하락 ${bear}/${total})`,
      signals: { bull, bear, total },
    };
  }

  // 손익비 — 최근 20일 고점/저점을 손절·목표의 근거로 쓴다(데이터에 있는 값만).
  const high20 = Number(ind.high20);
  const low20 = Number(ind.low20);
  let entry = price;
  let stop;
  let target;
  let rr = null;

  if (direction === 'LONG') {
    stop = low20;
    target = high20;
    if (Number.isFinite(stop) && Number.isFinite(target) && entry > stop) {
      const risk = entry - stop;
      const reward = target - entry;
      rr = risk > 0 ? reward / risk : null;
    }
  } else {
    stop = high20;
    target = low20;
    if (Number.isFinite(stop) && Number.isFinite(target) && stop > entry) {
      const risk = stop - entry;
      const reward = entry - target;
      rr = risk > 0 ? reward / risk : null;
    }
  }

  if (!(rr > 0)) {
    return {
      direction,
      confidence,
      entry,
      stop: Number.isFinite(stop) ? stop : null,
      target: Number.isFinite(target) ? target : null,
      rr: null,
      score: -Infinity,
      reason: '손익비를 계산할 수 없거나 0 이하(20일 레인지 안에 진입가가 있음)',
      signals: { bull, bear, total },
    };
  }

  // 변동성 페널티 — 연환산 변동성 100%를 1.0으로 정규화해서 뺀다.
  const volatilityPct = Number.isFinite(ind.volatilityPct) ? ind.volatilityPct : 0;
  const volPenalty = volatilityPct / 100;

  const score = rr * confidence - volPenalty;

  return {
    direction,
    confidence,
    entry,
    stop,
    target,
    rr,
    volatilityPct,
    volPenalty,
    score,
    signals: { bull, bear, total },
  };
}

// 여러 심볼의 scoreCandidate 결과를 점수 내림차순으로 정렬한다. NEUTRAL/계산불가는
// score가 -Infinity라 자연히 맨 뒤로 밀린다.
function rankCandidates(items) {
  return [...(items || [])].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
}

module.exports = { scoreCandidate, rankCandidates, countDirectionSignals, screenWatchlist };

// --------------------------------------------------------------------------
// 오케스트레이션 — 실제로 시세를 조회해서(AI 호출 없음) 워치리스트 전체를 훑는다.
// --------------------------------------------------------------------------

// symbols: ['AAPL','BTC',...]. 반환: rankCandidates로 정렬된 배열(각 항목에 symbol·display 포함).
// 심볼 하나가 실패해도(데이터 조회 오류 등) 전체가 죽지 않는다 — 그 심볼만 NEUTRAL·사유
// 남기고 나머지는 계속 진행한다.
async function screenWatchlist(symbols, opts = {}) {
  const market = require('./market');
  const list = Array.isArray(symbols) ? symbols : [];
  const results = [];

  for (const raw of list) {
    const sym = String(raw || '').trim();
    if (!sym) continue;
    try {
      const resolved = market.resolveSymbol(sym);
      const data = await market.fetchMarket(resolved);
      const scored = scoreCandidate(data && data.indicators, opts);
      results.push({
        symbol: sym,
        display: (data && data.display) || (resolved && resolved.display) || sym,
        priceLine: data && data.priceLine,
        ...scored,
      });
    } catch (e) {
      results.push({
        symbol: sym,
        display: sym,
        direction: 'NEUTRAL',
        score: -Infinity,
        reason: `데이터 조회 실패: ${e && e.message ? e.message : e}`,
      });
    }
  }

  return rankCandidates(results);
}

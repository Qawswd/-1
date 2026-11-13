'use strict';

// hypotheses.js — 감시 트리거마다 "기계 규칙이라면 어떻게 했을까"를 계산해 후보 로그에 남긴다.
//
// 왜: 백테스트(docs/04-BACKTEST.md)에서 트리거 자리 자체엔 우위가 없었고, 유일한 포켓(H1)도
// 표본이 작아 가설로만 등록했다. 실전 진입 조건은 "AI 판정이 같은 기간 기계 규칙보다 낫다"이므로,
// 같은 트리거에서 기계 규칙의 판정(방향·진입·손절·목표·보유한도)을 AI 판정과 나란히 기록해
// 4주 뒤 결과를 소급 판정(backtest/evaluate-hypotheses.js)할 수 있어야 한다.
//
// 이 모듈은 순수 계산이다 — 네트워크·파일·AI 호출 없음. 기록은 watcher 가 후보 features 에 싣는다.
// 규칙 파라미터는 백테스트 결과 그대로다. 여기 숫자를 바꾸면 docs/04 를 먼저 갱신한다.

const { atrSeries } = require('./backtest/engine');

const HYPOTHESES = Object.freeze([
  Object.freeze({
    id: 'H1',
    name: 'BTC 2% 급락 + 20일 저점권 → 롱',
    symbols: ['BTC'],
    minMovePct: 2.0,
    direction: 'down', // 트리거 방향 조건 (null 이면 양방향)
    filter: 'reversal', // 통과해야 하는 필터
    side: 'against', // 'with' = 움직인 방향, 'against' = 반대 방향
    stopAtrMult: 1.5,
    rr: 2.5,
    maxHoldBars: 96, // 15분봉 96 = 24시간
  }),
  Object.freeze({
    id: 'H2',
    name: 'ETH 2% 급변동 + 추세 동의 → 같은 방향',
    symbols: ['ETH'],
    minMovePct: 2.0,
    direction: null,
    filter: 'trend',
    side: 'with',
    stopAtrMult: 2.0,
    rr: 1.8,
    maxHoldBars: 96,
  }),
  Object.freeze({
    id: 'M0',
    name: '기본 기계 규칙(백테스트 기본값) — 필터 통과 시 움직인 방향',
    symbols: null, // 전 종목
    minMovePct: 1.5,
    direction: null,
    filter: 'any', // trend 또는 reversal
    side: 'with',
    stopAtrMult: 1.5,
    rr: 1.8,
    maxHoldBars: 48,
  }),
]);

const ATR_PERIOD = 14;

// 15분봉 배열에서 ATR(14, 단순 평균) 마지막 값. 봉이 모자라면 null.
function atr15m(candles15m) {
  if (!Array.isArray(candles15m) || candles15m.length < ATR_PERIOD + 1) return null;
  const s = atrSeries(candles15m, ATR_PERIOD);
  const v = s[s.length - 1];
  return Number.isFinite(v) && v > 0 ? v : null;
}

function baseSymbol(symbol) {
  return String(symbol || '')
    .toUpperCase()
    .replace(/-/g, '')
    .replace(/USDT$/, '');
}

function round(n, dp = 2) {
  return Number.isFinite(n) ? Number(n.toFixed(dp)) : null;
}

// 트리거 하나에 대해 가설 전부를 평가한다.
// input: { symbol, direction:'up'|'down', movePct(부호 있음 %), price, filters:{trend,reversal}, atr }
// 반환: [{ id, name, applies, side, entry, stop, target, maxHoldBars, atr, reason }]
//   applies=false 면 side/레벨은 null 이고 reason 에 왜 안 걸렸는지 적는다(비교 통계용).
function evaluateHypotheses(input) {
  const inp = input || {};
  const sym = baseSymbol(inp.symbol);
  const dir = inp.direction === 'up' || inp.direction === 'down' ? inp.direction : null;
  const move = Number(inp.movePct);
  const price = Number(inp.price);
  const f = inp.filters || {};
  const atr = Number(inp.atr);

  return HYPOTHESES.map((h) => {
    const base = { id: h.id, name: h.name, applies: false, side: null, entry: null, stop: null, target: null, maxHoldBars: h.maxHoldBars, atr: Number.isFinite(atr) ? round(atr, 4) : null, reason: null };
    if (h.symbols && !h.symbols.includes(sym)) return { ...base, reason: `대상 종목 아님(${sym || '-'})` };
    if (!dir) return { ...base, reason: '방향 없음' };
    if (h.direction && h.direction !== dir) return { ...base, reason: `방향 불일치(${dir})` };
    if (!Number.isFinite(move) || Math.abs(move) < h.minMovePct) return { ...base, reason: `변동 ${Number.isFinite(move) ? move.toFixed(2) : '-'}% < ${h.minMovePct}%` };
    const filterOk = h.filter === 'trend' ? !!f.trend : h.filter === 'reversal' ? !!f.reversal : !!(f.trend || f.reversal);
    if (!filterOk) return { ...base, reason: `${h.filter} 필터 불통과` };
    if (!(price > 0)) return { ...base, reason: '가격 없음' };
    if (!(atr > 0)) return { ...base, reason: 'ATR 없음(15분봉 부족)' };

    const withMove = dir === 'up' ? 'LONG' : 'SHORT';
    const side = h.side === 'with' ? withMove : withMove === 'LONG' ? 'SHORT' : 'LONG';
    const d = side === 'LONG' ? 1 : -1;
    const dist = atr * h.stopAtrMult;
    return {
      ...base,
      applies: true,
      side,
      entry: round(price, 4), // 다음 봉 시가로 진입한다는 가정 — 소급 판정 시 실제 시가로 대체
      stop: round(price - d * dist, 4),
      target: round(price + d * dist * h.rr, 4),
      reason: null,
    };
  });
}

module.exports = { HYPOTHESES, atr15m, evaluateHypotheses, baseSymbol };

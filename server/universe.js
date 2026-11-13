'use strict';

// universe.js — 거래 대상 종목 고정. 운영 방침(2026-09-25): BTC·ETH 두 종목만 감시·분석·
// 거래한다. 종목이 많을수록 트리거·토큰·관리 부담이 커지고, 미국주식은 바이낸스에서 거래
// 자체가 불가능해 분석 한도만 소모했다.
//
// 이 목록은 설정(config.json)으로 바꿀 수 없게 코드에 고정한다 — 설정 화면이나 HTTP로
// 실수로 종목이 늘어나는 것을 막기 위해서다. 바꾸려면 이 파일을 고쳐야 한다.
// 적용 지점: 분석 엔진 입구(engine.run), 수동 분석 API, 설정 로드(워치리스트), 전광판.

const FIXED_UNIVERSE = Object.freeze(['BTC', 'ETH']);

// 사용자가 입력하는 여러 표기를 기본 심볼로 맞춘다: 'btc', 'BTCUSDT', 'BTC-USDT', '비트코인'.
const ALIASES = { 비트코인: 'BTC', 이더리움: 'ETH', 이더: 'ETH' };
function normalizeUniverseSymbol(input) {
  let s = String(input == null ? '' : input).trim();
  if (ALIASES[s]) return ALIASES[s];
  s = s.toUpperCase().replace(/[-_/\s]/g, '');
  if (s.endsWith('USDT') && s.length > 4) s = s.slice(0, -4);
  return s;
}

function isInUniverse(input) {
  return FIXED_UNIVERSE.includes(normalizeUniverseSymbol(input));
}

// 워치리스트에서 고정 종목만 남긴다. 하나도 안 남으면 고정 종목 전체를 쓴다.
function filterToUniverse(list) {
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const n = normalizeUniverseSymbol(x);
    if (FIXED_UNIVERSE.includes(n) && !out.includes(n)) out.push(n);
  }
  return out.length ? out : [...FIXED_UNIVERSE];
}

module.exports = { FIXED_UNIVERSE, normalizeUniverseSymbol, isInUniverse, filterToUniverse };

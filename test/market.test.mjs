import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveSymbol } = require('../server/market.js');

// 실거래 지역 제한 대응 — SKHYNIXUSDT/SAMSUNGUSDT는 한국 계정에서 거래 금지라
// 발견된 것에 대한 회귀 방지 테스트.

test('resolveSymbol: SKHYNIX는 execSymbol로 SKHYUSDT(미국 ADR 기반)를 준다', () => {
  const r = resolveSymbol('SKHYNIX');
  assert.equal(r.kind, 'krstock');
  assert.equal(r.symbol, 'SKHYNIX'); // 표시·내부 심볼은 그대로
  assert.equal(r.execSymbol, 'SKHYUSDT'); // 실거래 심볼만 다르다
});

test('resolveSymbol: SAMSUNG은 execSymbol이 명시적으로 null(우회로 없음)', () => {
  const r = resolveSymbol('SAMSUNG');
  assert.equal(r.kind, 'krstock');
  assert.equal(r.symbol, 'SAMSUNG');
  assert.equal(r.execSymbol, null);
  // undefined가 아니라 진짜 null인지(필드 자체는 존재) 확인 — "모름"과 "확인 결과 불가"는 다르다.
  assert.ok('execSymbol' in r);
});

test('resolveSymbol: 한글/별칭으로 찾아도 execSymbol이 동일하게 붙는다', () => {
  assert.equal(resolveSymbol('하이닉스').execSymbol, 'SKHYUSDT');
  assert.equal(resolveSymbol('000660').execSymbol, 'SKHYUSDT');
  assert.equal(resolveSymbol('삼성전자').execSymbol, null);
});

test('resolveSymbol: 크립토는 execSymbol 필드 자체가 없다(일반 변환 경로가 실제로 유효해서 — BTC→BTCUSDT는 진짜 존재하는 심볼)', () => {
  const btc = resolveSymbol('BTC');
  assert.equal('execSymbol' in btc, false);
});

test('resolveSymbol: 미국 개별주식(AAPL·V 등)은 execSymbol이 명시적으로 null이다(바이낸스가 취급 안 함 — 일반 변환 경로를 타면 존재하지 않는 심볼로 실주문을 시도하게 된다)', () => {
  const aapl = resolveSymbol('AAPL');
  const v = resolveSymbol('V');
  assert.equal(aapl.kind, 'stock');
  assert.equal(aapl.execSymbol, null);
  assert.ok('execSymbol' in aapl);
  assert.equal(v.kind, 'stock');
  assert.equal(v.execSymbol, null);
});

// --- 상위 시간대(1h·4h) 요약 — 오너 질문 "15분봉만 보면 부정확하지 않나" 대응 ------------------
const { tfSummaryLine, buildMtf } = require('../server/market.js');
function tfBars(n, start, step) {
  const out = [];
  for (let i = 0; i < n; i++) { const p = start + i * step; out.push({ t: i * 3600000, o: p, h: p + 1, l: p - 1, c: p, v: 10 }); }
  return out;
}
test('tfSummaryLine: 21봉 미만이면 null, 충분하면 SMA20 위/아래·RSI·MACD·20봉 변화·구간 위치를 한 줄로', () => {
  assert.equal(tfSummaryLine('1시간봉', tfBars(10, 100, 1)), null);
  const up = tfSummaryLine('1시간봉', tfBars(60, 100, 1));
  assert.match(up, /^1시간봉: SMA20 위/);
  assert.match(up, /RSI \d+/);
  assert.match(up, /최근 20봉 \+/);
  const down = tfSummaryLine('4시간봉', tfBars(60, 200, -1));
  assert.match(down, /SMA20 아래/);
});
test('buildMtf: 시간대별 줄 + 추세 정렬 한 줄, 실패한 시간대는 빠진다', () => {
  const m = buildMtf({ '1시간봉': tfBars(60, 100, 1), '4시간봉': tfBars(60, 100, 1), '일봉': tfBars(60, 200, -1) });
  assert.equal(m.lines.length, 4);
  assert.match(m.lines[3], /시간대 간 엇갈림/);
  assert.equal(m.trend['일봉'], false);
  const all = buildMtf({ '1시간봉': tfBars(60, 100, 1), '일봉': tfBars(60, 100, 1) });
  assert.match(all.lines.at(-1), /전 시간대 상승 정렬/);
  assert.deepEqual(buildMtf({}).lines, ['상위 시간대 데이터 없음']);
});

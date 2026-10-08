import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { computeIndicators, atr14, highLowSince, structureAgreesWithDirection, rangePosition, reversalAgreesWithDirection } = require('../server/indicators.js');

// Build candles from an array of closing prices (past -> latest).
// h/l set equal to close so high20/low20 are deterministic from closes.
function candlesFromCloses(closes) {
  return closes.map((c, i) => ({ t: i * 86400000, o: c, h: c, l: c, c, v: 1000 }));
}

// Known sequence: closes 1..30
const closes1to30 = Array.from({ length: 30 }, (_, i) => i + 1);

test('sma20 is the mean of the last 20 closes', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  // last 20 closes are 11..30, mean = (11+30)/2 = 20.5
  assert.equal(r.sma20, 20.5);
});

test('sma50 is null when fewer than 50 candles', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  assert.equal(r.sma50, null);
});

test('sma200 is null when fewer than 200 candles (데이터 없으면 지어내지 않는다)', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  assert.equal(r.sma200, null);
});

test('sma200 is the mean of the last 200 closes when enough data exists', () => {
  const closes1to250 = Array.from({ length: 250 }, (_, i) => i + 1);
  const r = computeIndicators(candlesFromCloses(closes1to250));
  // last 200 closes are 51..250, mean = (51+250)/2 = 150.5
  assert.equal(r.sma200, 150.5);
});

test('summaryLines에 SMA200 줄은 데이터가 있을 때만 추가된다(20일선만으로는 장기추세 구분 불가 보완)', () => {
  const short = computeIndicators(candlesFromCloses(closes1to30));
  assert.ok(!short.summaryLines.some((l) => l.includes('SMA200')));

  const closes1to250 = Array.from({ length: 250 }, (_, i) => i + 1);
  const long = computeIndicators(candlesFromCloses(closes1to250));
  assert.ok(long.summaryLines.some((l) => l.includes('SMA200')));
});

test('summaryLines의 SMA200 줄에 골든/데드크로스가 표기된다', () => {
  // 꾸준히 상승하는 시리즈 → SMA50이 SMA200보다 위(골든크로스 구간)여야 한다
  const closes1to250 = Array.from({ length: 250 }, (_, i) => i + 1);
  const r = computeIndicators(candlesFromCloses(closes1to250));
  const line = r.summaryLines.find((l) => l.includes('SMA200'));
  assert.ok(line, 'SMA200 줄이 있어야 한다');
  assert.ok(line.includes('골든크로스'), `상승 시리즈면 골든크로스여야 함: ${line}`);
});

test('high20 and low20 come from the last 20 candles', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  assert.equal(r.high20, 30);
  assert.equal(r.low20, 11);
});

test('rsi14 is within 0..100 and near 100 for a strictly rising series', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  assert.ok(r.rsi14 >= 0 && r.rsi14 <= 100, `rsi out of range: ${r.rsi14}`);
  assert.ok(r.rsi14 >= 99, `rsi should be near 100 for rising series: ${r.rsi14}`);
});

test('rsi14 is near 0 for a strictly falling series', () => {
  const r = computeIndicators(candlesFromCloses([...closes1to30].reverse()));
  assert.ok(r.rsi14 >= 0 && r.rsi14 <= 100, `rsi out of range: ${r.rsi14}`);
  assert.ok(r.rsi14 <= 1, `rsi should be near 0 for falling series: ${r.rsi14}`);
});

test('macd exposes numeric macd/signal/hist fields', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  assert.equal(typeof r.macd.macd, 'number');
  assert.equal(typeof r.macd.signal, 'number');
  assert.equal(typeof r.macd.hist, 'number');
  assert.ok(Number.isFinite(r.macd.macd));
  assert.ok(Number.isFinite(r.macd.signal));
  assert.ok(Number.isFinite(r.macd.hist));
});

test('price and changePct24h reflect the latest candle', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  assert.equal(r.price, 30);
  // prev close 29 -> 30 : (1/29)*100
  assert.ok(Math.abs(r.changePct24h - (1 / 29) * 100) < 1e-9);
});

test('volatilityPct is a finite non-negative number', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  assert.ok(Number.isFinite(r.volatilityPct));
  assert.ok(r.volatilityPct >= 0);
});

test('summaryLines is an array of Korean strings (roughly 5 lines)', () => {
  const r = computeIndicators(candlesFromCloses(closes1to30));
  assert.ok(Array.isArray(r.summaryLines));
  assert.ok(r.summaryLines.length >= 3 && r.summaryLines.length <= 7);
  for (const line of r.summaryLines) {
    assert.equal(typeof line, 'string');
    assert.ok(line.length > 0);
  }
});

// --- atr14 / highLowSince (트레일링 스탑용) --------------------------------------

test('atr14: 캔들이 2개 미만이면 null', () => {
  assert.equal(atr14([]), null);
  assert.equal(atr14([{ h: 10, l: 9, c: 9.5 }]), null);
});

test('atr14: 진짜 변동폭(true range)의 평균을 낸다 — 간단한 2봉 케이스로 손계산 검증', () => {
  // 1봉: h=10,l=9,c=9.5 / 2봉: h=11,l=10,c=10.5
  // TR = max(h-l, |h-이전종가|, |l-이전종가|) = max(11-10, |11-9.5|, |10-9.5|) = max(1, 1.5, 0.5) = 1.5
  const candles = [
    { h: 10, l: 9, c: 9.5 },
    { h: 11, l: 10, c: 10.5 },
  ];
  assert.equal(atr14(candles), 1.5);
});

test('atr14: 14개 넘는 캔들이 있으면 최근 14개만 평균낸다', () => {
  const candles = [];
  for (let i = 0; i < 20; i++) {
    candles.push({ h: 100, l: 100, c: 100 }); // TR=0인 초반 캔들(무시돼야 함)
  }
  candles.push({ h: 110, l: 100, c: 105 }); // 마지막 근처 TR=10짜리 몇 개
  candles.push({ h: 120, l: 100, c: 110 });
  const r = atr14(candles);
  assert.ok(r > 0); // 초반 0짜리들이 아니라 최근 변동폭이 반영됨
});

test('highLowSince: sinceMs 이후 캔들만으로 최고가·최저가를 구한다', () => {
  const candles = [
    { t: 1000, h: 50, l: 40 }, // sinceMs 이전 — 제외돼야 함
    { t: 2000, h: 100, l: 90 },
    { t: 3000, h: 80, l: 70 },
  ];
  const r = highLowSince(candles, 2000);
  assert.equal(r.high, 100);
  assert.equal(r.low, 70);
});

test('highLowSince: sinceMs가 없으면(null) 전체 캔들을 쓴다', () => {
  const candles = [
    { t: 1000, h: 50, l: 40 },
    { t: 2000, h: 100, l: 90 },
  ];
  const r = highLowSince(candles, null);
  assert.equal(r.high, 100);
  assert.equal(r.low, 40);
});

test('highLowSince: 빈 배열이면 high/low 둘 다 null', () => {
  const r = highLowSince([], 1000);
  assert.equal(r.high, null);
  assert.equal(r.low, null);
});

test('highLowSince: 진입 이후 봉이 하나도 없으면 null — 전체 기간으로 대체하지 않는다(10/7 ETH 숏 1,689 사고)', () => {
  const candles = [
    { t: 1000, h: 50, l: 40 },
    { t: 2000, h: 60, l: 30 },
  ];
  const r = highLowSince(candles, 9999); // 봉 간격 1000 → 마지막 봉은 3000 에 끝남 < 9999
  assert.equal(r.high, null);
  assert.equal(r.low, null);
});

test('highLowSince: 진입 시각이 속한 봉(아직 진행 중인 오늘 일봉)은 포함한다', () => {
  const D = 86400000;
  const candles = [
    { t: 0, h: 3000, l: 1400 },          // 몇 달 전 같은 옛 봉
    { t: D, h: 2720, l: 2600 },          // 진입 당일 봉
  ];
  const r = highLowSince(candles, D + 11 * 3600000, D);
  assert.equal(r.low, 2600);
  assert.equal(r.high, 2720);
});

// --- structureAgreesWithDirection (롱/숏 대칭 차트 구조 필터) -----------------------

test('structureAgreesWithDirection: 위로 움직였고 가격이 SMA20 위면 — 구조 일치(true)', () => {
  const r = structureAgreesWithDirection('up', { price: 110, sma20: 100, macd: { hist: null } });
  assert.equal(r, true);
});

test('structureAgreesWithDirection: 위로 움직였는데 가격이 SMA20 아래면 — 구조 불일치(false, MACD도 없으면)', () => {
  const r = structureAgreesWithDirection('up', { price: 95, sma20: 100, macd: { hist: null } });
  assert.equal(r, false);
});

test('structureAgreesWithDirection: 아래로 움직였고 가격이 SMA20 아래면 — 구조 일치(대칭 확인, 하락도 똑같이 인정)', () => {
  const r = structureAgreesWithDirection('down', { price: 90, sma20: 100, macd: { hist: null } });
  assert.equal(r, true);
});

test('structureAgreesWithDirection: 아래로 움직였는데 가격이 SMA20 위면 — 구조 불일치', () => {
  const r = structureAgreesWithDirection('down', { price: 105, sma20: 100, macd: { hist: null } });
  assert.equal(r, false);
});

test('structureAgreesWithDirection: MACD 히스토그램만으로도 일치 판단이 된다(상승·하락 둘 다 대칭)', () => {
  assert.equal(structureAgreesWithDirection('up', { macd: { hist: 1.5 } }), true);
  assert.equal(structureAgreesWithDirection('up', { macd: { hist: -1.5 } }), false);
  assert.equal(structureAgreesWithDirection('down', { macd: { hist: -1.5 } }), true);
  assert.equal(structureAgreesWithDirection('down', { macd: { hist: 1.5 } }), false);
});

test('structureAgreesWithDirection: SMA20과 MACD 중 하나만 맞아도 true(둘 다 맞을 필요는 없음)', () => {
  // SMA20은 방향과 어긋나지만(위로 움직였는데 SMA20 아래), MACD는 방향과 일치
  const r = structureAgreesWithDirection('up', { price: 95, sma20: 100, macd: { hist: 2 } });
  assert.equal(r, true);
});

test('structureAgreesWithDirection: 판단 근거가 하나도 없으면(데이터 부족) false — 지어내지 않는다', () => {
  assert.equal(structureAgreesWithDirection('up', {}), false);
  assert.equal(structureAgreesWithDirection('up', null), false);
});

// --- rangePosition / reversalAgreesWithDirection (역추세 후보, 워뇨띠 기록 검증 반영) ---

test('rangePosition: 구간 최저·최고·중간을 정확히 0/100/50으로 계산한다', () => {
  assert.equal(rangePosition(100, 100, 200), 0);
  assert.equal(rangePosition(200, 100, 200), 100);
  assert.equal(rangePosition(150, 100, 200), 50);
});

test('rangePosition: 구간을 벗어난 가격은 0~100으로 눌러 담는다(갭 등으로 구간 밖일 때)', () => {
  assert.equal(rangePosition(50, 100, 200), 0);
  assert.equal(rangePosition(250, 100, 200), 100);
});

test('rangePosition: high<=low나 숫자가 아니면 null(지어내지 않음)', () => {
  assert.equal(rangePosition(150, 200, 100), null);
  assert.equal(rangePosition(150, 100, 100), null);
  assert.equal(rangePosition('x', 100, 200), null);
});

test('reversalAgreesWithDirection: 하락 후 구간 하단(20% 이하)이면 반등 후보로 본다', () => {
  const r = reversalAgreesWithDirection('down', { price: 105, low20: 100, high20: 200 }); // 위치 5%
  assert.equal(r, true);
});

test('reversalAgreesWithDirection: 하락 후 구간 중간이면 반전 후보가 아니다', () => {
  const r = reversalAgreesWithDirection('down', { price: 150, low20: 100, high20: 200 }); // 위치 50%
  assert.equal(r, false);
});

test('reversalAgreesWithDirection: 상승 후 구간 상단(80% 이상)이면 대칭으로 반전 후보다', () => {
  assert.equal(reversalAgreesWithDirection('up', { price: 185, low20: 100, high20: 200 }), true); // 위치 85%
  assert.equal(reversalAgreesWithDirection('up', { price: 150, low20: 100, high20: 200 }), false); // 위치 50%
});

test('reversalAgreesWithDirection: bandPct로 임계값을 조정할 수 있다(20%가 검증된 정답은 아니므로)', () => {
  const ind = { price: 130, low20: 100, high20: 200 }; // 위치 30%
  assert.equal(reversalAgreesWithDirection('down', ind), false); // 기본 20%로는 탈락
  assert.equal(reversalAgreesWithDirection('down', ind, { bandPct: 35 }), true); // 35%로 넓히면 통과
});

test('reversalAgreesWithDirection: 지표가 없으면(데이터 부족) false — 지어내지 않는다', () => {
  assert.equal(reversalAgreesWithDirection('down', null), false);
  assert.equal(reversalAgreesWithDirection('down', {}), false);
});

'use strict';

// Technical-indicator math for the pixel trading floor.
// Input: candles = [{ t, o, h, l, c, v }] ordered oldest -> newest.
// Output: a plain object with price/indicators + Korean summaryLines for prompt injection.
//
// No external dependencies (Node built-ins only).

// --- small helpers -------------------------------------------------------

// Simple moving average of the last `period` values. null if not enough data.
function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

// Exponential moving average series aligned to `values`.
// Seeded at values[0] so every index has a value (robust for short series).
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length);
  let prev = values.length ? values[0] : 0;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI over `period`. null if not enough data.
function wilderRsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// MACD(fast, slow, signal). Returns { macd, signal, hist } using the last value.
function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  if (!Array.isArray(closes) || closes.length === 0) {
    return { macd: 0, signal: 0, hist: 0 };
  }
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = emaSeries(macdLine, signalPeriod);
  const i = closes.length - 1;
  const m = macdLine[i];
  const s = signalLine[i];
  return { macd: m, signal: s, hist: m - s };
}

// Annualized volatility (%) from daily log-ish simple returns.
function volatility(closes) {
  if (!Array.isArray(closes) || closes.length < 2) return 0;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev === 0) continue;
    returns.push((closes[i] - prev) / prev);
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  return std * Math.sqrt(365) * 100;
}

// --- number formatting for the Korean summary ---------------------------

function fmt(n, dp = 2) {
  if (n == null || !Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  if (abs >= 1000) return Math.round(n).toLocaleString('en-US');
  if (abs >= 1) return Number(n.toFixed(dp)).toLocaleString('en-US');
  if (abs >= 0.01) return n.toFixed(4);
  if (abs === 0) return '0';
  return n.toPrecision(4);
}

function signStr(n) {
  return n >= 0 ? '+' : '';
}

// --- main ---------------------------------------------------------------

function computeIndicators(candles) {
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error('computeIndicators: candles가 비어 있습니다');
  }

  const closes = candles.map((c) => Number(c.c));
  const last = candles[candles.length - 1];
  const prev = candles.length >= 2 ? candles[candles.length - 2] : null;

  const price = Number(last.c);
  const changePct24h =
    prev && Number(prev.c) !== 0
      ? ((price - Number(prev.c)) / Number(prev.c)) * 100
      : 0;

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200); // 장기 추세 — 데이터가 200일 미만이면 null(지어내지 않음)
  const rsi14 = wilderRsi(closes, 14);
  const macdObj = macd(closes, 12, 26, 9);

  const recent20 = candles.slice(-20);
  const high20 = Math.max(...recent20.map((c) => Number(c.h)));
  const low20 = Math.min(...recent20.map((c) => Number(c.l)));

  const volatilityPct = volatility(closes);

  // Korean summary lines (~5-6) for prompt injection.
  const rsiTag =
    rsi14 == null ? '데이터 부족' : rsi14 >= 70 ? '과매수' : rsi14 <= 30 ? '과매도' : '중립';
  const smaTrend =
    sma20 == null ? '판단 불가' : price >= sma20 ? 'SMA20 위(강세)' : 'SMA20 아래(약세)';
  const histTag = macdObj.hist >= 0 ? '양(+) 모멘텀' : '음(-) 모멘텀';

  const summaryLines = [
    `현재가 ${fmt(price)} · 전일대비 ${signStr(changePct24h)}${changePct24h.toFixed(2)}%`,
    `SMA20 ${fmt(sma20)} / SMA50 ${fmt(sma50)} — 가격은 ${smaTrend}`,
    `RSI14 ${rsi14 == null ? '-' : rsi14.toFixed(1)} (${rsiTag})`,
    `MACD ${fmt(macdObj.macd, 4)} / 시그널 ${fmt(macdObj.signal, 4)} · 히스토그램 ${histTag}`,
    `최근 20일 고점 ${fmt(high20)} / 저점 ${fmt(low20)} · 연환산 변동성 ${volatilityPct.toFixed(1)}%`,
  ];
  // SMA200(장기 추세)은 데이터가 있을 때만 한 줄 더 — 20일선만으로는 "단기 눌림"과
  // "장기 추세 전환"을 구분할 수 없어, 있으면 반드시 같이 보여준다(없으면 지어내지 않음).
  if (sma200 != null) {
    const longTrend = price >= sma200 ? 'SMA200 위(장기 상승추세)' : 'SMA200 아래(장기 하락추세)';
    const crossTag =
      sma50 != null
        ? sma50 >= sma200
          ? ' · 골든크로스 구간(SMA50>SMA200)'
          : ' · 데드크로스 구간(SMA50<SMA200)'
        : '';
    summaryLines.push(`SMA200 ${fmt(sma200)} — 가격은 ${longTrend}${crossTag}`);
  }

  return {
    price,
    changePct24h,
    sma20,
    sma50,
    sma200,
    rsi14,
    macd: macdObj,
    high20,
    low20,
    volatilityPct,
    summaryLines,
  };
}


// --- 트레일링 스탑(따라가는 손절)용 보조 계산 -------------------------------------
// AI 판단 없이(한도와 무관하게) 매 틱마다 계산할 수 있어야 해서 순수 함수로 분리한다.

// ATR(14) — 일봉 기준 평균 실질 변동폭(true range). 트레일링 스탑의 "여유폭"을 이
// 종목의 평소 변동성에 맞게 정하는 데 쓴다(변동성 큰 종목은 넉넉하게, 안정적인
// 종목은 좁게 — 고정 숫자 하나로 퉁치지 않는다).
function atr14(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = Number(candles[i].h);
    const l = Number(candles[i].l);
    const pc = Number(candles[i - 1].c);
    if (![h, l, pc].every(Number.isFinite)) continue;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (!trs.length) return null;
  const period = Math.min(14, trs.length);
  const recent = trs.slice(-period);
  return recent.reduce((s, v) => s + v, 0) / period;
}

// sinceMs(밀리초 epoch) 이후 캔들의 최고가·최저가 — "진입 이후 가장 유리했던 가격"을
// 구하는 데 쓴다. 캔들에 시각(t)이 없으면 안전하게 전체 캔들을 쓴다(계산 자체가
// 안 되는 것보다, 조금 더 넓게 잡는 쪽이 낫다 — 트레일링 스탑은 보수적으로 굴어야
// 한다: 실수로 손절선이 너무 타이트해지면 정상적인 되돌림에도 쫓겨날 수 있다).
function highLowSince(candles, sinceMs) {
  if (!Array.isArray(candles) || !candles.length) return { high: null, low: null };
  const relevant = Number.isFinite(sinceMs)
    ? candles.filter((c) => !Number.isFinite(Number(c.t)) || Number(c.t) >= sinceMs)
    : candles;
  const pool = relevant.length ? relevant : candles;
  const highs = pool.map((c) => Number(c.h)).filter(Number.isFinite);
  const lows = pool.map((c) => Number(c.l)).filter(Number.isFinite);
  return {
    high: highs.length ? Math.max(...highs) : null,
    low: lows.length ? Math.min(...lows) : null,
  };
}

// --------------------------------------------------------------------------
// 감시 트리거 필터용 — 가격이 위/아래로 움직였을 때, 이평선·MACD 같은 기본적
// 차트 구조가 "그 방향"을 뒷받침하는지 판단한다. 롱/숏 양쪽에 완전히 대칭으로
// 적용한다 — 위로 움직였을 때만 "돌파냐 아니냐"를 보는 게 아니라, 아래로
// 움직였을 때도 똑같은 기준(그 방향으로 SMA20을 이탈했는지, MACD 히스토그램이
// 같은 방향인지)을 그대로 적용한다.
//
// direction: 'up' | 'down'. indicators: computeIndicators()의 결과물.
// 판단 근거가 하나도 없으면(데이터 부족) false — "모르면 걸러내지 않는다"가
// 아니라 "모르면 구조적으로 뒷받침된다고 못 본다"는 보수적 기본값이다(원래
// 순수 가격/거래량 트리거만 있던 시절보다 트리거를 줄이는 게 이 필터의 목적이므로).
function structureAgreesWithDirection(direction, indicators) {
  if (!indicators) return false;
  const isUp = direction === 'up';
  let agrees = false;

  // 조건1: 현재가가 그 방향으로 SMA20 반대편에 있는가(위로 움직였는데 SMA20
  // 위에 있다 / 아래로 움직였는데 SMA20 밑에 있다).
  if (Number.isFinite(indicators.sma20) && Number.isFinite(indicators.price)) {
    const aboveMa = indicators.price > indicators.sma20;
    if (aboveMa === isUp) agrees = true;
  }

  // 조건2: MACD 히스토그램 부호가 같은 방향을 가리키는가.
  const hist = indicators.macd && Number.isFinite(indicators.macd.hist) ? indicators.macd.hist : null;
  if (hist != null) {
    const histUp = hist > 0;
    if (histUp === isUp) agrees = true;
  }

  return agrees;
}

// 진입 시점 가격이 최근 20일 구간(high20~low20) 안에서 몇 % 위치인지. 0=구간 최저,
// 100=구간 최고. 워뇨띠 초기 매매 기록의 시장 데이터 재분석(2026-09-25, 독립 재현
// 검증 완료)에서, 직전 60분 구간의 하위 20%에서 롱·상위 20%에서 숏으로 들어간 305건은
// 승률 78.0%·+6.72 BTC였고, 중간 40~60%에서 들어간 140건은 승률이 더 높은 76.4%인데도
// -1.96 BTC 손실이었다 — 승률만으론 못 보는 차이였다. 우리 시스템은 일봉 지표를 쓰므로
// 같은 개념을 20일 구간으로 적용한다(시간 단위 다름, 그대로 이식 아님).
function rangePosition(price, low, high) {
  const p = Number(price);
  const l = Number(low);
  const h = Number(high);
  if (![p, l, h].every(Number.isFinite) || h <= l) return null;
  const pos = ((p - l) / (h - l)) * 100;
  return Math.round(Math.min(100, Math.max(0, pos)) * 10) / 10;
}

// 역추세(반전) 후보 판단 — structureAgreesWithDirection(추세 추종: SMA20·MACD가 같은
// 방향인지)과는 반대 철학이다. 가격이 최근 구간의 극단(하락 후엔 하단, 상승 후엔 상단)
// 근처에 있으면 반전 가능성이 있는 자리로 본다.
//
// 워뇨띠 기록의 20%·60분 기준은 분석자가 설명을 위해 고른 값이지 검증된 최적값이
// 아니다(보고서 원문의 명시적 경고) — 그래서 그대로 베끼지 않고 기본값만 같게 하고
// opts.bandPct로 조정 가능하게 열어둔다. 이 함수는 "추세 추종이 맞다/역추세가 맞다"를
// 미리 정하지 않는다 — 둘 다 후보를 거르는 용도로 나란히 쓰고, 실제로 어느 쪽이 나은지는
// 결과 판정(candidate-log의 이후 판정)으로 비교한다.
function reversalAgreesWithDirection(direction, indicators, opts) {
  if (!indicators) return false;
  const band = Number.isFinite(Number(opts && opts.bandPct)) ? Number(opts.bandPct) : 20;
  const pos = rangePosition(indicators.price, indicators.low20, indicators.high20);
  if (pos == null) return false;
  return direction === 'down' ? pos <= band : pos >= 100 - band;
}

module.exports = {
  computeIndicators,
  atr14,
  highLowSince,
  structureAgreesWithDirection,
  rangePosition,
  reversalAgreesWithDirection,
};

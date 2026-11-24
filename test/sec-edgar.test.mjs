import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  lookupCik,
  fetchAllRows,
  latestValueFromRows,
  computeTTMFromRows,
  computeRatios,
  buildFundamentalsLines,
  fetchFundamentals,
  _setFetch,
  _resetCache,
} = require('../server/sec-edgar.js');

function jsonResponse(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => obj };
}

// --- latestValueFromRows (시점 스냅샷) ------------------------------------------

test('latestValueFromRows: 연간·분기 구분 없이 end가 가장 늦은 행을 쓴다', () => {
  const rows = [
    { form: '10-K', end: '2024-09-28', val: 100, fy: 2024 },
    { form: '10-Q', end: '2025-03-29', val: 120, fy: 2025 }, // 분기지만 더 최신
  ];
  const r = latestValueFromRows(rows);
  assert.equal(r.value, 120);
  assert.equal(r.form, '10-Q');
});

test('latestValueFromRows: 빈 배열/null이면 null', () => {
  assert.equal(latestValueFromRows([]), null);
  assert.equal(latestValueFromRows(null), null);
});

// --- computeTTMFromRows (기간 합산) ----------------------------------------------

test('computeTTMFromRows: 연간 + 최근분기 + 작년같은분기가 다 있으면 정확히 TTM을 계산한다', () => {
  const rows = [
    { form: '10-K', start: '2023-10-01', end: '2024-09-28', val: 391_035, fy: 2024 }, // 연간(약 364일)
    { form: '10-Q', start: '2023-10-01', end: '2023-12-30', val: 119_575, fy: 2024 }, // 작년 같은 분기(약 90일)
    { form: '10-Q', start: '2024-09-29', end: '2024-12-28', val: 124_300, fy: 2025 }, // 최근 분기(약 90일)
  ];
  const r = computeTTMFromRows(rows);
  assert.equal(r.method, 'ttm');
  assert.equal(r.value, 391_035 + 124_300 - 119_575); // 395,760
  assert.equal(r.asOf, '2024-12-28');
});

test('computeTTMFromRows: 연간 이후 새 분기가 없으면 연간값 그대로(method:annual)', () => {
  const rows = [{ form: '10-K', start: '2023-10-01', end: '2024-09-28', val: 391_035, fy: 2024 }];
  const r = computeTTMFromRows(rows);
  assert.equal(r.method, 'annual');
  assert.equal(r.value, 391_035);
});

test('computeTTMFromRows: 새 분기는 있는데 1년 전 같은 분기를 못 찾으면 정직하게 연간값으로 대체한다', () => {
  const rows = [
    { form: '10-K', start: '2023-10-01', end: '2024-09-28', val: 391_035, fy: 2024 },
    { form: '10-Q', start: '2024-09-29', end: '2024-12-28', val: 124_300, fy: 2025 }, // 비교할 작년 분기 없음
  ];
  const r = computeTTMFromRows(rows);
  assert.equal(r.method, 'annual');
  assert.equal(r.value, 391_035); // 부분 TTM(annual+latestQ만)으로 왜곡하지 않는다
});

test('computeTTMFromRows: 20-F(외국계 기업 연간보고서)도 연간으로 인정한다', () => {
  const rows = [{ form: '20-F', start: '2024-01-01', end: '2024-12-31', val: 5000, fy: 2024 }];
  const r = computeTTMFromRows(rows);
  assert.equal(r.method, 'annual');
  assert.equal(r.form, '20-F');
});

test('computeTTMFromRows: 연간 자체가 없으면(신생 상장사) 최근 분기만이라도 쓴다(method:quarter-only)', () => {
  const rows = [{ form: '10-Q', start: '2025-01-01', end: '2025-03-31', val: 500, fy: 2025 }];
  const r = computeTTMFromRows(rows);
  assert.equal(r.method, 'quarter-only');
  assert.equal(r.value, 500);
});

test('computeTTMFromRows: 6개월·9개월 누적치는 "분기"로 오인하지 않는다(80~100일만 분기로 본다)', () => {
  const rows = [
    { form: '10-K', start: '2023-10-01', end: '2024-09-28', val: 391_035, fy: 2024 },
    { form: '10-Q', start: '2024-09-29', end: '2025-03-29', val: 250_000, fy: 2025 }, // 6개월 누적(약 181일) — 분기 아님
  ];
  const r = computeTTMFromRows(rows);
  // 6개월치가 분기로 잘못 인식되면 method가 'annual'이 아니라 다른 값이 나올 것이다.
  assert.equal(r.method, 'annual');
});

test('computeTTMFromRows: 데이터가 아예 없으면 null', () => {
  assert.equal(computeTTMFromRows([]), null);
  assert.equal(computeTTMFromRows(null), null);
});

test('computeTTMFromRows: start가 없는 행(순수 시점 데이터가 섞여 들어온 경우)은 제외한다', () => {
  const rows = [{ form: '10-K', end: '2024-09-28', val: 391_035, fy: 2024 }]; // start 없음
  assert.equal(computeTTMFromRows(rows), null);
});

// --- fetchAllRows (여러 태그 합치기, 가짜 fetch) ------------------------------------

test('fetchAllRows: 여러 태그의 행을 하나의 배열로 합친다', async () => {
  _setFetch(async (url) => {
    if (url.includes('/TagA.json')) {
      return jsonResponse({ units: { USD: [{ form: '10-K', start: '2017-10-01', end: '2018-09-29', val: 265_595, fy: 2018 }] } });
    }
    if (url.includes('/TagB.json')) {
      return jsonResponse({ units: { USD: [{ form: '10-K', start: '2023-10-01', end: '2024-09-28', val: 391_035, fy: 2024 }] } });
    }
    return jsonResponse({}, 404);
  });
  const rows = await fetchAllRows('0000320193', [
    { taxonomy: 'us-gaap', tag: 'TagA', unit: 'USD' },
    { taxonomy: 'us-gaap', tag: 'TagB', unit: 'USD' },
  ]);
  _setFetch(null);
  assert.equal(rows.length, 2);
});

test('fetchAllRows: 태그 하나가 실패해도(404) 나머지는 계속 모은다', async () => {
  _setFetch(async (url) => {
    if (url.includes('/Missing.json')) return jsonResponse({}, 404);
    return jsonResponse({ units: { USD: [{ form: '10-K', start: '2023-10-01', end: '2024-09-28', val: 100, fy: 2024 }] } });
  });
  const rows = await fetchAllRows('0000320193', [
    { taxonomy: 'us-gaap', tag: 'Missing', unit: 'USD' },
    { taxonomy: 'us-gaap', tag: 'Found', unit: 'USD' },
  ]);
  _setFetch(null);
  assert.equal(rows.length, 1);
});

test('fetchAllRows: 실전에서 애플 매출이 2018년으로 멈춰 나오던 버그의 회귀 방지 — 태그를 합쳐서 TTM을 계산하면 최신 데이터가 반영된다', async () => {
  _setFetch(async (url) => {
    if (url.includes('Revenues.json')) {
      // 옛 태그 — 2019년 회계기준 변경 전까지만 데이터가 있다.
      return jsonResponse({
        units: {
          USD: [{ form: '10-K', start: '2017-10-01', end: '2018-09-29', val: 265_595, fy: 2018 }],
        },
      });
    }
    if (url.includes('RevenueFromContractWithCustomerExcludingAssessedTax.json')) {
      // 새 태그 — 최신 데이터
      return jsonResponse({
        units: {
          USD: [{ form: '10-K', start: '2023-10-01', end: '2024-09-28', val: 391_035, fy: 2024 }],
        },
      });
    }
    return jsonResponse({}, 404);
  });
  const rows = await fetchAllRows('0000320193', [
    { taxonomy: 'us-gaap', tag: 'Revenues', unit: 'USD' },
    { taxonomy: 'us-gaap', tag: 'RevenueFromContractWithCustomerExcludingAssessedTax', unit: 'USD' },
  ]);
  const ttm = computeTTMFromRows(rows);
  _setFetch(null);
  assert.equal(ttm.value, 391_035); // 2018년(265,595)이 아니라 2024년 최신 데이터
  assert.equal(ttm.asOf, '2024-09-28');
});

// --- computeRatios (순수 함수) -----------------------------------------------

test('computeRatios: 정상 입력이면 8개 지표를 전부 계산한다', () => {
  const r = computeRatios({
    price: 200,
    revenue: 1_000_000,
    netIncome: 100_000,
    stockholdersEquity: 500_000,
    assetsCurrent: 300_000,
    liabilities: 400_000,
    liabilitiesCurrent: 150_000,
    eps: 5,
    sharesOutstanding: 10_000,
    dividendPerShare: 2,
  });
  assert.equal(r.marketCap, 2_000_000);
  assert.equal(r.per, 40);
  assert.equal(r.pbr, 4);
  assert.equal(r.psr, 2);
  assert.equal(r.roe, 20);
  assert.equal(r.dividendYield, 1);
  assert.equal(r.debtRatio, 80);
  assert.equal(r.currentRatio, 200);
});

test('computeRatios: EPS가 0이면 PER은 null(0으로 나누지 않는다)', () => {
  const r = computeRatios({ price: 100, eps: 0, sharesOutstanding: 100 });
  assert.equal(r.per, null);
});

test('computeRatios: 자기자본이 0이면 ROE·PBR·부채비율 전부 null', () => {
  const r = computeRatios({ price: 100, netIncome: 50, stockholdersEquity: 0, sharesOutstanding: 100, liabilities: 200 });
  assert.equal(r.roe, null);
  assert.equal(r.pbr, null);
  assert.equal(r.debtRatio, null);
});

test('computeRatios: 필요한 입력이 일부만 있어도 계산 가능한 것끼리는 계산한다', () => {
  const r = computeRatios({ price: 100, sharesOutstanding: 1000 });
  assert.equal(r.marketCap, 100_000);
  assert.equal(r.per, null);
  assert.equal(r.roe, null);
});

test('computeRatios: 입력이 아예 없으면 전부 null(에러 안 던짐)', () => {
  const r = computeRatios();
  assert.equal(r.marketCap, null);
  assert.equal(r.per, null);
  assert.equal(r.currentRatio, null);
});

test('computeRatios: 가격이 음수/0이면 가격 관련 지표는 계산하지 않는다', () => {
  const r = computeRatios({ price: 0, eps: 5, sharesOutstanding: 100, stockholdersEquity: 1000 });
  assert.equal(r.per, null);
  assert.equal(r.marketCap, null);
});

// --- buildFundamentalsLines ---------------------------------------------------

test('buildFundamentalsLines: 값이 있으면 그대로, 없으면 "데이터 없음"으로 표시한다', () => {
  const lines = buildFundamentalsLines({
    ratios: { marketCap: 2_000_000_000, per: 40, pbr: null, psr: 2, roe: 20, dividendYield: null, debtRatio: 80, currentRatio: 200 },
    raw: { revenue: 1_000_000, netIncome: 100_000, eps: 5, asOf: '2024-12-28', method: 'ttm', form: '10-Q' },
  });
  const joined = lines.join('\n');
  assert.match(joined, /PER 40배/);
  assert.match(joined, /PBR 데이터 없음/);
  assert.match(joined, /매출\(TTM\)/);
  assert.match(joined, /최근 12개월 합산\(TTM\)/);
  assert.match(joined, /2024-12-28/);
});

test('buildFundamentalsLines: 연간으로 대체됐으면 그 방식이 그대로 라벨에 나온다', () => {
  const lines = buildFundamentalsLines({ ratios: {}, raw: { asOf: '2024-09-28', method: 'annual', form: '10-K' } });
  assert.match(lines.join('\n'), /최근 연간 공시/);
});

// --- lookupCik (가짜 fetch) ---------------------------------------------------

test('lookupCik: 티커 대소문자 무관하게 CIK를 찾고 10자리로 0-패딩한다', async () => {
  _resetCache();
  _setFetch(async () => jsonResponse({ '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } }));
  const cik = await lookupCik('aapl');
  _setFetch(null);
  assert.equal(cik, '0000320193');
});

test('lookupCik: 없는 티커면 null(에러 안 던짐)', async () => {
  _resetCache();
  _setFetch(async () => jsonResponse({ '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } }));
  const cik = await lookupCik('NOPE_NOT_REAL');
  _setFetch(null);
  assert.equal(cik, null);
});

// --- fetchFundamentals (전체 오케스트레이션, 가짜 fetch) -----------------------

test('fetchFundamentals: CIK를 못 찾으면 ok:false와 명확한 사유', async () => {
  _resetCache();
  _setFetch(async () => jsonResponse({ '0': { cik_str: 1, ticker: 'ZZZZ', title: 'x' } }));
  const r = await fetchFundamentals('NOTREAL', 100);
  _setFetch(null);
  assert.equal(r.ok, false);
  assert.match(r.error, /찾지 못했습니다/);
});

test('fetchFundamentals: 정상 흐름 — TTM 매출·순이익으로 EPS를 직접 계산하고 PER까지 나온다', async () => {
  _resetCache();
  _setFetch(async (url) => {
    if (url.includes('company_tickers.json')) {
      return jsonResponse({ '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' } });
    }
    if (url.includes('/Revenues.json') || url.includes('/NetIncomeLoss.json')) {
      // 연간만 있고 그 이후 분기는 없다고 가정 — TTM이 연간값으로 떨어지는 단순 케이스.
      const val = url.includes('NetIncomeLoss') ? 93_736 : 391_035;
      return jsonResponse({ units: { USD: [{ form: '10-K', start: '2023-10-01', end: '2024-09-28', val, fy: 2024 }] } });
    }
    if (url.includes('/EntityCommonStockSharesOutstanding.json')) {
      return jsonResponse({ units: { shares: [{ form: '10-K', end: '2024-09-28', val: 15_000_000, fy: 2024 }] } });
    }
    return jsonResponse({}, 404);
  });
  const r = await fetchFundamentals('AAPL', 200);
  _setFetch(null);
  assert.equal(r.ok, true);
  assert.equal(r.raw.revenue, 391_035);
  assert.equal(r.raw.netIncome, 93_736);
  // EPS = TTM 순이익 / 발행주식수
  assert.equal(r.raw.eps, 93_736 / 15_000_000);
  assert.equal(r.ratios.marketCap, 200 * 15_000_000);
  assert.ok(Array.isArray(r.lines) && r.lines.length > 0);
});

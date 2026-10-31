'use strict';

// sec-edgar.js — SEC EDGAR(미국 증권거래위원회) 공식 API로 재무제표 원본 데이터를 가져와
// 투자지표(PER·PBR·ROE·PSR·배당수익률)와 안정성 지표(부채비율·유동비율)를 계산한다.
//
// 왜 야후 파이낸스 quoteSummary가 아니라 이걸 쓰는가
// - quoteSummary(PER·PBR 등을 직접 제공하는 엔드포인트)는 2026년 기준 쿠키+보안토큰
//   인증이 필요해졌고, 요청 제한·차단이 잦다. SEC EDGAR는 API 키·인증 없이 무료이고
//   (User-Agent 헤더만 요구), 요청 제한도 넉넉하다(초당 10건).
// - 대신 "PER 45배" 같은 완성된 숫자를 안 준다 — 원본 재무제표 수치(매출·순이익·자기자본
//   등)를 주고, 비율은 우리가 직접 계산한다. 그래서 이 파일에 계산 로직이 들어있다.
// - 미국 상장사만 대상이다(SEC 관할). 한국 주식·크립토는 이 모듈을 안 쓴다.
//
// 두 종류의 재무 수치를 다르게 다룬다
// - "시점 스냅샷"(자기자본·유동자산·부채·발행주식수): 연간이든 분기든 그냥 가장 최신
//   공시를 쓴다 — 시점 데이터라 "연간"을 고집할 이유가 없다.
// - "기간 합산"(매출·순이익·배당): 표준 관행대로 최근 12개월 합산(TTM)을 계산한다.
//   TTM = 최근 연간 + 최근 분기 − 1년 전 같은 분기. 비교할 분기를 못 찾으면 정직하게
//   연간값으로 대체한다(지어낸 절반짜리 TTM보다 낫다). EPS는 따로 안 가져오고
//   TTM 순이익 ÷ 최신 발행주식수로 직접 계산한다(XBRL의 EPS는 기간별 가중평균
//   주식수를 쓰기 때문에, 단순히 더하고 빼는 TTM 합산이 부정확해질 수 있어서다).
//
// 원칙
// - 외부 npm 의존성 0. Node 내장 fetch만 쓴다.
// - 회사마다 XBRL 태그명이 다를 수 있어(예: 애플이 2019년 매출 인식 기준 변경으로
//   Revenues → RevenueFromContractWithCustomerExcludingAssessedTax로 전환한 것처럼)
//   지표마다 여러 태그를 시도하고, 그 결과를 전부 합쳐서 가장 최신 데이터를 쓴다.
//   (한 태그에서 "성공"했다고 바로 멈추면, 그 태그가 옛날에 멈춘 태그일 수 있다 —
//   실전에서 애플 매출이 2018년 데이터로 멈춰 나오던 사례로 이미 한 번 확인됐다.)
// - 데이터를 못 찾으면 지어내지 않는다 — 그 지표는 null로 남는다.

const SEC_BASE = 'https://data.sec.gov';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
// SEC는 User-Agent에 연락처를 넣어달라고 명시적으로 요청한다(익명 트래픽 남용 방지 목적).
const USER_AGENT = 'PixelTradingFloor research-tool contact: not-provided@example.com';

let fetchImpl = (...args) => fetch(...args);
function _setFetch(fn) {
  fetchImpl = typeof fn === 'function' ? fn : (...args) => fetch(...args);
}

async function doFetch(url) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) {
    const err = new Error(`SEC EDGAR 요청 실패: ${url} → HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// --------------------------------------------------------------------------
// CIK(SEC 고유 기업번호) 조회 — 티커 → CIK. 회사 목록 파일이 커서(전체 상장사) 24시간
// 정도는 메모리에 캐시해둔다(요청마다 새로 받으면 낭비이고, SEC 요청 예의에도 어긋난다).
// --------------------------------------------------------------------------

let _tickerCache = null; // { byTicker: Map, fetchedAt: number }
const TICKER_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// 테스트 전용 — 티커 캐시를 비운다(테스트마다 가짜 fetch 응답이 실제로 쓰이는지 보장).
function _resetCache() {
  _tickerCache = null;
}

async function _loadTickerMap() {
  if (_tickerCache && Date.now() - _tickerCache.fetchedAt < TICKER_CACHE_TTL_MS) {
    return _tickerCache.byTicker;
  }
  const data = await doFetch(TICKERS_URL);
  const byTicker = new Map();
  for (const key of Object.keys(data || {})) {
    const row = data[key];
    if (!row || typeof row.ticker !== 'string') continue;
    byTicker.set(row.ticker.toUpperCase(), String(row.cik_str).padStart(10, '0'));
  }
  _tickerCache = { byTicker, fetchedAt: Date.now() };
  return byTicker;
}

async function lookupCik(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) return null;
  const map = await _loadTickerMap();
  return map.get(t) || null;
}

// --------------------------------------------------------------------------
// 개별 재무 항목(concept) 조회 — 후보 태그를 전부 시도해서 원본 행(row)을 그러모은다.
// --------------------------------------------------------------------------

async function fetchConcept(cik, taxonomy, tag) {
  const url = `${SEC_BASE}/api/xbrl/companyconcept/CIK${cik}/${taxonomy}/${tag}.json`;
  return doFetch(url);
}

// candidates의 태그를 전부 시도해서, 값 있는 행(row)을 전부 하나의 배열로 합친다.
// 태그 하나에서 실패해도(404 등) 나머지는 계속 시도한다 — 전부 실패하면 빈 배열.
// candidates: [{ taxonomy: 'us-gaap', tag: 'Revenues', unit: 'USD' }, ...] (한 개념에
// 대한 여러 태그 후보는 전부 같은 unit을 쓴다고 가정한다)
async function fetchAllRows(cik, candidates) {
  const all = [];
  for (const c of candidates) {
    try {
      const json = await fetchConcept(cik, c.taxonomy, c.tag);
      const rows = json && json.units && Array.isArray(json.units[c.unit]) ? json.units[c.unit] : [];
      for (const r of rows) {
        if (r && r.val != null && r.end) all.push(r);
      }
    } catch (e) {
      continue;
    }
  }
  return all;
}

// --------------------------------------------------------------------------
// 시점 스냅샷 값 — 연간·분기 구분 없이 가장 최신(end가 가장 늦은) 행을 쓴다.
// 자기자본·유동자산·부채·발행주식수처럼 "특정 시점의 값"에 쓴다.
// --------------------------------------------------------------------------

function latestValueFromRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const best = rows.reduce((b, r) => (!b || String(r.end) > String(b.end) ? r : b), null);
  if (!best) return null;
  return { value: Number(best.val), fiscalYear: best.fy || null, period: best.end, form: best.form || null };
}

// --------------------------------------------------------------------------
// TTM(최근 12개월 합산) — 매출·순이익·배당처럼 "기간에 걸친 값"에 쓴다.
// 공식: TTM = 최근 연간 + 최근 분기(3개월) − 1년 전 같은 분기(3개월)
// 필요한 조각을 못 찾으면 단계적으로 정직하게 대체한다(지어내지 않는다):
//   1) 연간 이후 새 분기가 없다 → 연간값 그대로(연간 자체가 이미 최신 12개월이다)
//   2) 비교할 1년 전 같은 분기를 못 찾는다 → 연간값으로 대체(부분 TTM은 왜곡을 만든다)
//   3) 연간 자체가 없다 → 가장 최신 분기(3개월) 값이라도(그것도 없으면 null)
// --------------------------------------------------------------------------

const ANNUAL_FORMS = ['10-K', '20-F'];
const DAY_MS = 24 * 60 * 60 * 1000;

function durationDays(row) {
  if (!row || !row.start || !row.end) return null;
  return (new Date(row.end) - new Date(row.start)) / DAY_MS;
}

function isQuarterRow(row) {
  const d = durationDays(row);
  return d != null && d >= 80 && d <= 100;
}

function isAnnualDurationRow(row) {
  const d = durationDays(row);
  return d != null && d >= 340 && d <= 380;
}

function pickLatestBy(arr, dateField = 'end') {
  return arr.reduce((b, r) => (!b || String(r[dateField]) > String(b[dateField]) ? r : b), null);
}

function computeTTMFromRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return null;
  const clean = rows.filter((r) => r && r.val != null && r.end && r.start);
  if (!clean.length) return null;

  const annualRows = clean.filter((r) => ANNUAL_FORMS.includes(r.form) && isAnnualDurationRow(r));
  const annual = pickLatestBy(annualRows);
  const quarterRows = clean.filter((r) => r.form === '10-Q' && isQuarterRow(r));

  if (!annual) {
    // 연간 자체가 없다 — 가장 최신 분기라도 쓴다(있으면). 이건 진짜 TTM이 아니라
    // "최근 3개월"이라는 걸 method로 명시한다 — 호출부가 오해하지 않게.
    const latestQOnly = pickLatestBy(quarterRows);
    if (!latestQOnly) return null;
    return {
      value: Number(latestQOnly.val),
      method: 'quarter-only',
      asOf: latestQOnly.end,
      fiscalYear: latestQOnly.fy || null,
      form: latestQOnly.form,
    };
  }

  const newerQuarters = quarterRows.filter((r) => String(r.end) > String(annual.end));
  const latestQ = pickLatestBy(newerQuarters);

  if (!latestQ) {
    // 연간 이후 새 분기가 없다 — 연간 자체가 이미 최신 12개월이다.
    return { value: Number(annual.val), method: 'annual', asOf: annual.end, fiscalYear: annual.fy || null, form: annual.form };
  }

  // 1년 전 같은 분기(±20일 오차 허용 — 회계연도 마감일이 매년 정확히 같은 날은 아니다).
  const oneYearBefore = new Date(new Date(latestQ.end).getTime());
  oneYearBefore.setFullYear(oneYearBefore.getFullYear() - 1);
  const sameQPriorYear = pickLatestBy(
    quarterRows.filter((r) => Math.abs(new Date(r.end).getTime() - oneYearBefore.getTime()) <= 20 * DAY_MS)
  );

  if (!sameQPriorYear) {
    // 비교할 작년 같은 분기가 없다 — 정직하게 연간값으로 대체한다.
    return { value: Number(annual.val), method: 'annual', asOf: annual.end, fiscalYear: annual.fy || null, form: annual.form };
  }

  const ttmValue = Number(annual.val) + Number(latestQ.val) - Number(sameQPriorYear.val);
  return { value: ttmValue, method: 'ttm', asOf: latestQ.end, fiscalYear: latestQ.fy || null, form: latestQ.form };
}

// --------------------------------------------------------------------------
// 비율 계산 — 순수 함수. SEC 원본 수치 + 현재가(다른 데이터소스에서 이미 조회한 값)를
// 조합해서 계산한다. 필요한 입력이 없으면 그 비율만 null(있는 것끼리는 최대한 계산).
// --------------------------------------------------------------------------

function round2(n) {
  return Math.round(n * 100) / 100;
}

function computeRatios({
  price,
  revenue,
  netIncome,
  stockholdersEquity,
  assetsCurrent,
  liabilities,
  liabilitiesCurrent,
  eps,
  sharesOutstanding,
  dividendPerShare,
} = {}) {
  const p = Number(price);
  const priceOk = Number.isFinite(p) && p > 0;
  const shares = Number(sharesOutstanding);
  const sharesOk = Number.isFinite(shares) && shares > 0;
  const equity = Number(stockholdersEquity);
  const equityOk = Number.isFinite(equity) && equity !== 0;

  const out = {
    marketCap: null,
    per: null,
    pbr: null,
    psr: null,
    roe: null,
    dividendYield: null,
    debtRatio: null,
    currentRatio: null,
  };

  if (priceOk && sharesOk) out.marketCap = round2(p * shares);

  const epsN = Number(eps);
  if (priceOk && Number.isFinite(epsN) && epsN !== 0) out.per = round2(p / epsN);

  if (priceOk && sharesOk && equityOk) {
    const bookValuePerShare = equity / shares;
    if (bookValuePerShare !== 0) out.pbr = round2(p / bookValuePerShare);
  }

  const revN = Number(revenue);
  if (out.marketCap != null && Number.isFinite(revN) && revN > 0) {
    out.psr = round2(out.marketCap / revN);
  }

  const niN = Number(netIncome);
  if (Number.isFinite(niN) && equityOk) out.roe = round2((niN / equity) * 100);

  const divN = Number(dividendPerShare);
  if (priceOk && Number.isFinite(divN) && divN >= 0) out.dividendYield = round2((divN / p) * 100);

  const liabN = Number(liabilities);
  if (Number.isFinite(liabN) && equityOk) out.debtRatio = round2((liabN / equity) * 100);

  const acN = Number(assetsCurrent);
  const lcN = Number(liabilitiesCurrent);
  if (Number.isFinite(acN) && Number.isFinite(lcN) && lcN !== 0) {
    out.currentRatio = round2((acN / lcN) * 100);
  }

  return out;
}

// --------------------------------------------------------------------------
// 한국어 요약 줄 — market.js의 fundamentals.lines 배열에 그대로 이어붙일 수 있는 형태.
// --------------------------------------------------------------------------

function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return '데이터 없음';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  return n.toLocaleString('en-US');
}

function fmtPct(n) {
  return n == null ? '데이터 없음' : `${n}%`;
}

function fmtX(n) {
  return n == null ? '데이터 없음' : `${n}배`;
}

const METHOD_LABEL = {
  ttm: '최근 12개월 합산(TTM)',
  annual: '최근 연간 공시',
  'quarter-only': '최근 분기(3개월) — 연간 공시 없음',
};

function buildFundamentalsLines({ ratios, raw } = {}) {
  const r = ratios || {};
  const d = raw || {};
  const lines = [];
  lines.push(
    `[SEC] 시가총액 ${fmtNum(r.marketCap)} · PER ${fmtX(r.per)} · PBR ${fmtX(r.pbr)} · PSR ${fmtX(r.psr)}`
  );
  lines.push(`ROE ${fmtPct(r.roe)} · 배당수익률 ${fmtPct(r.dividendYield)}`);
  lines.push(
    `매출(TTM) ${fmtNum(d.revenue)} · 순이익(TTM) ${fmtNum(d.netIncome)} · EPS ${
      d.eps == null ? '데이터 없음' : round2(d.eps)
    }`
  );
  lines.push(`부채비율 ${fmtPct(r.debtRatio)} · 유동비율 ${fmtPct(r.currentRatio)}`);
  if (d.asOf) {
    const methodLabel = METHOD_LABEL[d.method] || d.method || '';
    lines.push(`(SEC 공시 기준: ${methodLabel}, ${d.asOf}${d.form ? ` · ${d.form}` : ''})`);
  }
  return lines;
}

// --------------------------------------------------------------------------
// 오케스트레이션 — 티커 하나와 현재가를 받아 전체 파이프라인을 돈다.
// --------------------------------------------------------------------------

// 시점 스냅샷 개념(연간/분기 구분 없이 최신값)
const INSTANT_CONCEPTS = {
  stockholdersEquity: [{ taxonomy: 'us-gaap', tag: 'StockholdersEquity', unit: 'USD' }],
  assetsCurrent: [{ taxonomy: 'us-gaap', tag: 'AssetsCurrent', unit: 'USD' }],
  liabilities: [{ taxonomy: 'us-gaap', tag: 'Liabilities', unit: 'USD' }],
  liabilitiesCurrent: [{ taxonomy: 'us-gaap', tag: 'LiabilitiesCurrent', unit: 'USD' }],
  sharesOutstanding: [
    { taxonomy: 'dei', tag: 'EntityCommonStockSharesOutstanding', unit: 'shares' },
    { taxonomy: 'us-gaap', tag: 'CommonStockSharesOutstanding', unit: 'shares' },
  ],
};

// 기간 합산 개념(TTM 계산 대상)
const TTM_CONCEPTS = {
  revenue: [
    { taxonomy: 'us-gaap', tag: 'Revenues', unit: 'USD' },
    { taxonomy: 'us-gaap', tag: 'RevenueFromContractWithCustomerExcludingAssessedTax', unit: 'USD' },
    { taxonomy: 'us-gaap', tag: 'SalesRevenueNet', unit: 'USD' },
  ],
  netIncome: [{ taxonomy: 'us-gaap', tag: 'NetIncomeLoss', unit: 'USD' }],
  dividendPerShare: [
    { taxonomy: 'us-gaap', tag: 'CommonStockDividendsPerShareDeclared', unit: 'USD/shares' },
    { taxonomy: 'us-gaap', tag: 'CommonStockDividendsPerShareCashPaid', unit: 'USD/shares' },
  ],
};

async function fetchFundamentals(ticker, price) {
  const cik = await lookupCik(ticker);
  if (!cik) return { ok: false, error: `SEC에서 티커를 찾지 못했습니다: ${ticker}` };

  const instantKeys = Object.keys(INSTANT_CONCEPTS);
  const ttmKeys = Object.keys(TTM_CONCEPTS);

  const [instantSettled, ttmSettled] = await Promise.all([
    Promise.allSettled(instantKeys.map((k) => fetchAllRows(cik, INSTANT_CONCEPTS[k]))),
    Promise.allSettled(ttmKeys.map((k) => fetchAllRows(cik, TTM_CONCEPTS[k]))),
  ]);

  const raw = {};
  instantKeys.forEach((k, i) => {
    const r = instantSettled[i];
    const rows = r.status === 'fulfilled' ? r.value : [];
    const picked = latestValueFromRows(rows);
    raw[k] = picked ? picked.value : null;
  });

  ttmKeys.forEach((k, i) => {
    const r = ttmSettled[i];
    const rows = r.status === 'fulfilled' ? r.value : [];
    const picked = computeTTMFromRows(rows);
    raw[k] = picked ? picked.value : null;
    // 대표로 매출(revenue)의 산출 방식·기준일을 요약에 쓴다 — 지표마다 따로 표시하면 지저분하다.
    if (k === 'revenue' && picked) {
      raw.asOf = picked.asOf;
      raw.method = picked.method;
      raw.form = picked.form;
      raw.fiscalYear = picked.fiscalYear;
    }
  });

  // EPS는 따로 안 받고 TTM 순이익 ÷ 최신 발행주식수로 직접 계산한다(이유는 파일 상단 설명).
  raw.eps =
    raw.netIncome != null && raw.sharesOutstanding != null && raw.sharesOutstanding !== 0
      ? raw.netIncome / raw.sharesOutstanding
      : null;

  const ratios = computeRatios({
    price,
    revenue: raw.revenue,
    netIncome: raw.netIncome,
    stockholdersEquity: raw.stockholdersEquity,
    assetsCurrent: raw.assetsCurrent,
    liabilities: raw.liabilities,
    liabilitiesCurrent: raw.liabilitiesCurrent,
    eps: raw.eps,
    sharesOutstanding: raw.sharesOutstanding,
    dividendPerShare: raw.dividendPerShare,
  });

  return { ok: true, cik, raw, ratios, lines: buildFundamentalsLines({ ratios, raw }) };
}

module.exports = {
  lookupCik,
  fetchConcept,
  fetchAllRows,
  latestValueFromRows,
  computeTTMFromRows,
  computeRatios,
  buildFundamentalsLines,
  fetchFundamentals,
  _setFetch,
  _resetCache,
};

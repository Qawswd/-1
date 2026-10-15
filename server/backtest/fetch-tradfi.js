'use strict';

// fetch-tradfi.js — 바이낸스에 상장된 미국 주식·지수 ETF 무기한(TRADIFI_PERPETUAL)의 긴 일봉(Yahoo)과 실측 펀딩을 받는다
// (2026-10-15, 2차 탐색 L — docs/07-RESEARCH-PROTOCOL.md). 공개 시세만, 키·주문 없음.
// 종목 규칙(오너 2026-10-15): 미국 주식·ETF 만. 원자재·한국 주식·비상장·레버리지 ETF 는 뺀다.
// 바이낸스 기호를 그대로 Yahoo 기호로 쓴다(다른 것만 YAHOO 표). Yahoo 가 알려주는 종목 정보로 미국 상장 주식·ETF 인지 확인하고
// (달러 · 미국 거래소 · 레버리지/인버스·코인·원자재 ETF 아님), 바이낸스 현재가와 15% 넘게 다르면 다른 종목으로 보고 뺀다.
// 2026-10-15 서버 실행: 거래 중 221개. 처음엔 아는 15개만 썼는데, 지금 인기 종목만 모여 결과가 부풀었을 수 있어 넓힌다(docs/07 2차 L).
// 저장: reports/backtest/data/tradfi/<YAHOO>-1d.csv + meta.json
//   node server/backtest/fetch-tradfi.js

const fs = require('fs');
const path = require('path');
const { fetchYahooDaily, toCsv } = require('./fetch-stocks');
const { fundingSummary } = require('../../ops/tradfi-check');

const FAPI = 'https://fapi.binance.com';
const OUT_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data', 'tradfi');
const YAHOO = Object.freeze({ BRKB: 'BRK-B' });
const EXCLUDE = Object.freeze({
  XAU: '원자재', XAG: '원자재', XPD: '원자재', XPT: '원자재', COPPER: '원자재', CL: '원자재', BZ: '원자재', NATGAS: '원자재',
  SKHYNIX: '한국 주식', SAMSUNG: '한국 주식', HYUNDAI: '한국 주식', SAMSUNGEM: '한국 주식', HANMI: '한국 주식', NAVER: '한국 주식',
  LGELECTRONICS: '한국 주식', KODEX200: '한국 주식',
  HK0700: '홍콩·중국 주식', HK1810: '홍콩·중국 주식', HK0625: '홍콩·중국 주식', HK0992: '홍콩·중국 주식', TENCENT: '홍콩·중국 주식',
  KUAISHOU: '홍콩·중국 주식', MEITUAN: '홍콩·중국 주식', POPMART: '홍콩·중국 주식', ZHONGJI: '홍콩·중국 주식', CXMT: '홍콩·중국 주식',
  UNITREE: '홍콩·중국 주식', MINIMAX: '홍콩·중국 주식', ZHIPU: '홍콩·중국 주식', GIGADEV: '홍콩·중국 주식', BYD: '홍콩·중국 주식',
  OPENAI: '비상장', ANTHROPIC: '비상장', SPCX: '비상장', SPCXUSD1: '비상장', MOONSHOT: '비상장',
  USDBRL: '환율', USDEX: '환율', BITO: '코인 ETF',
  SOXL: '레버리지 ETF', SOXS: '레버리지 ETF', KORU: '레버리지 ETF', TQQQ: '레버리지 ETF', SQQQ: '레버리지 ETF', TZA: '레버리지 ETF',
  TMF: '레버리지 ETF', TBT: '레버리지 ETF', NVDL: '레버리지 ETF', TSLL: '레버리지 ETF', MSTU: '레버리지 ETF', MUU: '레버리지 ETF',
  SKUU: '레버리지 ETF', SKDD: '레버리지 ETF', UVXY: '레버리지 ETF', CSOPSKHYNIX2L: '레버리지 ETF', CSOPSAMSUNG2L: '레버리지 ETF',
});
const US_EXCHANGES = new Set(['NMS', 'NGM', 'NCM', 'NAS', 'NYQ', 'NYS', 'ASE', 'PCX', 'BTS']);

// Yahoo 종목 정보 → null(쓸 수 있음) 또는 뺀 이유
function classifyYahoo(meta) {
  if (!meta) return 'Yahoo 에 없음';
  const name = `${meta.longName || ''} ${meta.shortName || ''}`;
  if (meta.currency !== 'USD') return `달러 아님(${meta.currency || '-'})`;
  if (!US_EXCHANGES.has(meta.exchangeName)) return `미국 거래소 아님(${meta.exchangeName || '-'})`;
  if (!['EQUITY', 'ETF'].includes(meta.instrumentType)) return `주식·ETF 아님(${meta.instrumentType || '-'})`;
  if (/\b(1\.5x|2x|3x|-1x|-2x|-3x|ultra|ultrapro|ultrashort|bull|bear|leveraged|inverse|daily target)\b/i.test(name)) return '레버리지·인버스';
  if (meta.instrumentType === 'ETF') {
    if (/\bshort\b/i.test(name)) return '인버스 ETF';
    if (/bitcoin|ether|crypto/i.test(name)) return '코인 ETF';
    if (/\b(gold|silver|oil|natural gas|commodity|platinum|palladium)\b/i.test(name) && !/miners?\b/i.test(name)) return '원자재 ETF';
  }
  return null;
}

// exchangeInfo → [{ symbol, base, yahoo|null, reason|null }] — 거래 중인 TRADIFI 무기한만
function pickTradfi(info) {
  return ((info && info.symbols) || [])
    .filter((s) => /TRADIFI/i.test(String(s.contractType || '')) && s.status === 'TRADING')
    .map((s) => {
      const base = String(s.symbol).replace(/USDT$/, '');
      if (EXCLUDE[base]) return { symbol: s.symbol, base, yahoo: null, reason: EXCLUDE[base] };
      return { symbol: s.symbol, base, yahoo: YAHOO[base] || base, reason: null };
    });
}

function priceMatches(mark, lastClose, tol = 0.15) {
  return Number(mark) > 0 && Number(lastClose) > 0 && Math.abs(Number(mark) / Number(lastClose) - 1) <= tol;
}

async function json(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function yahooMeta(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; trading-floor-backtest)', Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  const d = await res.json();
  return (d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta) || null;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const list = pickTradfi(await json(`${FAPI}/fapi/v1/exchangeInfo`));
  console.log(`바이낸스 주식·지수 무기한 ${list.length}개`);
  const meta = [];
  for (const x of list) {
    if (!x.yahoo) {
      console.log(`${x.base}: 제외 — ${x.reason}`);
      meta.push({ binance: x.base, ok: false, reason: x.reason });
      continue;
    }
    try {
      const ym = await yahooMeta(x.yahoo);
      const why = classifyYahoo(ym);
      if (why) {
        console.log(`${x.base}: 제외 — ${why}${ym && ym.longName ? ` (${ym.longName})` : ''}`);
        meta.push({ binance: x.base, yahoo: x.yahoo, ok: false, reason: why });
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      const mark = Number((await json(`${FAPI}/fapi/v1/premiumIndex?symbol=${x.symbol}`)).markPrice);
      if (!priceMatches(mark, ym.regularMarketPrice)) {
        console.log(`${x.base}: 제외 — 바이낸스 ${mark} ≠ Yahoo ${x.yahoo} ${ym.regularMarketPrice} (다른 종목일 수 있음)`);
        meta.push({ binance: x.base, yahoo: x.yahoo, ok: false, reason: '가격 불일치' });
        continue;
      }
      const rows = await fetchYahooDaily(x.yahoo, 2015);
      const f = fundingSummary(await json(`${FAPI}/fapi/v1/fundingRate?symbol=${x.symbol}&limit=1000`));
      fs.writeFileSync(path.join(OUT_DIR, `${x.yahoo}-1d.csv`), toCsv(rows));
      const m = {
        binance: x.base, yahoo: x.yahoo, ok: true, type: ym.instrumentType, name: ym.longName || ym.shortName || null, rows: rows.length,
        from: new Date(rows[0].t).toISOString().slice(0, 10), to: new Date(rows[rows.length - 1].t).toISOString().slice(0, 10),
        fundingAnnualPct: f ? f.annualLongCostPct : null, fundingFrom: f ? f.from : null,
      };
      meta.push(m);
      console.log(`${x.base}(${x.yahoo}, ${m.type} ${m.name || ''}): ${m.rows}일 ${m.from}~${m.to} · 롱 보유 비용 연 ${m.fundingAnnualPct ?? '기록 없음'}%${f ? `(${f.from}~)` : ''}`);
    } catch (e) {
      console.log(`${x.base}: 실패 — ${e.message}`);
      meta.push({ binance: x.base, yahoo: x.yahoo, ok: false, reason: e.message });
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  fs.writeFileSync(path.join(OUT_DIR, 'meta.json'), JSON.stringify({ at: new Date().toISOString(), symbols: meta }, null, 2));
  console.log(`쓸 수 있는 종목 ${meta.filter((m) => m.ok).length}개 → node server/backtest/round2.js`);
}

if (require.main === module) main();

module.exports = { pickTradfi, priceMatches, classifyYahoo, YAHOO, EXCLUDE };

'use strict';

// fetch-tradfi.js — 바이낸스에 상장된 미국 주식·지수 ETF 무기한(TRADIFI_PERPETUAL)의 긴 일봉(Yahoo)과 실측 펀딩을 받는다
// (2026-10-15, 2차 탐색 L — docs/07-RESEARCH-PROTOCOL.md). 공개 시세만, 키·주문 없음.
// 종목 규칙(오너 2026-10-15): 미국 주식·ETF 만. 원자재·한국 주식·비상장·레버리지 ETF 는 뺀다.
// 바이낸스 기호 → Yahoo 기호는 아래 표로만 바꾼다(표에 없는 건 뺀다). 받은 뒤 바이낸스 현재가와 Yahoo 마지막 종가가
// 15% 넘게 다르면 다른 종목으로 보고 뺀다(표가 틀렸을 때 잘못된 기록으로 결론을 내지 않게).
// 저장: reports/backtest/data/tradfi/<YAHOO>-1d.csv + meta.json
//   node server/backtest/fetch-tradfi.js

const fs = require('fs');
const path = require('path');
const { fetchYahooDaily, toCsv } = require('./fetch-stocks');
const { fundingSummary } = require('../../ops/tradfi-check');

const FAPI = 'https://fapi.binance.com';
const OUT_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data', 'tradfi');
const YAHOO = Object.freeze({
  TSLA: 'TSLA', HOOD: 'HOOD', INTC: 'INTC', CRCL: 'CRCL', AMZN: 'AMZN', MSTR: 'MSTR', COIN: 'COIN', PLTR: 'PLTR', EWJ: 'EWJ',
  PAYP: 'PYPL', META: 'META', NVDA: 'NVDA', GOOGL: 'GOOGL', SPY: 'SPY', QQQ: 'QQQ', XYZ: 'XYZ', MU: 'MU',
});
const EXCLUDE = Object.freeze({
  XAU: '원자재', XAG: '원자재', XPD: '원자재', XPT: '원자재', SKHYNIX: '한국 주식', SAMSUNG: '한국 주식',
  SOXL: '레버리지 ETF', SOXS: '레버리지 ETF', KORU: '레버리지 ETF', OPENAI: '비상장', SPCX: '비상장',
});

// exchangeInfo → [{ symbol, base, yahoo|null, reason|null }] — 거래 중인 TRADIFI 무기한만
function pickTradfi(info) {
  return ((info && info.symbols) || [])
    .filter((s) => /TRADIFI/i.test(String(s.contractType || '')) && s.status === 'TRADING')
    .map((s) => {
      const base = String(s.symbol).replace(/USDT$/, '');
      if (EXCLUDE[base]) return { symbol: s.symbol, base, yahoo: null, reason: EXCLUDE[base] };
      if (!YAHOO[base]) return { symbol: s.symbol, base, yahoo: null, reason: '어떤 종목인지 확인 안 됨' };
      return { symbol: s.symbol, base, yahoo: YAHOO[base], reason: null };
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
      const rows = await fetchYahooDaily(x.yahoo, 2015);
      const mark = Number((await json(`${FAPI}/fapi/v1/premiumIndex?symbol=${x.symbol}`)).markPrice);
      const last = rows[rows.length - 1].c;
      if (!priceMatches(mark, last)) {
        console.log(`${x.base}: 제외 — 바이낸스 ${mark} ≠ Yahoo ${x.yahoo} ${Math.round(last * 100) / 100} (다른 종목일 수 있음)`);
        meta.push({ binance: x.base, yahoo: x.yahoo, ok: false, reason: '가격 불일치' });
        continue;
      }
      const f = fundingSummary(await json(`${FAPI}/fapi/v1/fundingRate?symbol=${x.symbol}&limit=1000`));
      fs.writeFileSync(path.join(OUT_DIR, `${x.yahoo}-1d.csv`), toCsv(rows));
      const m = {
        binance: x.base, yahoo: x.yahoo, ok: true, rows: rows.length,
        from: new Date(rows[0].t).toISOString().slice(0, 10), to: new Date(rows[rows.length - 1].t).toISOString().slice(0, 10),
        fundingAnnualPct: f ? f.annualLongCostPct : null, fundingFrom: f ? f.from : null,
      };
      meta.push(m);
      console.log(`${x.base}(${x.yahoo}): ${m.rows}일 ${m.from}~${m.to} · 롱 보유 비용 연 ${m.fundingAnnualPct ?? '기록 없음'}%${f ? `(${f.from}~)` : ''}`);
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

module.exports = { pickTradfi, priceMatches, YAHOO, EXCLUDE };

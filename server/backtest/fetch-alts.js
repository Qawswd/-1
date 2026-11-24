'use strict';

// fetch-alts.js — 여러 코인 순환(상대 강도) 시험용 데이터(2026-10-15, docs/07-RESEARCH-PROTOCOL.md 가족 G).
// '지금 유명한 승자'만 고르지 않으려고, 2020-07-01 전에 이미 바이낸스 USDT 무기한에 상장돼 있던 종목을 고른다.
// 한계: 그 뒤 상장 폐지된 코인은 지금 목록에 없어 빠진다(생존 편향이 일부 남는다 — 결과를 그만큼 낮춰 봐야 한다).
// 저장: reports/backtest/data/alts/<SYMBOL>-1d.csv · <SYMBOL>-funding.csv (BTC·ETH 는 기존 data/ 를 쓴다)
//   node server/backtest/fetch-alts.js

const fs = require('fs');
const path = require('path');
const F = require('./fetch-data');

const OUT_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data', 'alts');
const CUTOFF = Date.parse('2020-07-01T00:00:00Z');
const START = Date.parse('2020-01-01T00:00:00Z');

// exchangeInfo → 고를 종목(USDT 무기한 · 지금 거래 중 · 상장일이 기준일 전 · BTC·ETH 제외)
function pickEarlyPerps(info, cutoff = CUTOFF) {
  const list = (info && Array.isArray(info.symbols) ? info.symbols : []).filter(
    (s) =>
      s &&
      s.contractType === 'PERPETUAL' &&
      s.quoteAsset === 'USDT' &&
      s.status === 'TRADING' &&
      Number(s.onboardDate) > 0 &&
      Number(s.onboardDate) < cutoff &&
      !['BTCUSDT', 'ETHUSDT'].includes(s.symbol)
  );
  return list.map((s) => ({ symbol: s.symbol, onboardDate: Number(s.onboardDate) })).sort((a, b) => a.onboardDate - b.onboardDate);
}

async function main() {
  const info = await F.getJson(`${F.BASE}/fapi/v1/exchangeInfo`);
  const picks = pickEarlyPerps(info);
  console.log(`2020-07-01 전에 상장된 USDT 무기한(지금도 거래 중): ${picks.length}개 — ${picks.map((p) => p.symbol.replace(/USDT$/, '')).join(' ')}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const p of picks) {
    try {
      const candles = await F.fetchKlines(p.symbol, '1d', START);
      fs.writeFileSync(path.join(OUT_DIR, `${p.symbol}-1d.csv`), F.toCsv(candles));
      const funding = await F.fetchFunding(p.symbol, START);
      fs.writeFileSync(path.join(OUT_DIR, `${p.symbol}-funding.csv`), 't,rate\n' + funding.map((f) => `${f.t},${f.rate}`).join('\n') + '\n');
      console.log(`  ${p.symbol}: 일봉 ${candles.length} · 펀딩 ${funding.length}`);
    } catch (e) {
      console.log(`  ${p.symbol}: 실패 — ${e.message}`);
    }
  }
  console.log(`저장: ${OUT_DIR}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('실패:', e && e.message ? e.message : e);
    process.exit(1);
  });
}

module.exports = { pickEarlyPerps, CUTOFF, OUT_DIR };

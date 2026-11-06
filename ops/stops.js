'use strict';
// 지금 열린 포지션과 거래소에 실제로 걸린 손절을 보여준다(읽기 전용, 주문 없음).
//   node ops/stops.js
const fs = require('fs');
const path = require('path');
try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) {
  console.error('.env 를 읽지 못했습니다');
}
const ex = require('../server/exchange');
(async () => {
  const client = ex.createClient({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
    baseUrl: process.env.BINANCE_FUTURES_BASE_URL,
  });
  const positions = ex.summarizeAllOpenPositions(await client.getPosition());
  if (!positions.length) return console.log('열린 포지션 없음');
  for (const p of positions) {
    const stop = ex.findExchangeStop(await client.getOpenAlgoOrders(p.symbol), p.side);
    const dist = stop != null && p.markPrice ? (((stop - p.markPrice) / p.markPrice) * 100).toFixed(2) + '%' : '-';
    console.log(`${p.symbol} ${p.side} 진입 ${p.entry} · 현재 ${p.markPrice} (${p.unrealizedPct}%) · 손절 ${stop == null ? '없음 ⚠' : stop} (현재가 대비 ${dist})`);
  }
})().catch((e) => {
  console.error('조회 실패:', e && e.message ? e.message : e);
  process.exit(1);
});

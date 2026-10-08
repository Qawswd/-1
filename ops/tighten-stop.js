'use strict';
// 열린 포지션의 손절을 지정 가격으로 "당긴다". 지금 걸린 손절보다 느슨하거나 같으면 거절한다
// (exchange.updateStopLoss 의 안전장치 그대로). 수량·방향은 거래소에서 읽는다.
//   node ops/tighten-stop.js ETHUSDT 2600
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
const symbol = String(process.argv[2] || '').toUpperCase();
const price = Number(process.argv[3]);
if (!symbol || !(price > 0)) {
  console.error('사용법: node ops/tighten-stop.js ETHUSDT 2600');
  process.exit(1);
}
(async () => {
  const client = ex.createClient({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
    baseUrl: process.env.BINANCE_FUTURES_BASE_URL,
  });
  const pos = ex.summarizeAllOpenPositions(await client.getPosition()).find((p) => p.symbol === symbol);
  if (!pos) return console.log(`${symbol} 열린 포지션 없음 — 아무것도 하지 않았습니다`);
  const res = await ex.updateStopLoss({ symbol, side: pos.side, newStopPrice: price, quantity: pos.quantity }, client);
  if (res.ok) console.log(`✅ ${symbol} ${pos.side} 손절 ${res.previousStop ?? '?'} → ${res.appliedStop}`);
  else console.log(`변경 안 함: ${res.error}`);
  const now = ex.findExchangeStop(await client.getOpenAlgoOrders(symbol), pos.side);
  console.log(`지금 걸린 손절: ${now == null ? '없음 ⚠' : now}`);
})().catch((e) => {
  console.error('실패:', e && e.message ? e.message : e);
  process.exit(1);
});

'use strict';
// 바이낸스 미국 주식 무기한(TSLA·NVDA·META·MSTR·COIN)을 이 계정으로 주문할 수 있는지 확인한다 — 데모 전용(2026-10-14).
// 예전(09-23) NVDA 가 '거래 불가 종목'으로 막혔다는 기록이 있지만 거래소가 막은 건지 우리 코드가 막은 건지 남아 있지 않다.
//   node ops/stock-order-test.js          # 상장 정보 + 주문 검증(/order/test — 체결 없음)
//   node ops/stock-order-test.js --live   # 데모에서 최소 수량을 실제로 사서(1배·손절 포함) 바로 정리 — 지역 제한은 실제 주문에서만 드러날 수 있다
// 실계좌 주소면 거부한다. 운용 중인 추세추종(BTC·ETH)과는 종목이 달라 섞이지 않는다.
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

const SYMBOLS = ['TSLAUSDT', 'NVDAUSDT', 'METAUSDT', 'MSTRUSDT', 'COINUSDT'];
const LIVE = process.argv.includes('--live');

(async () => {
  const base = process.env.BINANCE_FUTURES_BASE_URL || '';
  if (!/demo/.test(base)) {
    console.log('데모 주소가 아니라 멈춥니다.');
    process.exit(1);
  }
  const client = ex.createClient({ apiKey: process.env.BINANCE_API_KEY, apiSecret: process.env.BINANCE_API_SECRET, baseUrl: base });
  const info = await client.getExchangeInfo();
  const list = (info && info.symbols) || [];
  console.log(`데모 · ${LIVE ? '실제 최소 주문까지' : '주문 검증만(체결 없음) — 실제로 사 보려면 --live'}`);
  for (const sym of SYMBOLS) {
    const s = list.find((x) => x.symbol === sym);
    if (!s) {
      console.log(`${sym}: 데모 거래소 목록에 없음`);
      continue;
    }
    const f = ex.pickSymbolFilters(info, sym);
    const mark = (await client.getMarkPrice(sym)).markPrice;
    const step = f.qtyStep || 0.001;
    const need = Math.max(f.minQty || step, f.minNotional && mark ? (f.minNotional * 1.05) / mark : 0);
    const qty = Number((Math.ceil(need / step) * step).toFixed(Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))));
    const head = `${sym}: 상태 ${s.status} · 종류 ${s.contractType}${s.underlyingType ? '/' + s.underlyingType : ''} · 현재가 ${mark} · 최소 ${qty}개(약 ${mark ? Math.round(qty * mark) : '-'} USDT)`;
    let test;
    try {
      await client.testMarketOrder(sym, 'BUY', qty);
      test = '주문 검증 통과';
    } catch (e) {
      test = `주문 검증 거부 — ${e.message}`;
    }
    console.log(`${head}\n   ${test}`);
    if (!LIVE) continue;
    const stopPrice = ex.roundStopToTick('LONG', mark * 0.75, f.priceStep);
    const r = await ex.openPositionWithStop({ symbol: sym, action: 'BUY', quantity: qty, stopPrice }, client);
    if (!r.ok) {
      console.log(`   실제 주문 거부 — ${r.error}`);
      continue;
    }
    const c = await ex.closeExistingPosition({ symbol: sym, side: 'LONG', quantity: r.filledQty || qty }, client);
    console.log(`   실제 주문 체결 ${r.filledQty || qty}개 → 바로 정리 ${c.ok ? '완료' : '실패: ' + c.error}`);
  }
})().catch((e) => {
  console.error('확인 실패:', e && e.message ? e.message : e);
  process.exit(1);
});

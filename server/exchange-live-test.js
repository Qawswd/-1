'use strict';

// exchange-live-test.js — 순수 연결 테스트. AI 판단(12명 파이프라인)을 거치지 않고,
// 거래소 API가 진짜로 작동하는지만 최소 수량으로 바로 확인한다.
//
// 실행: node server/exchange-live-test.js [심볼]
//   예: node server/exchange-live-test.js BTCUSDT
//
// 하는 일: 1) 현재가 조회 → 2) 심볼 최소 수량 조회 → 3) 넉넉한 손절(5% 아래)로
// 진입+손절 주문을 실제로(설정된 BASE_URL 기준 — 테스트넷이어야 한다) 넣어보고
// 결과를 그대로 출력한다. 판단·전략 없음 — 배관이 뚫려있는지만 보는 용도다.

const fs = require('fs');
const path = require('path');

// systemd는 EnvironmentFile로 .env를 읽지만, 이 스크립트는 node로 직접 실행하므로
// 여기서 한 번 더 로드한다. 외부 의존성 없이 최소한만 파싱한다.
function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

const exchange = require('./exchange');

async function main() {
  const symbol = process.argv[2] || 'BTCUSDT';
  console.log(`=== 거래소 연결 테스트: ${symbol} ===`);
  console.log(`BASE_URL: ${process.env.BINANCE_FUTURES_BASE_URL || '(설정 안 됨)'}`);

  let client;
  try {
    client = exchange.createClient({
      apiKey: process.env.BINANCE_API_KEY,
      apiSecret: process.env.BINANCE_API_SECRET,
      baseUrl: process.env.BINANCE_FUTURES_BASE_URL,
    });
  } catch (e) {
    console.error('클라이언트 생성 실패:', e.message);
    process.exit(1);
  }

  // 1) 현재가(공개 엔드포인트, 서명 불필요)
  let price;
  try {
    const res = await fetch(`${process.env.BINANCE_FUTURES_BASE_URL}/fapi/v1/ticker/price?symbol=${symbol}`);
    const data = await res.json();
    price = Number(data.price);
    if (!(price > 0)) throw new Error('가격을 읽지 못함: ' + JSON.stringify(data));
    console.log(`현재가: ${price}`);
  } catch (e) {
    console.error('현재가 조회 실패:', e.message);
    process.exit(1);
  }

  // 2) 심볼 최소 수량(정밀도) — 실패하면 아주 작은 값으로 대체
  let step = 0.001;
  try {
    const filters = await client.getSymbolFilters(symbol);
    if (filters && filters.qtyStep) step = filters.qtyStep;
  } catch (e) {
    console.log(`정밀도 조회 실패, 기본값 사용: ${step} (${e.message})`);
  }

  // 바이낸스는 주문 명목가(수량×가격)가 최소 50 USDT 이상이어야 한다(MIN_NOTIONAL).
  // step 그대로면 너무 작을 수 있어, 여유 있게 80 USDT를 목표로 step의 배수로 올림한다.
  const targetNotional = 80;
  const rawQty = targetNotional / price;
  const steps = Math.ceil(rawQty / step);
  const qty = exchange.floorToStep(steps * step, step) || step;
  console.log(`테스트 수량: ${qty} (목표 명목가 약 ${targetNotional} USDT, 최소단위 ${step})`);

  // 3) 넉넉한 손절(5% 아래) — 연결 자체만 보는 테스트라 타이트하게 잡을 필요 없음
  const stopPrice = Number((price * 0.95).toFixed(2));
  console.log(`손절가(5% 아래, 테스트용): ${stopPrice}`);
  console.log('\n주문 전송 중...\n');

  const result = await exchange.openPositionWithStop({ symbol, action: 'BUY', quantity: qty, stopPrice }, client);

  console.log('=== 결과 ===');
  console.log(JSON.stringify(result, null, 2));

  if (result.ok) {
    console.log('\n✅ 성공 — 진입 주문과 손절 주문이 둘 다 거래소에 정상 접수됐습니다.');
    console.log('테스트넷 웹사이트(demo.binance.com)의 포지션·주문 내역에서 직접 확인해보세요.');
  } else {
    console.log('\n❌ 실패:', result.error);
  }
}

main().catch((e) => {
  console.error('스크립트 자체 오류:', e);
  process.exit(1);
});

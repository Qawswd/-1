'use strict';
// 최근 N일 거래소 손익 기록을 시각·종목·종류별로 출력한다(읽기 전용, 주문 없음).
//   node ops/income-report.js 3
// .env 의 BINANCE_* 를 읽는다. 키 값은 출력하지 않는다.
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
try {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) {
  console.error('.env 를 읽지 못했습니다');
}

const ex = require('../server/exchange');
const days = Math.max(1, Math.min(30, Number(process.argv[2]) || 3));
const KO = { REALIZED_PNL: '실현손익', COMMISSION: '수수료', FUNDING_FEE: '펀딩' };

(async () => {
  const base = process.env.BINANCE_FUTURES_BASE_URL || '';
  console.log(`거래소: ${/demo|testnet/i.test(base) ? '데모' : base ? '실계좌' : '설정 없음'} · 최근 ${days}일`);
  const client = ex.createClient({
    apiKey: process.env.BINANCE_API_KEY,
    apiSecret: process.env.BINANCE_API_SECRET,
    baseUrl: base,
  });
  const end = Date.now();
  const rows = await client.getIncomeHistory({ startTime: end - days * 86400000, endTime: end, limit: 1000 });
  const list = (Array.isArray(rows) ? rows : []).sort((a, b) => Number(a.time) - Number(b.time));
  for (const r of list) {
    const t = new Date(Number(r.time)).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    console.log(`${t}  ${String(r.symbol || '-').padEnd(8)}  ${(KO[r.incomeType] || r.incomeType).padEnd(5)}  ${r.income}`);
  }
  const s = ex.summarizeIncome(list);
  console.log(`합계: 실현손익 ${s.realized} · 수수료 ${s.commission} · 펀딩 ${s.funding} → 순손익 ${s.net} USDT`);
})().catch((e) => {
  console.error('조회 실패:', e && e.message ? e.message : e);
  process.exit(1);
});

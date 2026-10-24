'use strict';
// 데모 거래소와 실제 거래소의 가격·펀딩비를 나란히 비교한다(공개 데이터만, 키 불필요, 주문 없음).
//   node ops/demo-vs-real.js                      # 현재가 + 최근 3일 펀딩
//   node ops/demo-vs-real.js 2026-10-07T02:00Z    # 그 시각부터 10분간 1분봉 종가도 비교
const REAL = 'https://fapi.binance.com';
const DEMO = 'https://demo-fapi.binance.com';
const SYMS = ['BTCUSDT', 'ETHUSDT'];

async function j(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}
const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b ? (((a - b) / b) * 100).toFixed(3) + '%' : '-');
const kst = (t) => new Date(Number(t)).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

(async () => {
  const at = process.argv[2] ? Date.parse(process.argv[2]) : null;
  for (const s of SYMS) {
    console.log(`\n=== ${s} ===`);
    try {
      const [r, d] = await Promise.all([j(`${REAL}/fapi/v1/premiumIndex?symbol=${s}`), j(`${DEMO}/fapi/v1/premiumIndex?symbol=${s}`)]);
      const rm = Number(r.markPrice);
      const dm = Number(d.markPrice);
      console.log(`현재 마크가  실제 ${rm}  데모 ${dm}  차이 ${pct(dm, rm)}`);
    } catch (e) {
      console.log('현재가 조회 실패:', e.message);
    }
    try {
      const since = Date.now() - 3 * 86400000;
      const [r, d] = await Promise.all([
        j(`${REAL}/fapi/v1/fundingRate?symbol=${s}&startTime=${since}&limit=20`),
        j(`${DEMO}/fapi/v1/fundingRate?symbol=${s}&startTime=${since}&limit=20`),
      ]);
      const dm = new Map(d.map((x) => [Math.round(Number(x.fundingTime) / 60000), Number(x.fundingRate)]));
      console.log('펀딩비(8시간마다)        실제        데모');
      for (const x of r) {
        const k = Math.round(Number(x.fundingTime) / 60000);
        const dv = dm.has(k) ? (dm.get(k) * 100).toFixed(4) + '%' : '-';
        console.log(`${kst(x.fundingTime).padEnd(22)}  ${(Number(x.fundingRate) * 100).toFixed(4)}%   ${dv}`);
      }
    } catch (e) {
      console.log('펀딩 조회 실패:', e.message);
    }
    if (Number.isFinite(at)) {
      try {
        const q = `/fapi/v1/klines?symbol=${s}&interval=1m&startTime=${at}&limit=10`;
        const [r, d] = await Promise.all([j(REAL + q), j(DEMO + q)]);
        console.log('1분봉 종가               실제        데모       차이');
        for (let i = 0; i < r.length; i++) {
          const rc = Number(r[i][4]);
          const dc = d[i] ? Number(d[i][4]) : NaN;
          console.log(`${kst(r[i][0]).padEnd(22)}  ${rc}  ${Number.isFinite(dc) ? dc : '-'}  ${pct(dc, rc)}`);
        }
      } catch (e) {
        console.log('1분봉 조회 실패:', e.message);
      }
    }
  }
})();

'use strict';
// 바이낸스 주식·지수·금 선물(TRADIFI)의 보유 비용(펀딩비)과 주말 거래 모양을 본다 — 공개 시세만, 주문·키 없음(2026-10-14).
// 코인 선물은 백테스트에 실제 펀딩비를 넣었지만 주식·금 선물은 기록이 없어 빠졌다. 롱을 들고 있으면 펀딩비를 낼 수 있어
// 이게 크면(예: 연 10%) 추세추종 수익이 사라진다 — 섞기 전에 먼저 확인한다.
//   node ops/tradfi-check.js
//   node ops/tradfi-check.js QQQUSDT XAUUSDT

const FAPI = 'https://fapi.binance.com';
const DEFAULT = ['QQQUSDT', 'SPYUSDT', 'XAUUSDT', 'XAGUSDT'];
const DAY = 86400000;

// 펀딩 기록 → 8시간당 평균(%)·연 환산(롱이 내는 비용, %)·음수 비율. 정산 간격이 8시간이 아닐 수 있어 실제 기간으로 연 환산한다.
function fundingSummary(rows) {
  const list = (Array.isArray(rows) ? rows : [])
    .map((r) => ({ t: Number(r.fundingTime), rate: Number(r.fundingRate) }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.rate))
    .sort((a, b) => a.t - b.t);
  if (list.length < 2) return null;
  const sum = list.reduce((s, r) => s + r.rate, 0);
  const days = (list[list.length - 1].t - list[0].t) / DAY;
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    n: list.length,
    from: new Date(list[0].t).toISOString().slice(0, 10),
    to: new Date(list[list.length - 1].t).toISOString().slice(0, 10),
    avgPer8hPct: Math.round((sum / list.length) * 100 * 10000) / 10000,
    annualLongCostPct: days > 0 ? r2((sum * 100 * 365) / days) : null,
    negativePct: r2((list.filter((r) => r.rate < 0).length / list.length) * 100),
    intervalHours: r2((days * 24) / (list.length - 1)),
  };
}

// 일봉 kline → 주말(UTC 토·일) 봉 수와 주말·평일 평균 거래대금 비율(주말에도 실제로 거래되는지)
function weekendShape(klines) {
  const rows = (Array.isArray(klines) ? klines : []).map((k) => ({ t: Number(k[0]), q: Number(k[7]) })).filter((k) => Number.isFinite(k.t));
  const wk = rows.filter((k) => [0, 6].includes(new Date(k.t).getUTCDay()));
  const wd = rows.filter((k) => ![0, 6].includes(new Date(k.t).getUTCDay()));
  const avg = (a) => (a.length ? a.reduce((s, k) => s + (Number.isFinite(k.q) ? k.q : 0), 0) / a.length : 0);
  return { days: rows.length, weekendDays: wk.length, weekendVolumeRatio: avg(wd) > 0 ? Math.round((avg(wk) / avg(wd)) * 100) / 100 : null };
}

async function json(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const syms = process.argv.slice(2).length ? process.argv.slice(2).map((s) => s.toUpperCase()) : DEFAULT;
  console.log('바이낸스 TradFi 선물 — 펀딩비(롱 보유 비용)와 주말 거래 (실제 시장 공개 데이터)');
  for (const s of syms) {
    try {
      const f = fundingSummary(await json(`${FAPI}/fapi/v1/fundingRate?symbol=${s}&limit=1000`));
      const k = weekendShape(await json(`${FAPI}/fapi/v1/klines?symbol=${s}&interval=1d&limit=60`));
      const p = await json(`${FAPI}/fapi/v1/premiumIndex?symbol=${s}`);
      console.log(
        `${s}: 펀딩 ${f ? `${f.n}회(${f.from}~${f.to}, 약 ${f.intervalHours}시간마다) · 평균 ${f.avgPer8hPct}%/회 · 롱 보유 비용 연 ${f.annualLongCostPct}% · 음수 ${f.negativePct}%` : '기록 없음'}` +
          ` · 지금 ${(Number(p.lastFundingRate) * 100).toFixed(4)}%\n   최근 ${k.days}일 중 주말 봉 ${k.weekendDays}개 · 주말/평일 거래대금 ${k.weekendVolumeRatio ?? '-'}배 · 현재가 ${p.markPrice}`
      );
    } catch (e) {
      console.log(`${s}: 조회 실패 — ${e.message}`);
    }
  }
  console.log('\n참고: 코인 선물(BTC) 2024년 이후 롱 보유 비용은 연 약 7%(8시간당 평균 0.0064%) — 코인 백테스트엔 이미 들어 있다.');
}

if (require.main === module) main();

module.exports = { fundingSummary, weekendShape };

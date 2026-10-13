'use strict';
// 추세추종 현황(읽기 전용, 주문 없음) — 순자산·고점 대비·종목별 평균선 위 개수·목표·포지션·손절.
// 전환 전에는 새로 쓰는 잔고 조회(/fapi/v2/balance)가 데모에서 실제로 되는지 확인하는 용도로도 쓴다.
//   node ops/trend-status.js
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
const TF = require('../server/trend-follow');
const { loadConfig } = require('../server/config');

(async () => {
  const cfg = loadConfig();
  const p = TF.effectiveParams(cfg.trend);
  const st = TF.loadState();
  console.log(`추세추종: ${p.enabled ? '켜짐' : '꺼짐'} · 비중 ${p.allocPct}% · 재난 손절 −${p.stopPct}% · 정지 −${p.breakerPct}% · 매일 한국 ${p.runAtKst}`);
  const client = ex.createClient({ apiKey: process.env.BINANCE_API_KEY, apiSecret: process.env.BINANCE_API_SECRET, baseUrl: process.env.BINANCE_FUTURES_BASE_URL });
  console.log(`거래소: ${/demo/.test(process.env.BINANCE_FUTURES_BASE_URL || '') ? '데모' : '실계좌'}`);
  let equity = null;
  try {
    equity = ex.equityFromBalance(await client.getAccountBalance());
    console.log(`순자산 ${equity == null ? '읽기 실패(USDT 없음)' : equity + ' USDT'}${st.peak ? ` · 고점 ${st.peak} · 고점 대비 −${TF.breakerCheck({ equity, peak: st.peak, breakerPct: p.breakerPct }).ddPct}%` : ''}`);
  } catch (e) {
    console.log(`순자산 조회 실패: ${e.message}`);
  }
  if (st.halted) console.log(`⚠ 정지 상태: ${JSON.stringify(st.halted)}`);
  if (st.lastRun) console.log(`마지막 점검: ${st.lastRun.at} (${st.lastRun.ok ? '정상' : '오류'})`);
  for (const symbol of p.symbols) {
    const pos = ex.summarizeOpenPosition(await client.getPosition(symbol));
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=1d&limit=260`);
    const closes = TF.completedCloses(await res.json());
    const k = TF.countAbove(closes, p.smaLengths);
    const mark = (await client.getMarkPrice(symbol)).markPrice;
    const filters = await client.getSymbolFilters(symbol);
    const plan = TF.planSymbol({ k, n: p.smaLengths.length, equity, allocPct: p.allocPct, weight: 1 / p.symbols.length, markPrice: mark, currentQty: pos && pos.side === 'LONG' ? pos.quantity : 0, lastK: (st.lastK || {})[symbol], bandPct: p.bandPct, filters, maxNotionalUsd: p.maxNotionalUsdPerSymbol });
    const stop = pos ? ex.findExchangeStop(await client.getOpenAlgoOrders(symbol), pos.side) : null;
    console.log(
      `${symbol}: 평균선 위 ${k}/${p.smaLengths.length} (어제 종가 ${closes[closes.length - 1]}) · 목표 ${plan.targetUsd ?? '-'} USDT · ` +
        `지금 ${pos ? `${pos.side} ${pos.quantity} @${pos.entry} (${pos.unrealizedPct}%) · 손절 ${stop ?? '없음'}` : '포지션 없음'} · 다음 점검 때 할 일: ${plan.action} (${plan.reason})`
    );
  }
  console.log(`최소 주문(참고): ${JSON.stringify(await client.getSymbolFilters('BTCUSDT'))}`);
})().catch((e) => {
  console.error('조회 실패:', e && e.message ? e.message : e);
  process.exit(1);
});

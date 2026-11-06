'use strict';
// AI 단기 매매 → 추세추종 전환(한 번만). 2026-10-13 오너 승인.
//   node ops/trend-switch.js          # 무엇을 할지 보여주기만(주문 없음)
//   node ops/trend-switch.js --yes    # 실행: BTC·ETH 에 열린 포지션(예전 AI 것)을 정리하고 config.json 의 trend.enabled 를 켠다
// 실행 뒤 sudo systemctl restart trading-floor — 재시작 1분 안에 첫 점검(한국 09:05 가 지났으면 바로)이 돈다.
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
const positions = require('../server/positions');
const { loadConfig, saveConfig } = require('../server/config');

const YES = process.argv.includes('--yes');

(async () => {
  const cfg = loadConfig();
  const p = TF.effectiveParams({ ...(cfg.trend || {}), enabled: true });
  const client = ex.createClient({ apiKey: process.env.BINANCE_API_KEY, apiSecret: process.env.BINANCE_API_SECRET, baseUrl: process.env.BINANCE_FUTURES_BASE_URL });
  const isDemo = /demo/.test(process.env.BINANCE_FUTURES_BASE_URL || '');
  console.log(`거래소: ${isDemo ? '데모' : '실계좌'} · ${YES ? '실행' : '미리보기(주문 없음) — 실행하려면 --yes'}`);
  if (!isDemo) {
    console.log('실계좌 주소라 멈춥니다 — 추세추종은 데모 전방 검증부터 한다(CLAUDE.md).');
    process.exit(1);
  }
  // 잔고 조회가 안 되면 추세추종이 비중을 계산할 수 없다 — 전환하지 않는다
  const equity = ex.equityFromBalance(await client.getAccountBalance());
  if (!(equity > 0)) {
    console.log('순자산(USDT)을 읽지 못해 전환하지 않습니다.');
    process.exit(1);
  }
  console.log(`순자산 ${equity} USDT`);

  const open = ex.summarizeAllOpenPositions(await client.getPosition()).filter((x) => p.symbols.includes(x.symbol));
  if (!open.length) console.log('정리할 포지션 없음');
  for (const pos of open) {
    console.log(`정리 대상: ${pos.symbol} ${pos.side} ${pos.quantity} @${pos.entry} (${pos.unrealizedPct}%)`);
    if (!YES) continue;
    const r = await ex.closeExistingPosition({ symbol: pos.symbol, side: pos.side, quantity: pos.quantity }, client);
    console.log(`  → ${r.ok ? '정리 완료' : '실패: ' + r.error}`);
    if (!r.ok) process.exit(1);
  }

  const ledgerOpen = (positions.listPositions().open || []).filter((x) => p.symbols.includes(x.execSymbol || ex.toBinanceFuturesSymbol(x.symbol)));
  for (const lp of ledgerOpen) {
    const sym = lp.execSymbol || ex.toBinanceFuturesSymbol(lp.symbol);
    const mark = (await client.getMarkPrice(sym)).markPrice;
    console.log(`AI 장부 정리: ${lp.symbol} ${lp.side} (id ${lp.id})`);
    if (YES) positions.closePosition(lp.id, { price: mark, reason: '추세추종 전환 — AI 포지션 정리' });
  }

  if (YES) {
    saveConfig({ trend: { enabled: true } });
    const after = TF.effectiveParams(loadConfig().trend);
    console.log(`config.json: trend.enabled = ${after.enabled} · 비중 ${after.allocPct}% · 재난 손절 −${after.stopPct}% · 정지 −${after.breakerPct}%`);
    console.log('다음: sudo systemctl restart trading-floor');
  }
})().catch((e) => {
  console.error('전환 실패:', e && e.message ? e.message : e);
  process.exit(1);
});

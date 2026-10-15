'use strict';
// 오너 직접 매매 기록(server/owner-record.js) 점검·시작·끄기(2026-10-15). 실계좌를 읽기 전용 키로 읽기만 한다 — 주문 없음.
//   node ops/owner-record.js                      # 키 권한 확인 + 지금 계좌(순자산·포지션·손절·레버리지) 보기
//   node ops/owner-record.js --start              # 오늘(한국)부터 90일 기록 시작 → sudo systemctl restart trading-floor
//   node ops/owner-record.js --start 2026-10-20 --days 90 --max-loss 15
//   node ops/owner-record.js --report             # 지금까지 기록 요약
//   node ops/owner-record.js --stop               # 기록 끄기
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
const OR = require('../server/owner-record');
const EX = require('../server/exchange');
const { kstParts } = require('../server/trend-follow');
const { loadConfig, saveConfig } = require('../server/config');

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};

(async () => {
  if (argv.includes('--stop')) {
    saveConfig({ ownerRecord: { enabled: false } });
    console.log('기록을 껐습니다 → sudo systemctl restart trading-floor');
    return;
  }
  if (argv.includes('--report')) {
    const st = OR.loadState();
    const snaps = st.snapshots || [];
    if (!snaps.length) return console.log('아직 기록이 없습니다.');
    const o = OR.chainReturns(snaps);
    const s = OR.chainReturns(snaps, 'systemEquity', '_none');
    console.log(`기간 ${st.startDate} ~ · 기록 ${snaps.length}일 · 대표님 ${o.totalPct ?? '-'}% (최대 손실 ${o.maxDrawdownPct ?? '-'}%) · 시스템 ${s.totalPct ?? '-'}% · 청산 ${st.trades ?? 0}번 · 위반 ${(st.violationLog || []).length}번${st.ended ? ` · 끝: ${st.ended.reason}` : ''}`);
    for (const v of st.violationLog || []) console.log(`  위반 ${new Date(v.t).toISOString().slice(0, 16)} ${v.text}`);
    return;
  }
  let client;
  try {
    client = OR.createReadOnlyClient({ apiKey: process.env.OWNER_BINANCE_API_KEY, apiSecret: process.env.OWNER_BINANCE_API_SECRET });
  } catch (e) {
    console.log(e.message);
    console.log('서버 .env 에 OWNER_BINANCE_API_KEY= 와 OWNER_BINANCE_API_SECRET= 두 줄을 넣어 주세요(채팅으로 보내지 마세요).');
    process.exit(1);
  }
  let kc;
  try {
    kc = OR.checkKeyRestrictions(await client.getApiRestrictions());
  } catch (e) {
    console.log(`키 권한 확인 실패: ${e.message}`);
    console.log('키가 틀렸거나, IP 제한에 이 서버 IP 가 없거나, 바이낸스가 막았을 수 있습니다.');
    process.exit(1);
  }
  if (!kc.ok) {
    console.log('❌ 이 키는 쓰지 않습니다 — 읽기 말고 다른 권한이 켜져 있습니다:');
    for (const p of kc.problems) console.log(`   - ${p}`);
    console.log("바이낸스 → API 관리 → 이 키 '수정'에서 '읽기 허용'만 남기고 나머지를 끄거나, 읽기 전용 새 키를 만들어 주세요.");
    process.exit(1);
  }
  console.log(`✅ 키 권한: 읽기 전용${kc.warnings.length ? ` (${kc.warnings.join(' · ')})` : ' · IP 제한 있음'}`);
  const equity = OR.ownerEquity(await client.getAccountBalance());
  const positions = await client.getPositions();
  const open = EX.summarizeAllOpenPositions(positions);
  const regular = open.length ? await client.getOpenOrders() : [];
  const stopOrders = {};
  for (const p of open) {
    let algo = [];
    try {
      const a = await client.getOpenAlgoOrders(p.symbol);
      algo = Array.isArray(a) ? a : (a && a.orders) || [];
    } catch (_) {
      /* 조건부 주문 조회 실패 */
    }
    stopOrders[p.symbol] = [...(regular || []).filter((o) => o.symbol === p.symbol), ...algo];
  }
  let info = null;
  try {
    info = await (await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo')).json();
  } catch (_) {
    /* 종목 규칙은 보류 */
  }
  const rc = OR.checkRules({ positions, stopOrders, equity, info, graceMin: 0 });
  console.log(`선물 순자산 ${equity ?? '데이터 없음'} USDT · 열린 포지션 ${open.length}개 · 레버리지(실제 노출) ${rc.exposure ?? 0}배`);
  for (const p of open) {
    const stop = EX.findExchangeStop(stopOrders[p.symbol], p.side);
    console.log(`  ${p.symbol} ${p.side === 'LONG' ? '롱' : '숏'} ${p.quantity} @${p.entry} · 손절 ${stop ?? '없음 ⚠️'}`);
  }
  console.log(rc.violations.length ? `지금 규칙 위반: ${rc.violations.map((v) => v.text).join(' / ')}` : '지금 규칙 위반 없음');

  if (argv.includes('--start')) {
    const today = kstParts(new Date()).dateKey;
    const start = arg('--start') || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || start < today) {
      console.log(`시작일은 오늘(${today}) 이후여야 합니다 — 지난 날짜로는 기준점을 못 잡습니다.`);
      process.exit(1);
    }
    const days = Number(arg('--days')) || OR.DEFAULTS.days;
    const maxLossPct = Number(arg('--max-loss')) || OR.DEFAULTS.maxLossPct;
    saveConfig({ ownerRecord: { enabled: true, startDate: start, days, maxLossPct } });
    const p = OR.effectiveParams(loadConfig().ownerRecord);
    console.log(`기록 시작 설정: ${p.startDate} 부터 ${p.days}일 · 청산 ${p.minTrades}번 이상 · 최대 손실 −${p.maxLossPct}% 면 끝`);
    console.log('적용하려면: sudo systemctl restart trading-floor  (재시작 1분 안에 기준 순자산을 기록하고 텔레그램으로 알립니다)');
  }
})().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});

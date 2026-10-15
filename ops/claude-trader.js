'use strict';
// 세 번째 선수 'Claude 분석'(server/claude-trader.js) 켜기·끄기·성적 보기(2026-10-15). 가상 장부만 — 주문 없음.
//   node ops/claude-trader.js          # 지금 성적·포지션·마지막 판단
//   node ops/claude-trader.js --on     # 켜기 → sudo systemctl restart trading-floor (켠 뒤 첫 틱에 첫 판단)
//   node ops/claude-trader.js --off    # 끄기 → sudo systemctl restart trading-floor
//   node ops/claude-trader.js --check  # 오늘 추가로 볼 미국 주식(24시간 거래대금·등락 상위) 확인 — 공개 시세만
//   node ops/claude-trader.js --reset  # 첫날·거래가 닫히기 전에만: 기록을 처음으로(예: 옛 버전으로 첫 판단을 한 경우)
const CT = require('../server/claude-trader');
const { loadConfig, saveConfig } = require('../server/config');
const { kstParts } = require('../server/trend-follow');

const argv = process.argv.slice(2);
const runsArg = (() => {
  const i = argv.indexOf('--runs');
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(',').filter((x) => /^\d{2}:\d{2}$/.test(x)) : null;
})();
if (argv.includes('--reset')) {
  // 첫날, 거래가 하나도 닫히기 전에만 — 결과를 보고 다시 시작하는 데 쓰지 못하게
  const st = CT.loadState();
  if (st.startT && (st.closed.length > 0 || Date.now() - st.startT > 86400000)) {
    console.log('되돌릴 수 없습니다 — 이미 거래가 닫혔거나 시작한 지 하루가 지났습니다(결과를 보고 다시 시작하지 않는다).');
    process.exit(1);
  }
  CT.saveState({});
  console.log('Claude 분석 기록을 처음으로 되돌렸습니다 → sudo systemctl restart trading-floor');
  process.exit(0);
}
if (argv.includes('--check')) {
  (async () => {
    const info = await (await fetch('https://fapi.binance.com/fapi/v1/exchangeInfo')).json();
    const tickers = await (await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr')).json();
    console.log(`24시간 시세 ${Array.isArray(tickers) ? tickers.length : 0}종목 · 오늘 추가로 볼 미국 주식: ${CT.pickExtraStocks(tickers, info).join(' ') || '없음'}`);
  })().catch((e) => console.log(`확인 실패: ${e.message}`));
  return;
}
if (argv.includes('--on') || argv.includes('--off')) {
  saveConfig({ claudeTrader: argv.includes('--on') ? { enabled: true, runsKst: runsArg || [...CT.DEFAULTS.runsKst] } : { enabled: false } });
  const p = CT.effectiveParams(loadConfig().claudeTrader);
  console.log(`Claude 분석 선수: ${p.enabled ? `켬 — 매일 한국 ${p.runsKst.join(' · ')} · ${p.model} · 가상 ${p.capital} USDT · ${p.days}일 · −${p.maxLossPct}% 면 끝` : '끔'}`);
  console.log('적용하려면: sudo systemctl restart trading-floor');
  process.exit(0);
}
const p = CT.effectiveParams(loadConfig().claudeTrader);
const st = CT.loadState();
console.log(`Claude 분석 선수: ${p.enabled ? '켜짐' : '꺼짐'} · 모델 ${p.model} · 판단 매일 한국 ${p.runsKst.join('·')}`);
if (!st.startT) {
  console.log('아직 기록 없음 — 켜고 재시작하면 첫 틱에 첫 판단을 합니다.');
  process.exit(0);
}
const eq = CT.equityOf(st, {});
console.log(`시작 ${kstParts(new Date(st.startT)).dateKey} · 순자산 ${eq} USDT (${Math.round((eq / p.capital - 1) * 10000) / 100}%, 열린 포지션은 마지막 확인가 기준) · 거래 ${st.closed.length}번 · 판단 ${st.decisions.length}번(실패 ${st.failures}) · 규칙에 막힌 행동 ${st.rejections}번${st.ended ? ` · 끝: ${st.ended.reason}` : ''}`);
for (const x of st.positions) console.log(`  열림 ${x.symbol} ${x.side} @${x.entry} · 손절 ${x.stop} · 목표 ${x.target ?? '-'} · ${x.reason || ''}`);
for (const x of st.closed.slice(-5)) console.log(`  닫힘 ${x.symbol} ${x.side} ${x.entry}→${x.exit} ${x.why} ${x.pct}% (${x.pnl} USDT)`);
const d = [...st.decisions].reverse().find((x) => x.ok);
if (d) console.log(`마지막 판단(${kstParts(new Date(d.t)).dateKey} ${kstParts(new Date(d.t)).hhmm}): ${d.view}${d.rejected && d.rejected.length ? ` · 막힘: ${d.rejected.join(', ')}` : ''}`);

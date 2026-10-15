'use strict';
// 세 번째 선수 'Claude 분석'(server/claude-trader.js) 켜기·끄기·성적 보기(2026-10-15). 가상 장부만 — 주문 없음.
//   node ops/claude-trader.js          # 지금 성적·포지션·마지막 판단
//   node ops/claude-trader.js --on     # 켜기 → sudo systemctl restart trading-floor (켠 뒤 첫 틱에 첫 판단)
//   node ops/claude-trader.js --off    # 끄기 → sudo systemctl restart trading-floor
const CT = require('../server/claude-trader');
const { loadConfig, saveConfig } = require('../server/config');
const { kstParts } = require('../server/trend-follow');

const argv = process.argv.slice(2);
if (argv.includes('--on') || argv.includes('--off')) {
  saveConfig({ claudeTrader: { enabled: argv.includes('--on') } });
  const p = CT.effectiveParams(loadConfig().claudeTrader);
  console.log(`Claude 분석 선수: ${p.enabled ? `켬 — 매일 한국 ${p.runsKst.join('·')} · ${p.model} · 가상 ${p.capital} USDT · ${p.days}일 · −${p.maxLossPct}% 면 끝` : '끔'}`);
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

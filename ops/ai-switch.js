'use strict';
// AI 자동 분석 끄기/켜기(2026-10-15). 매매는 추세추종(trend-follow.js — 기계 규칙, claude 사용량 0)이 하고,
// AI 판정은 성적표에만 쌓이므로(2승 15패로 관문 미달) 자동 분석을 끄면 claude 사용량이 0 이 된다.
// 끄는 것: 급변동 자동 분석(watcher.autoAnalyze) · 하루 두 번 정기 분석(schedule.enabled).
// 그대로: 급변동 텔레그램 알림 · 추세추종 주문 · 대시보드에서 사람이 누르는 분석 · /floor.
//   node ops/ai-switch.js          # 지금 상태만 보기
//   node ops/ai-switch.js --off    # 끄기   → sudo systemctl restart trading-floor
//   node ops/ai-switch.js --on     # 다시 켜기 → sudo systemctl restart trading-floor
const { loadConfig, saveConfig } = require('../server/config');

// 설정 → { autoAnalyze, schedule, jobs, trend } 와 바꿀 내용(patch)
function describe(cfg) {
  const w = cfg.watcher || {};
  const s = cfg.schedule || {};
  return {
    autoAnalyze: !!(w.enabled && w.autoAnalyze),
    schedule: !!(s.enabled && Array.isArray(s.jobs) && s.jobs.length),
    jobs: Array.isArray(s.jobs) ? s.jobs.length : 0,
    trend: !!(cfg.trend && cfg.trend.enabled === true),
  };
}

function patchFor(mode) {
  if (mode === 'off') return { watcher: { autoAnalyze: false }, schedule: { enabled: false } };
  if (mode === 'on') return { watcher: { autoAnalyze: true }, schedule: { enabled: true } };
  return null;
}

function line(d) {
  return `AI 자동 분석 ${d.autoAnalyze ? '켜짐' : '꺼짐'} · 정기 분석 ${d.schedule ? `켜짐(${d.jobs}개)` : '꺼짐'} · 추세추종 주문 ${d.trend ? '켜짐' : '꺼짐'}`;
}

if (require.main === module) {
  const mode = process.argv.includes('--off') ? 'off' : process.argv.includes('--on') ? 'on' : null;
  const before = describe(loadConfig());
  console.log(`지금: ${line(before)}`);
  if (!mode) {
    console.log('바꾸려면 --off 또는 --on');
  } else {
    saveConfig(patchFor(mode));
    const after = describe(loadConfig());
    console.log(`바꾼 뒤: ${line(after)}`);
    if (!after.trend) console.log('주의: 추세추종도 꺼져 있어 지금은 아무 주문도 나가지 않습니다.');
    console.log('적용하려면: sudo systemctl restart trading-floor');
  }
}

module.exports = { describe, patchFor, line };

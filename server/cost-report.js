'use strict';

// cost-report.js — trigger-log.jsonl(한도와 무관한 실제 트리거 빈도) + cost-log.jsonl
// (분석 1회당 실제 비용)을 합쳐서, "API로 전환하면 한 달에 실제로 얼마 나올지"를
// 감이 아니라 데이터로 계산한다.
//
// 사용법: node server/cost-report.js [일수]
//   node server/cost-report.js       → 최근 7일
//   node server/cost-report.js 14    → 최근 14일

const triggerLog = require('./trigger-log');
const costLog = require('./cost-log');

function main() {
  const days = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 7;
  const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

  const triggers = triggerLog.readTriggerLog(sinceMs);
  const triggerStats = triggerLog.summarizeTriggers(triggers, days);

  const costs = costLog.readCostLog(sinceMs);
  const costStats = costLog.summarizeCosts(costs, days);

  console.log(`\n=== 최근 ${days}일 데이터 기준 ===\n`);

  console.log('[트리거 빈도 — 한도와 완전히 무관, "한도가 없었다면 실행됐을" 횟수]');
  console.log(`  총 ${triggerStats.count}건 · 하루 평균 ${triggerStats.perDay}건`);
  if (Object.keys(triggerStats.bySymbol).length) {
    console.log('  종목별:', JSON.stringify(triggerStats.bySymbol));
  }
  console.log('');

  console.log('[실제 분석 비용 — claude CLI --output-format json에서 실측]');
  if (costStats.knownCostCount === 0) {
    console.log('  아직 비용 정보가 있는 기록이 없습니다(분석이 한 번도 정상 완료되지 않았거나, 이 기능을 막 켠 직후일 수 있습니다).');
  } else {
    console.log(`  기록 ${costStats.count}건 중 비용 확인된 건 ${costStats.knownCostCount}건`);
    console.log(`  1회 평균: $${costStats.avgCostUsd}`);
    console.log(`  하루 평균 비용(측정 기간 실제 분석 완료 횟수 기준): $${costStats.perDayCostUsd}`);
  }
  console.log('');

  if (triggerStats.perDay > 0 && costStats.avgCostUsd != null) {
    const projectedDaily = Math.round(triggerStats.perDay * costStats.avgCostUsd * 100) / 100;
    const projectedMonthly = Math.round(projectedDaily * 22 * 100) / 100; // 평일 약 22일/월
    console.log('[API 전환 시 예상 비용 — 실제 트리거 빈도 × 실제 1회 평균 비용]');
    console.log(`  하루 예상: $${projectedDaily}`);
    console.log(`  한 달(평일 22일) 예상: $${projectedMonthly}`);
  } else {
    console.log('[API 전환 시 예상 비용]');
    console.log('  아직 계산할 데이터가 부족합니다 — 트리거 빈도와 실제 비용 데이터가 모두 필요합니다.');
    console.log('  며칠 더 가동한 뒤 다시 실행해 보세요.');
  }
  console.log('');
}

if (require.main === module) {
  main();
}

module.exports = { main };

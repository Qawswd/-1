'use strict';

// cleanup-failed-decisions.js — 한도 소진 등으로 실패한 분석이 "HOLD 확신도 0%"로
// decisions.json에 쌓여 있던 과거 기록을 정리한다. 이 기록들은 다음 분석의 "과거 판정
// 회고"에 가짜 판정으로 섞여 들어가고 성적표 통계도 왜곡한다(2026-09-24 발견).
// 이제는 엔진이 실패한 분석을 아예 기록하지 않지만, 이미 쌓인 것은 한 번 정리해야 한다.
//
// 기준: action이 HOLD이고 confidence가 정확히 0인 항목. 정상적인 HOLD 판정은 확신도가
// 0보다 크게 나오므로(관망에도 근거가 있다) 이 조합은 사실상 실패 기록뿐이다.
// 실행 전 원본을 decisions.json.bak으로 백업한다 — 잘못 지워도 되돌릴 수 있게.
//
// 사용법: node server/cleanup-failed-decisions.js          (미리보기만)
//         node server/cleanup-failed-decisions.js --apply  (실제 정리)

const fs = require('fs');
const path = require('path');

const DEC_PATH = path.join(__dirname, '..', 'reports', 'decisions.json');

function isFailedRecord(d) {
  return !!d && String(d.action || '').toUpperCase() === 'HOLD' && Number(d.confidence) === 0;
}

function main() {
  const apply = process.argv.includes('--apply');
  let arr;
  try {
    arr = JSON.parse(fs.readFileSync(DEC_PATH, 'utf8'));
  } catch (e) {
    console.log('decisions.json을 읽지 못했습니다:', e.message);
    return;
  }
  if (!Array.isArray(arr)) {
    console.log('decisions.json 형식이 배열이 아닙니다 — 건드리지 않습니다.');
    return;
  }
  const failed = arr.filter(isFailedRecord);
  const kept = arr.filter((d) => !isFailedRecord(d));
  console.log(`전체 ${arr.length}건 중 실패 기록(HOLD 0%) ${failed.length}건, 유지 ${kept.length}건`);
  failed.slice(0, 10).forEach((d) => console.log(`  - ${d.ts} ${d.symbol}`));
  if (failed.length > 10) console.log(`  ... 외 ${failed.length - 10}건`);
  if (!apply) {
    console.log('\n미리보기입니다. 실제로 정리하려면 --apply를 붙여 다시 실행하세요.');
    return;
  }
  if (!failed.length) {
    console.log('정리할 기록이 없습니다.');
    return;
  }
  fs.copyFileSync(DEC_PATH, DEC_PATH + '.bak');
  fs.writeFileSync(DEC_PATH, JSON.stringify(kept, null, 2), 'utf8');
  console.log(`\n정리 완료 — 원본은 decisions.json.bak에 백업했습니다.`);
}

if (require.main === module) main();

module.exports = { isFailedRecord };

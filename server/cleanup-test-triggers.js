'use strict';

// cleanup-test-triggers.js — npm test가 실제 trigger-log.jsonl에 남긴 가짜 행을 지운다.
// (테스트 중 실제 파일 쓰기는 이제 막혔지만, 그 전에 쌓인 것은 한 번 정리해야 한다.)
// 기준: kind가 비어 있는 행. 실제 감시 신호는 항상 종류(move 등)가 있다.
//
// 사용법: node server/cleanup-test-triggers.js          (미리보기)
//         node server/cleanup-test-triggers.js --apply  (실제 정리, .bak 백업)

const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'reports', 'trigger-log.jsonl');

function isTestRow(r) {
  return !!r && (r.kind === null || r.kind === undefined || r.kind === '');
}

function main() {
  const apply = process.argv.includes('--apply');
  let text;
  try {
    text = fs.readFileSync(LOG_PATH, 'utf8');
  } catch (e) {
    console.log('trigger-log.jsonl이 없습니다 — 정리할 것이 없습니다.');
    return;
  }
  const lines = text.split('\n').filter((l) => l.trim());
  const keep = [];
  let removed = 0;
  let broken = 0;
  for (const line of lines) {
    let r;
    try {
      r = JSON.parse(line);
    } catch (_) {
      broken += 1;
      keep.push(line); // 해석 못 한 줄은 지우지 않는다(보수적으로)
      continue;
    }
    if (isTestRow(r)) removed += 1;
    else keep.push(line);
  }
  console.log(`전체 ${lines.length}줄 중 테스트 흔적 ${removed}줄, 유지 ${keep.length}줄(해석 불가 ${broken}줄 포함)`);
  if (!apply) {
    console.log('미리보기입니다. 정리하려면 --apply를 붙여 다시 실행하세요.');
    return;
  }
  if (!removed) {
    console.log('정리할 줄이 없습니다.');
    return;
  }
  fs.copyFileSync(LOG_PATH, LOG_PATH + '.bak');
  fs.writeFileSync(LOG_PATH, keep.length ? keep.join('\n') + '\n' : '', 'utf8');
  console.log('정리 완료 — 원본은 trigger-log.jsonl.bak에 백업했습니다.');
}

if (require.main === module) main();
module.exports = { isTestRow };

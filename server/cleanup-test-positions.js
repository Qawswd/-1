'use strict';

// cleanup-test-positions.js — reports/positions.json(가상 포지션 장부)에서
// source:"verify-script"로 표시된 항목만 제거한다. 이건 배선 검증(verify-decision-
// pipeline.js)을 돌릴 때 실제 프로덕션 코드를 그대로 태우다 보니 이 장부에도 그대로
// 기록된 테스트 흔적이다 — 진짜 AI 판정이 아니므로 성적표 계산을 왜곡한다.
//
// source가 "verify-script"가 아닌 항목(진짜 AI 자동판정 등)은 절대 건드리지 않는다.
// 실행 전 원본을 .bak으로 백업해둔다(되돌릴 수 있게).
//
// 실행: node server/cleanup-test-positions.js

const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'reports', 'positions.json');

function main() {
  if (!fs.existsSync(file)) {
    console.error('파일이 없습니다:', file);
    process.exit(1);
  }

  const raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);

  const backupPath = file + '.bak-' + Date.now();
  fs.writeFileSync(backupPath, raw);
  console.log(`원본 백업: ${backupPath}`);

  const open = Array.isArray(data.open) ? data.open : [];
  const closed = Array.isArray(data.closed) ? data.closed : [];

  const removedOpen = open.filter((p) => p && p.source === 'verify-script');
  const removedClosed = closed.filter((p) => p && p.source === 'verify-script');

  data.open = open.filter((p) => !p || p.source !== 'verify-script');
  data.closed = closed.filter((p) => !p || p.source !== 'verify-script');

  fs.writeFileSync(file, JSON.stringify(data, null, 2));

  console.log('\n=== 제거된 항목 ===');
  [...removedOpen, ...removedClosed].forEach((p) => {
    console.log(`  ${p.symbol || '?'} ${p.side || '?'} @ ${p.entry || '?'} (${p.openedAt || '시각 불명'})`);
  });

  console.log(`\nopen:   ${open.length} → ${data.open.length}건 (제거 ${removedOpen.length}건)`);
  console.log(`closed: ${closed.length} → ${data.closed.length}건 (제거 ${removedClosed.length}건)`);
  console.log('\n완료.');
}

main();

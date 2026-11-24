'use strict';

// verify-decision-pipeline.js — 한도(Claude 사용량) 0 소모 검증 스크립트.
//
// AI(12명 파이프라인)가 "BUY"라고 결론 내렸다고 "가정"하고, 그 이후에 실제로 일어나는
// 프로덕션 코드 경로를 한 글자도 바꾸지 않고 그대로 태운다:
//   가짜 decision → positions.openFromDecision(진짜 함수) → pos 객체
//                 → engine._executeOnExchange(진짜 함수) → 거래소 주문
// 실제 시세(market.fetchMarket)는 그대로 조회한다 — 가짜인 건 "AI가 BUY라고 말했다"는
// 사실 하나뿐이다.
//
// 실행: node server/verify-decision-pipeline.js [심볼]

const fs = require('fs');
const path = require('path');

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

const { resolveSymbol, fetchMarket } = require('./market');
const positions = require('./positions');
const { loadConfig } = require('./config');
const { Engine } = require('./engine');

async function main() {
  const symArg = process.argv[2] || 'BTC';
  console.log(`=== 판정→실행 배선 검증(AI 호출 없음): ${symArg} ===\n`);

  const cfg = loadConfig();
  if (!cfg.execution || cfg.execution.enabled !== true) {
    console.log('⚠ config.json의 execution.enabled가 true가 아닙니다. 실행 단계는 건너뜁니다.');
  }

  // 1) 진짜 시세 조회(프로덕션 코드 그대로)
  const resolved = resolveSymbol(symArg);
  const market = await fetchMarket(resolved);
  const price = market.indicators && market.indicators.price;
  if (!(price > 0)) {
    console.error('현재가를 못 읽었습니다:', JSON.stringify(market.indicators));
    process.exit(1);
  }
  console.log(`실제 현재가: ${price} (symbol=${market.symbol})`);

  // 2) "AI가 이렇게 판단했다"고 가정하는 부분 — 여기만 가짜다.
  //    손절 2%, 목표 4% — 임의값이 아니라 "배선이 도는지"만 볼 검증용 숫자다.
  const decision = {
    action: 'BUY',
    confidence: 60,
    entry: price,
    stop: Number((price * 0.98).toFixed(2)),
    target: Number((price * 1.04).toFixed(2)),
  };
  console.log('\n가정한 판정(AI 대신 스크립트가 채움):', JSON.stringify(decision));

  // 3) 여기서부터는 실제 프로덕션 함수 — 수정 없음.
  const pos = positions.openFromDecision(decision, market, cfg, {
    mode: 'algo',
    source: 'verify-script', // 실제 AI 판정과 구분되도록 표시 — 나중에 장부에서 알아볼 수 있다
  });

  if (!pos) {
    console.error('\n❌ openFromDecision이 null을 반환했습니다 — 포지션이 열리지 않았습니다.');
    console.error('(원인 후보: 손절가 계산 실패, 진입가 0 이하 등)');
    process.exit(1);
  }
  console.log('\n✅ 가상 포지션 생성됨(reports/positions.json에 기록, source:"verify-script"):');
  console.log(JSON.stringify(pos, null, 2));

  if (!cfg.execution || cfg.execution.enabled !== true) {
    console.log('\nexecution.enabled가 꺼져 있어 여기서 종료합니다(정상).');
    return;
  }

  // 4) 실제 거래소 실행 — engine.js의 프로덕션 함수 그대로 호출.
  console.log('\n=== 거래소 실행 단계 ===');
  const engine = new Engine();
  await engine._executeOnExchange(pos, cfg.execution);
  console.log('\n=== 검증 스크립트 종료 ===');
}

main().catch((e) => {
  console.error('스크립트 자체 오류:', e);
  process.exit(1);
});

'use strict';

// verify-portfolio-and-streak.js — 오늘 새로 만든 두 안전장치(전체 포트폴리오 노출 한도,
// 연속 손실 서킷 브레이커)가 실제 바이낸스 API로 정상 조회되는지 확인한다.
// 지금까지 실전 버그(심볼 형식, algoOrder 엔드포인트)가 전부 "가짜 테스트는 통과했는데
// 진짜 API에서 다르게 동작한" 경우였어서, 이 두 기능도 로컬 가짜 데이터 검증만으론
// 부족하다 — 진짜 요청을 한 번 날려서 응답 형태가 예상과 같은지 봐야 한다.
//
// 실행: node server/verify-portfolio-and-streak.js

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

const exchange = require('./exchange');

async function main() {
  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET || !process.env.BINANCE_FUTURES_BASE_URL) {
    console.error('환경변수(BINANCE_API_KEY 등)가 없습니다. .env를 확인하세요.');
    process.exit(1);
  }

  let client;
  try {
    client = exchange.createClient({
      apiKey: process.env.BINANCE_API_KEY,
      apiSecret: process.env.BINANCE_API_SECRET,
      baseUrl: process.env.BINANCE_FUTURES_BASE_URL,
    });
  } catch (e) {
    console.error('클라이언트 생성 실패:', e.message);
    process.exit(1);
  }

  console.log('=== 1) 전체 포지션 조회 (getPosition, 심볼 없이) ===');
  try {
    const raw = await client.getPosition();
    console.log(`원본 응답: ${Array.isArray(raw) ? raw.length + '개 항목' : typeof raw}`);
    const positions = exchange.summarizeAllOpenPositions(raw);
    console.log(`열려있는 포지션: ${positions.length}개`);
    positions.forEach((p) => {
      console.log(`  ${p.symbol} ${p.side} 수량 ${p.quantity} @ ${p.entry} (현재 ${p.markPrice}, ${p.unrealizedPct}%)`);
    });
    const total = exchange.totalNotionalOf(positions);
    console.log(`전체 명목가 합계: ${total} USDT`);
    console.log('✅ 성공 — 실제 API 응답을 정상적으로 파싱했습니다.');
  } catch (e) {
    console.error('❌ 실패:', e.message);
  }

  console.log('\n=== 2) 최근 30일 실현손익 조회 (getIncomeHistory, 넓은 범위) ===');
  try {
    const now = Date.now();
    const start = now - 30 * 24 * 60 * 60 * 1000;
    const records = await client.getIncomeHistory({ startTime: start, endTime: now, limit: 1000 });
    console.log(`원본 응답: ${Array.isArray(records) ? records.length + '건' : typeof records}`);
    const realized = Array.isArray(records) ? records.filter((r) => r.incomeType === 'REALIZED_PNL') : [];
    console.log(`REALIZED_PNL 건수: ${realized.length}건`);
    const { count, lastLossTime } = exchange.countConsecutiveLosses(records);
    console.log(`현재 연속 손실 횟수: ${count}회` + (lastLossTime ? ` (마지막: ${new Date(lastLossTime).toISOString()})` : ''));
    const sum = exchange.sumRealizedPnl(records);
    console.log(`30일 실현손익 합계: ${sum} USDT`);
    console.log('✅ 성공 — 실제 API 응답을 정상적으로 파싱했습니다.');
  } catch (e) {
    console.error('❌ 실패:', e.message);
  }

  console.log('\n=== 검증 스크립트 종료 ===');
}

main().catch((e) => {
  console.error('스크립트 자체 오류:', e);
  process.exit(1);
});

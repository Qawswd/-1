import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildExecutionHtml,
  sendExecutionEvent,
  sendMessage,
  isEnabled,
  buildDailySummaryHtml,
  sendDailySummary,
  buildAlertHtml,
  hhmmKst,
  _setFetch,
} = require('../server/notify.js');

const TG_CFG = { telegram: { enabled: true, botToken: 'fake-token', chatId: '12345' } };

test('buildExecutionHtml: 진입 성공 — 심볼·방향·수량·손절 트리거가 다 들어간다', () => {
  const html = buildExecutionHtml({
    ok: true,
    entryOrder: { symbol: 'BTCUSDT', side: 'BUY' },
    stopOrder: { triggerPrice: '74918.2' },
    executed: { qty: 0.013, notional: 1000, cappedByMax: true },
  });
  assert.match(html, /실거래 진입 완료/);
  assert.match(html, /BTCUSDT/);
  assert.match(html, /BUY/);
  assert.match(html, /74,918/);
  assert.match(html, /포지션 상한 적용/);
  assert.match(html, /레버리지 1배/);
});

test('buildExecutionHtml: 하루 손실 한도 초과', () => {
  const html = buildExecutionHtml({
    ok: false,
    dailyLossLimit: { blocked: true, realizedPnl: -300, maxLossUsd: 250 },
  });
  assert.match(html, /하루 손실 한도 초과/);
  assert.match(html, /-300/);
  assert.match(html, /250/);
});

test('buildExecutionHtml: 포지션 충돌 — KEEP이면 유지 메시지, 이유 포함', () => {
  const html = buildExecutionHtml({
    ok: false,
    conflict: {
      existing: { side: 'LONG', entry: 76500 },
      verdict: { action: 'KEEP', reasoning: '확신도 차이가 크지 않아 유지합니다.' },
    },
  });
  assert.match(html, /기존 포지션 유지/);
  assert.match(html, /확신도 차이가 크지 않아 유지합니다/);
});

test('buildExecutionHtml: 손절 실패했지만 즉시 청산 성공 — 경고 톤', () => {
  const html = buildExecutionHtml({
    ok: false,
    stopFailed: true,
    flattened: true,
    error: '손절 주문 실패라 포지션을 즉시 청산했습니다',
  });
  assert.match(html, /손절 제출 실패/);
  assert.match(html, /즉시 청산됨/);
});

test('buildExecutionHtml: 손절도 청산도 실패 — 긴급 톤, 직접 확인 문구', () => {
  const html = buildExecutionHtml({
    ok: false,
    stopFailed: true,
    flattened: false,
    error: '손절도 긴급 청산도 모두 실패했습니다',
  });
  assert.match(html, /긴급/);
  assert.match(html, /직접 확인/);
});

test('buildExecutionHtml: 그 외 일반 실패는 실행 실패 메시지로', () => {
  const html = buildExecutionHtml({ ok: false, error: '레버리지 설정 실패' });
  assert.match(html, /실거래 실행 실패/);
  assert.match(html, /레버리지 설정 실패/);
});

test('buildExecutionHtml: HTML 특수문자가 이유 텍스트에 있어도 이스케이프된다', () => {
  const html = buildExecutionHtml({ ok: false, error: '<script>alert(1)</script>' });
  assert.ok(!html.includes('<script>'));
});

test('sendExecutionEvent: 텔레그램 비활성이면 전송 시도 안 하고 실패 반환', async () => {
  const res = await sendExecutionEvent({ ok: true }, { telegram: { enabled: false } });
  assert.equal(res.ok, false);
});

test('sendExecutionEvent: 활성화 상태면 실제로 fetch를 호출한다(가짜 fetch로 확인)', async () => {
  let called = false;
  let sentBody = null;
  _setFetch(async (url, opts) => {
    called = true;
    sentBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  });
  const res = await sendExecutionEvent({ ok: true, entryOrder: { symbol: 'BTCUSDT', side: 'BUY' } }, TG_CFG);
  _setFetch(null); // 원상복구
  assert.equal(called, true);
  assert.equal(res.ok, true);
  assert.match(sentBody.text, /BTCUSDT/);
});

// --- 텔레그램 토큰: 환경변수(.env) 우선, config.json은 폴백 ------------------------
// BINANCE_API_KEY와 같은 원칙 — config.json은 HTTP POST로 고칠 수 있는 파일이라
// 실제 비밀값을 거기 두면 유출 경로가 된다.

test('isEnabled: TELEGRAM_BOT_TOKEN 환경변수만 있어도(config는 비어도) 활성화된다', () => {
  const prev = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'env-token';
  try {
    const res = isEnabled({ telegram: { enabled: true, botToken: '', chatId: '12345' } });
    assert.equal(res, true);
  } finally {
    if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prev;
  }
});

test('isEnabled: 환경변수가 없으면 config.json의 botToken으로 폴백한다(과거 설정 호환)', () => {
  const prev = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    const res = isEnabled({ telegram: { enabled: true, botToken: 'config-token', chatId: '12345' } });
    assert.equal(res, true);
  } finally {
    if (prev !== undefined) process.env.TELEGRAM_BOT_TOKEN = prev;
  }
});

test('isEnabled: 환경변수도 config도 둘 다 없으면 false', () => {
  const prev = process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  try {
    const res = isEnabled({ telegram: { enabled: true, botToken: '', chatId: '12345' } });
    assert.equal(res, false);
  } finally {
    if (prev !== undefined) process.env.TELEGRAM_BOT_TOKEN = prev;
  }
});

test('sendMessage: 환경변수 토큰이 있으면 config.json 토큰이 아니라 환경변수 토큰으로 실제 요청을 보낸다', async () => {
  const prev = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'env-wins-token';
  let calledUrl = null;
  _setFetch(async (url, opts) => {
    calledUrl = url;
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  });
  try {
    await sendMessage('테스트', { telegram: { enabled: true, botToken: 'config-token-should-be-ignored', chatId: '12345' } });
    assert.match(calledUrl, /env-wins-token/);
    assert.ok(!calledUrl.includes('config-token-should-be-ignored'));
  } finally {
    _setFetch(null);
    if (prev === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prev;
  }
});

// --- buildDailySummaryHtml / sendDailySummary ------------------------------------

test('buildDailySummaryHtml: 실현손익이 양수면 +부호가 붙는다', () => {
  const html = buildDailySummaryHtml({ realizedPnl: 42.5, positions: [] });
  assert.match(html, /일간 요약/);
  assert.match(html, /\+42\.50 USDT/);
  assert.match(html, /지금 열려있는 포지션 없음/);
});

test('buildDailySummaryHtml: 실현손익이 음수면 부호를 억지로 안 붙인다(마이너스 기호가 이미 있음)', () => {
  const html = buildDailySummaryHtml({ realizedPnl: -15, positions: [] });
  assert.match(html, /-15\.00 USDT/);
  assert.ok(!html.includes('+-15'));
});

test('buildDailySummaryHtml: 손익 조회 실패(null)면 그 사실을 그대로 알린다', () => {
  const html = buildDailySummaryHtml({ realizedPnl: null, positions: [] });
  assert.match(html, /조회 실패/);
});

test('buildDailySummaryHtml: 열린 포지션 목록이 방향·손익%과 함께 표시된다', () => {
  const html = buildDailySummaryHtml({
    realizedPnl: 0,
    positions: [
      { symbol: 'BTCUSDT', side: 'LONG', unrealizedPct: 6.2 },
      { symbol: 'AAPLUSDT', side: 'SHORT', unrealizedPct: -1.1 },
    ],
  });
  assert.match(html, /BTCUSDT 롱 \+6\.2%/);
  assert.match(html, /AAPLUSDT 숏 -1\.1%/);
  assert.match(html, /\(2개\)/);
});

test('sendDailySummary: 텔레그램 활성화 상태면 실제로 fetch를 호출한다', async () => {
  let called = false;
  let sentText = null;
  _setFetch(async (url, opts) => {
    called = true;
    sentText = JSON.parse(opts.body).text;
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  });
  try {
    const res = await sendDailySummary({ realizedPnl: 10, positions: [] }, TG_CFG);
    assert.equal(called, true);
    assert.equal(res.ok, true);
    assert.match(sentText, /일간 요약/);
  } finally {
    _setFetch(null);
  }
});

// --- 검색용 고유 표시(💰) — 감시 알림(빈번함)과 실거래 메시지(중요함)를 구분하기 위함 ------

test('buildExecutionHtml: 모든 케이스 앞에 💰가 붙는다(검색으로 걸러볼 수 있게)', () => {
  const cases = [
    { ok: true, entryOrder: { symbol: 'BTCUSDT', side: 'BUY' }, stopOrder: {}, executed: {} },
    { ok: false, dailyLossLimit: { blocked: true, realizedPnl: -10, maxLossUsd: 5 } },
    { ok: false, conflict: { existing: { side: 'LONG', entry: 100 }, verdict: { action: 'KEEP', reasoning: 'x' } } },
    { ok: false, stopFailed: true, flattened: true, error: 'x' },
    { ok: false, stopFailed: true, flattened: false, error: 'x' },
    { ok: false, error: '일반 실패' },
  ];
  for (const c of cases) {
    assert.ok(buildExecutionHtml(c).startsWith('💰 '), `💰로 시작해야 함: ${JSON.stringify(c)}`);
  }
});

test('buildDailySummaryHtml: 💰가 붙는다', () => {
  assert.ok(buildDailySummaryHtml({ realizedPnl: 0, positions: [] }).startsWith('💰 '));
});

test('buildAlertHtml(감시 알림)에는 💰가 없다 — 검색 시 실거래 메시지와 안 섞인다', () => {
  const html = buildAlertHtml({ kind: 'volume', severity: 'warn', display: 'BTC', message: '거래량 급증', ts: Date.now() });
  assert.ok(!html.includes('💰'));
});

// --- hhmmKst — 서버가 UTC로 돌아도(AWS) 정확한 한국시간을 내야 한다 --------------------
// 실전에서 실제로 9시간 어긋나게 표시되던 버그의 회귀 방지.

test('hhmmKst: UTC 시각을 정확히 한국시간(UTC+9)으로 변환한다', () => {
  // 06:35 UTC → 15:35 KST
  assert.equal(hhmmKst(new Date('2026-09-19T06:35:00Z').getTime()), '15:35');
});

test('hhmmKst: 자정을 넘나드는 경우도 정확하다(UTC 저녁 → KST 다음날 새벽)', () => {
  // 2026-09-18 16:30 UTC → 2026-09-19 01:30 KST(날짜가 넘어간다)
  assert.equal(hhmmKst(new Date('2026-09-18T16:30:00Z').getTime()), '01:30');
});

test('hhmmKst: 유효하지 않은 타임스탬프는 빈 문자열(에러 안 던짐)', () => {
  assert.equal(hhmmKst('not-a-real-date'), '');
});

// --- 포지션 청산 검토 메시지(review) — 익절/손절선 조정 --------------------------

test('buildExecutionHtml: review type:exit 성공 시 💵 익절 메시지', () => {
  const html = buildExecutionHtml({
    review: { type: 'exit', symbol: 'BTCUSDT', reasoning: '목표가에 도달해 확정합니다.', resultOk: true },
  });
  assert.match(html, /💵/);
  assert.match(html, /포지션 청산/);
  assert.match(html, /목표가에 도달해 확정합니다/);
  assert.ok(html.startsWith('💰 ')); // 검색용 표시도 그대로 붙는다
});

test('buildExecutionHtml: review type:exit 실패 시 경고 아이콘 + 실패 사유', () => {
  const html = buildExecutionHtml({
    review: { type: 'exit', symbol: 'BTCUSDT', reasoning: '청산하려 했습니다.', resultOk: false, resultError: '청산 주문 거부' },
  });
  assert.match(html, /⚠️/);
  assert.match(html, /청산 시도 실패/);
  assert.match(html, /청산 주문 거부/);
});

test('buildExecutionHtml: review type:tighten_stop 성공 시 🔒 메시지, 새 손절가 표시', () => {
  const html = buildExecutionHtml({
    review: { type: 'tighten_stop', symbol: 'BTCUSDT', newStopPrice: 80000, reasoning: '이익 보호 차원.', resultOk: true },
  });
  assert.match(html, /🔒/);
  assert.match(html, /손절선 조정/);
  assert.match(html, /80,000/);
});

test('buildExecutionHtml: review type:tighten_stop 실패 시 적용 실패 문구', () => {
  const html = buildExecutionHtml({
    review: { type: 'tighten_stop', symbol: 'BTCUSDT', newStopPrice: 80000, reasoning: 'x', resultOk: false, resultError: '제출 거부' },
  });
  assert.match(html, /적용 실패/);
  assert.match(html, /제출 거부/);
});

// --- 전체 포트폴리오 노출 한도 메시지 --------------------------------------------

test('buildExecutionHtml: 포트폴리오 노출 한도 초과 메시지', () => {
  const html = buildExecutionHtml({
    ok: false,
    portfolioExposure: { blocked: true, currentTotal: 2608, projectedTotal: 3608, maxAllowed: 3000 },
  });
  assert.match(html, /전체 포트폴리오 노출 한도 초과/);
  assert.match(html, /2,608/);
  assert.match(html, /3,608/);
  assert.match(html, /3,000/);
  assert.ok(html.startsWith('💰 '));
});

// --- 연속 손실 일시정지 메시지 ----------------------------------------------------

test('buildExecutionHtml: 연속 손실 일시정지 메시지', () => {
  const html = buildExecutionHtml({
    ok: false,
    consecutiveLossPause: { paused: true, consecutiveLosses: 3, cooldownHours: 12 },
  });
  assert.match(html, /연속 손실 일시정지/);
  assert.match(html, /연속 3회/);
  assert.match(html, /쿨다운 12시간/);
  assert.ok(html.startsWith('💰 '));
});

// --- 서버 재시작 점검 메시지 ------------------------------------------------------

test('buildExecutionHtml: 재시작 점검 — 원래 손절가로 복원된 경우', () => {
  const html = buildExecutionHtml({
    startupAudit: { checked: 2, unprotected: ['BTCUSDT'], fixed: [{ symbol: 'BTCUSDT', stop: 78000 }], flattened: [], failed: [] },
  });
  assert.match(html, /서버 재시작 점검/);
  assert.match(html, /무보호 포지션 1건/);
  assert.match(html, /원래 손절가로 복원/);
  assert.match(html, /BTCUSDT@78,000/);
  assert.ok(html.startsWith('💰 '));
});

test('buildExecutionHtml: 재시작 점검 — 안전하게 청산된 경우', () => {
  const html = buildExecutionHtml({
    startupAudit: { checked: 1, unprotected: ['AAPLUSDT'], fixed: [], flattened: ['AAPLUSDT'], failed: [] },
  });
  assert.match(html, /안전하게 청산/);
  assert.match(html, /AAPLUSDT/);
});

test('buildExecutionHtml: 재시작 점검 — 자동 조치까지 실패한 경우 직접 확인 문구', () => {
  const html = buildExecutionHtml({
    startupAudit: { checked: 1, unprotected: ['BTCUSDT'], fixed: [], flattened: [], failed: [{ symbol: 'BTCUSDT', error: 'x' }] },
  });
  assert.match(html, /자동 조치 실패/);
  assert.match(html, /직접 확인 필요/);
});

// --- 정합성 점검 메시지 -----------------------------------------------------------

test('buildExecutionHtml: 정합성 점검 — stale 자동 정리된 경우', () => {
  const html = buildExecutionHtml({ reconcile: { staleClosedCount: 2, orphanCount: 0, orphanSymbols: [] } });
  assert.match(html, /정합성 점검/);
  assert.match(html, /2건을 자동으로 정리/);
});

test('buildExecutionHtml: 정합성 점검 — orphan 보고만 하는 경우', () => {
  const html = buildExecutionHtml({ reconcile: { staleClosedCount: 0, orphanCount: 1, orphanSymbols: ['AAPLUSDT'] } });
  assert.match(html, /로컬 기록이 없는 포지션 1건/);
  assert.match(html, /AAPLUSDT/);
  assert.match(html, /자동 복원은 안 했습니다/);
});

// --- 일간 요약: 순손익과 비용 내역(R09) ---------------------------------------------

test('buildDailySummaryHtml: 내역이 있으면 순손익을 먼저 쓰고 실현손익·수수료·펀딩을 따로 보여준다', () => {
  const html = buildDailySummaryHtml({
    realizedPnl: -11.5,
    positions: [],
    incomeBreakdown: { realized: -10.7, commission: -0.92, funding: 0.12, net: -11.5 },
  });
  assert.match(html, /순손익: -11\.50 USDT/);
  assert.match(html, /실현손익 -10\.70/);
  assert.match(html, /수수료 -0\.92/);
  assert.match(html, /펀딩 \+0\.12/);
});

test('buildDailySummaryHtml: 감시 활동 줄 — 트리거·예약 분석·15분 최대 변동을 붙인다', () => {
  const { buildDailySummaryHtml, buildActivityLine } = require('../server/notify.js');
  const html = buildDailySummaryHtml({
    realizedPnl: 0,
    positions: [],
    activity: { moveTriggers: 0, scheduledRuns: 2, maxMove15mPct: -0.57, maxMoveSymbol: 'BTC' },
  });
  assert.match(html, /감시 활동\(24h\): 급변동 트리거 0회 · 예약 분석 2회 · BTC 15분 최대 변동 -0\.57%/);
  assert.equal(buildActivityLine(null), null);
  assert.equal(buildActivityLine({}), null);
  assert.equal(buildActivityLine({ moveTriggers: 3 }), '감시 활동(24h): 급변동 트리거 3회');
  assert.doesNotMatch(buildDailySummaryHtml({ realizedPnl: 0, positions: [] }), /감시 활동/);
});

test('buildExecutionHtml: 기대값 게이트 차단 메시지 · 데모 주소면 "데모 계좌 진입 완료"', () => {
  const { buildExecutionHtml } = require('../server/notify.js');
  const blocked = buildExecutionHtml({ ok: false, error: 'x', edgeGate: { blocked: true, confidence: 40, rr: 1.8, evR: 0.12, minEvR: 0.2, breakEvenConfidence: 43, reason: '기대값 부족' } });
  assert.match(blocked, /주문 안 함 — 기대값 부족/);
  assert.match(blocked, /확신도 40% · 손익비 1 : 1.8 → 기대값 \+0.12R \(기준 \+0.2R\)/);
  assert.match(blocked, /확신도 43% 이상/);
  assert.match(buildExecutionHtml({ ok: false, edgeGate: { blocked: true, evR: null, reason: '확신도 없음' } }), /주문 안 함 — 확신도 없음/);
  const prev = process.env.BINANCE_FUTURES_BASE_URL;
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  try {
    const ok = buildExecutionHtml({ ok: true, entryOrder: { symbol: 'BTCUSDT', side: 'BUY' }, executed: { qty: 0.012 } });
    assert.match(ok, /데모 계좌 진입 완료/);
    assert.doesNotMatch(ok, /실거래/);
  } finally {
    if (prev === undefined) delete process.env.BINANCE_FUTURES_BASE_URL;
    else process.env.BINANCE_FUTURES_BASE_URL = prev;
  }
});

test('buildDecisionHtml: 1배 판정에는 청산 경고를 붙이지 않는다(손절보다 청산이 먼저인 설계만 경고)', () => {
  const { buildDecisionHtml } = require('../server/notify.js');
  const base = { symbol: 'BTC', action: 'BUY', confidence: 70, entry: '83491', stop: '82581', target: '87396', liq: 417.45, leverage: 1 };
  assert.doesNotMatch(buildDecisionHtml(base, { display: 'BTC' }, {}), /청산 경고/);
  assert.match(buildDecisionHtml({ ...base, stopBeyondLiq: true }, { display: 'BTC' }, {}), /청산 경고/);
});

test('buildActivityLine: 예약 분석을 매매·관망으로 나눠 적는다', () => {
  const { buildActivityLine } = require('../server/notify.js');
  assert.equal(
    buildActivityLine({ moveTriggers: 0, scheduledRuns: 2, scheduledDirectional: 1, scheduledHold: 1 }),
    '감시 활동(24h): 급변동 트리거 0회 · 예약 분석 2회(매매 1 · 관망 1)'
  );
});

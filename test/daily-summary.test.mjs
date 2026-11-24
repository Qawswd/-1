import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DailySummaryScheduler, shouldSend, nyDateKey, nyHHMM } = require('../server/daily-summary.js');

// --- 순수 함수 ---------------------------------------------------------------

test('nyHHMM: UTC 시각을 뉴욕 현지 HH:MM으로 정확히 변환한다(EDT)', () => {
  // 2026-07-01 20:05 UTC = 16:05 EDT
  assert.equal(nyHHMM(new Date('2026-07-01T20:05:00Z')), '16:05');
});

test('shouldSend: 오늘 아직 안 보냈고 지정 시각을 지났으면 true', () => {
  const now = new Date('2026-07-01T20:05:00Z'); // 16:05 EDT
  assert.equal(shouldSend({ now, atHHMM: '16:05', lastSentDateKey: null }), true);
});

test('shouldSend: 지정 시각 전이면 false', () => {
  const now = new Date('2026-07-01T20:00:00Z'); // 16:00 EDT
  assert.equal(shouldSend({ now, atHHMM: '16:05', lastSentDateKey: null }), false);
});

test('shouldSend: 오늘 이미 보냈으면(lastSentDateKey가 오늘) 시각이 지났어도 false — 하루 한 번만', () => {
  const now = new Date('2026-07-01T21:00:00Z'); // 17:00 EDT, 한참 지남
  const todayKey = nyDateKey(now);
  assert.equal(shouldSend({ now, atHHMM: '16:05', lastSentDateKey: todayKey }), false);
});

test('shouldSend: lastSentDateKey가 어제 날짜면(날짜가 바뀌었으면) 다시 true', () => {
  const now = new Date('2026-07-02T20:10:00Z'); // 다음날 16:10 EDT
  const yesterdayKey = nyDateKey(new Date('2026-07-01T20:10:00Z'));
  assert.equal(shouldSend({ now, atHHMM: '16:05', lastSentDateKey: yesterdayKey }), true);
});

// --- DailySummaryScheduler._tick (가짜 모듈 주입) ---------------------------------

function makeDeps({ realizedPnl = 12.34, positions = [], sendFails = false, reconcileFails = false } = {}) {
  const sent = [];
  const reconcileCalls = [];
  const exchangeMod = {
    createClient: () => ({
      getIncomeHistory: async () => [{ incomeType: 'REALIZED_PNL', income: String(realizedPnl) }],
      getPosition: async () => [],
    }),
    sumRealizedPnl: () => realizedPnl,
    summarizeAllOpenPositions: () => positions,
  };
  const notifyMod = {
    sendDailySummary: async (data, cfg) => {
      if (sendFails) throw new Error('발송 실패 시뮬레이션');
      sent.push({ data, cfg });
      return { ok: true };
    },
  };
  const positionsMod = { listPositions: () => ({ open: [] }) };
  const reconcileMod = {
    reconcilePositions: async (args) => {
      if (reconcileFails) throw new Error('정합성 점검 실패 시뮬레이션');
      reconcileCalls.push(args);
      return { staleClosedCount: 0, orphanCount: 0, orphanSymbols: [] };
    },
  };
  return { exchangeMod, notifyMod, positionsMod, reconcileMod, sent, reconcileCalls };
}

test('_tick: dailySummary.enabled가 false면 아무것도 안 한다', async () => {
  const { exchangeMod, notifyMod, sent } = makeDeps();
  const s = new DailySummaryScheduler({
    loadConfig: () => ({ dailySummary: { enabled: false, atHHMM: '16:05' } }),
    exchangeMod,
    notifyMod,
  });
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  await s._tick(new Date('2026-07-01T20:10:00Z'));
  assert.equal(sent.length, 0);
});

test('_tick: 아직 시각 전이면 안 보낸다', async () => {
  const { exchangeMod, notifyMod, sent } = makeDeps();
  const s = new DailySummaryScheduler({
    loadConfig: () => ({ dailySummary: { enabled: true, atHHMM: '16:05' } }),
    exchangeMod,
    notifyMod,
  });
  await s._tick(new Date('2026-07-01T19:00:00Z')); // 15:00 EDT
  assert.equal(sent.length, 0);
});

test('_tick: 활성화 + 시각 지남 + 실행 설정 있음 → 실제로 발송하고 lastSentDateKey를 오늘로 표시', async () => {
  const { exchangeMod, notifyMod, sent } = makeDeps({ realizedPnl: 42, positions: [{ symbol: 'BTCUSDT', side: 'LONG', unrealizedPct: 5 }] });
  const s = new DailySummaryScheduler({
    loadConfig: () => ({ dailySummary: { enabled: true, atHHMM: '16:05' } }),
    exchangeMod,
    notifyMod,
  });
  const now = new Date('2026-07-01T20:10:00Z');
  await s._tick(now);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.realizedPnl, 42);
  assert.equal(sent[0].data.positions.length, 1);
  assert.equal(s.lastSentDateKey, nyDateKey(now));
});

test('_tick: 같은 날 두 번 tick이 돌아도 한 번만 보낸다', async () => {
  const { exchangeMod, notifyMod, sent } = makeDeps();
  const s = new DailySummaryScheduler({
    loadConfig: () => ({ dailySummary: { enabled: true, atHHMM: '16:05' } }),
    exchangeMod,
    notifyMod,
  });
  await s._tick(new Date('2026-07-01T20:10:00Z'));
  await s._tick(new Date('2026-07-01T20:30:00Z')); // 같은 날 나중 시각
  assert.equal(sent.length, 1);
});

test('_tick: 실행(BINANCE_*) 환경변수가 없으면 조용히 건너뛴다(에러 던지지 않음)', async () => {
  const prevKey = process.env.BINANCE_API_KEY;
  const prevSecret = process.env.BINANCE_API_SECRET;
  const prevUrl = process.env.BINANCE_FUTURES_BASE_URL;
  delete process.env.BINANCE_API_KEY;
  delete process.env.BINANCE_API_SECRET;
  delete process.env.BINANCE_FUTURES_BASE_URL;
  try {
    const { exchangeMod, notifyMod, sent } = makeDeps();
    const s = new DailySummaryScheduler({
      loadConfig: () => ({ dailySummary: { enabled: true, atHHMM: '16:05' } }),
      exchangeMod,
      notifyMod,
    });
    await assert.doesNotReject(s._tick(new Date('2026-07-01T20:10:00Z')));
    assert.equal(sent.length, 0);
  } finally {
    if (prevKey !== undefined) process.env.BINANCE_API_KEY = prevKey;
    if (prevSecret !== undefined) process.env.BINANCE_API_SECRET = prevSecret;
    if (prevUrl !== undefined) process.env.BINANCE_FUTURES_BASE_URL = prevUrl;
  }
});

test('_tick: 발송 자체가 실패해도 예외를 던지지 않고, 오늘은 시도했다고 표시한다(스팸 방지)', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { exchangeMod, notifyMod } = makeDeps({ sendFails: true });
  const s = new DailySummaryScheduler({
    loadConfig: () => ({ dailySummary: { enabled: true, atHHMM: '16:05' } }),
    exchangeMod,
    notifyMod,
  });
  const now = new Date('2026-07-01T20:10:00Z');
  await assert.doesNotReject(s._tick(now));
  assert.equal(s.lastSentDateKey, nyDateKey(now));
});

// --- 정합성 점검 연동 (일간 요약과 같은 주기로 실행) --------------------------------

test('_tick: 발송 성공 시 정합성 점검도 같은 주기로 함께 실행된다', async () => {
  const { exchangeMod, notifyMod, positionsMod, reconcileMod, reconcileCalls } = makeDeps();
  const s = new DailySummaryScheduler({
    loadConfig: () => ({ dailySummary: { enabled: true, atHHMM: '16:05' } }),
    exchangeMod,
    notifyMod,
    positionsMod,
    reconcileMod,
  });
  await s._tick(new Date('2026-07-01T20:10:00Z'));
  assert.equal(reconcileCalls.length, 1);
  assert.equal(reconcileCalls[0].exchangeMod, exchangeMod);
  assert.equal(reconcileCalls[0].positionsMod, positionsMod);
});

test('_tick: 정합성 점검이 실패해도(예외) 전체 틱은 죽지 않는다', async () => {
  const { exchangeMod, notifyMod, positionsMod, reconcileMod, sent } = makeDeps({ reconcileFails: true });
  const s = new DailySummaryScheduler({
    loadConfig: () => ({ dailySummary: { enabled: true, atHHMM: '16:05' } }),
    exchangeMod,
    notifyMod,
    positionsMod,
    reconcileMod,
  });
  await assert.doesNotReject(s._tick(new Date('2026-07-01T20:10:00Z')));
  assert.equal(sent.length, 1); // 요약 발송 자체는 정상적으로 됐다
});

test('_tick: reconcileMod이 없어도(주입 안 함) 정상 작동한다(하위 호환)', async () => {
  const { exchangeMod, notifyMod, sent } = makeDeps();
  const s = new DailySummaryScheduler({
    loadConfig: () => ({ dailySummary: { enabled: true, atHHMM: '16:05' } }),
    exchangeMod,
    notifyMod,
    // positionsMod, reconcileMod 없음
  });
  await assert.doesNotReject(s._tick(new Date('2026-07-01T20:10:00Z')));
  assert.equal(sent.length, 1);
});

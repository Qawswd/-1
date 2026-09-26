import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Watcher, readWatchCfg } = require('../server/watcher.js');
const { isUsMarketHours } = require('../server/market-hours.js');

// _evaluate는 this를 쓰지 않는 순수 판정 로직이라 인스턴스 없이 바로 호출 가능하다.
const evaluate = Watcher.prototype._evaluate;

function resolved(symbol) {
  return { symbol, kind: 'stock' };
}

function baseW(overrides = {}) {
  return {
    movePct: 1.5,
    windowMin: 15,
    volumeMultiple: 2.5,
    minVolumeNotional: 3000,
    fundingAbs: 0.05,
    premiumPct: 1,
    ...overrides,
  };
}

test('_evaluate: 배율은 기준을 넘지만 거래대금이 최소 기준 미달이면(주말 잡음) volume 알림을 안 낸다', () => {
  // 평소 평균 0.1주, 방금 1분봉 3주 → 30배지만, 가격 $100이면 거래대금 $300으로 미달(기준 $3000)
  const probe = { price: 100, cs: '$', closes: [], vols: Array(31).fill(0.1).concat([3, 1]) };
  const out = evaluate(resolved('WMT'), 'WMT', probe, null, baseW());
  assert.equal(out.some((c) => c.kind === 'volume'), false);
});

test('_evaluate: 배율도 넘고 거래대금도 충분하면 volume 알림을 낸다', () => {
  // 평균 100주, 방금 300주, 가격 $100 → 거래대금 $30,000 (기준 $3000 이상)
  const probe = { price: 100, cs: '$', closes: [], vols: Array(31).fill(100).concat([300, 1]) };
  const out = evaluate(resolved('WMT'), 'WMT', probe, null, baseW());
  const v = out.find((c) => c.kind === 'volume');
  assert.ok(v, 'volume 알림이 있어야 한다');
  assert.match(v.message, /거래대금/);
});

test('_evaluate: minVolumeNotional을 0으로 두면 예전처럼 배율만으로 판단한다', () => {
  const probe = { price: 100, cs: '$', closes: [], vols: Array(31).fill(0.1).concat([3, 1]) };
  const out = evaluate(resolved('WMT'), 'WMT', probe, null, baseW({ minVolumeNotional: 0 }));
  assert.equal(out.some((c) => c.kind === 'volume'), true);
});

test('_evaluate: 거래대금은 충분해도 배율 자체가 기준 미달이면 여전히 안 낸다', () => {
  // 평균 1000주, 방금 1200주(1.2배, 기준 2.5배 미달) — 거래대금은 $120,000으로 충분하지만
  const probe = { price: 100, cs: '$', closes: [], vols: Array(31).fill(1000).concat([1200, 1]) };
  const out = evaluate(resolved('WMT'), 'WMT', probe, null, baseW());
  assert.equal(out.some((c) => c.kind === 'volume'), false);
});

test('_evaluate: 가격 정보가 없으면(price null) 거래대금 계산이 안 되므로 안전하게 걸러진다', () => {
  const probe = { price: null, cs: '$', closes: [], vols: Array(31).fill(0.1).concat([300, 1]) };
  const out = evaluate(resolved('WMT'), 'WMT', probe, null, baseW());
  assert.equal(out.some((c) => c.kind === 'volume'), false);
});

// --- _maybeReviewPosition (포지션 청산 검토 — 익절/손절선 조정) ------------------------

function makeReviewWatcher({
  existingPosition = null,
  verdict = { action: 'KEEP', reasoning: '유지합니다.' },
  openPositions = [],
  closeResult = { ok: true },
  updateResult = { ok: true },
  indicatorLines = ['SMA20 100 위(강세)', 'RSI14 60'],
} = {}) {
  const calls = { close: [], update: [], notify: [], agent: [], market: [], ledgerClose: [] };
  const exchangeMod = {
    createClient: () => ({ getPosition: async () => ({}) }),
    toBinanceFuturesSymbol: (s) => `${s}USDT`,
    summarizeOpenPosition: () => existingPosition,
    closeExistingPosition: async (args) => {
      calls.close.push(args);
      return closeResult;
    },
    updateStopLoss: async (args) => {
      calls.update.push(args);
      return updateResult;
    },
  };
  const positionsMod = {
    listPositions: () => ({ open: openPositions }),
    closePosition: (id, opts) => {
      calls.ledgerClose.push({ id, opts });
      return { id, status: 'closed' };
    },
  };
  const agentsMod = {
    reviewPositionForExit: async (ctx) => {
      calls.agent.push(ctx);
      return verdict;
    },
  };
  const notifyMod = {
    sendExecutionEvent: async (payload) => {
      calls.notify.push(payload);
      return { ok: true };
    },
  };
  const marketMod = {
    fetchMarket: async (resolved) => {
      calls.market.push(resolved);
      return { indicators: { summaryLines: indicatorLines } };
    },
  };
  const w = new Watcher({
    engine: null,
    config: {},
    notify: notifyMod,
    exchangeMod,
    positionsMod,
    agentsMod,
    marketMod,
  });
  return { w, calls };
}

function reviewW(overrides = {}) {
  return {
    movePct: 1.5,
    windowMin: 15,
    volumeMultiple: 2.5,
    cooldownMin: 30,
    positionReviewCooldownHours: 3,
    marketHoursOnly: false,
    ...overrides,
  };
}

const REVIEW_CFG = { execution: { enabled: true } };
const REVIEW_ALERT = { symbol: 'BTC', display: 'BTC', message: '15분 +2.1% 급등', severity: 'warn' };
const CRITICAL_ALERT = { symbol: 'BTC', display: 'BTC', message: '15분 +5.0% 급등', severity: 'critical' };

test('_maybeReviewPosition: execution.enabled가 false면 아무것도 안 한다', async () => {
  const { w, calls } = makeReviewWatcher({ existingPosition: { side: 'LONG', entry: 100, quantity: 1 } });
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  await w._maybeReviewPosition(REVIEW_ALERT, { execution: { enabled: false } }, reviewW());
  assert.equal(calls.agent.length, 0);
});

test('_maybeReviewPosition: 실행 환경변수가 없으면 아무것도 안 한다', async () => {
  const prevKey = process.env.BINANCE_API_KEY;
  delete process.env.BINANCE_API_KEY;
  try {
    const { w, calls } = makeReviewWatcher({ existingPosition: { side: 'LONG', entry: 100, quantity: 1 } });
    await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
    assert.equal(calls.agent.length, 0);
  } finally {
    if (prevKey !== undefined) process.env.BINANCE_API_KEY = prevKey;
  }
});

test('_maybeReviewPosition: 열려있는 실제 포지션이 없으면 AI 호출 자체를 안 한다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({ existingPosition: null });
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
  assert.equal(calls.agent.length, 0);
});

test('_maybeReviewPosition: AI가 KEEP이면 거래소에 아무 주문도 안 내고 알림도 안 보낸다(소음 방지)', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({
    existingPosition: { side: 'LONG', entry: 100, markPrice: 105, unrealizedPct: 5, quantity: 1 },
    verdict: { action: 'KEEP', reasoning: '아직 목표가에 못 미쳤습니다.' },
  });
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
  assert.equal(calls.agent.length, 1);
  assert.equal(calls.close.length, 0);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.notify.length, 0);
});

test('_maybeReviewPosition: AI가 EXIT이면 실제로 청산하고 알림을 보낸다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({
    existingPosition: { side: 'LONG', entry: 100, markPrice: 130, unrealizedPct: 30, quantity: 2 },
    verdict: { action: 'EXIT', reasoning: '목표가를 넘어서 확정합니다.' },
  });
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
  assert.equal(calls.close.length, 1);
  assert.equal(calls.close[0].symbol, 'BTCUSDT');
  assert.equal(calls.close[0].quantity, 2);
  assert.equal(calls.notify.length, 1);
  assert.equal(calls.notify[0].review.type, 'exit');
});

test('_maybeReviewPosition: AI가 TIGHTEN_STOP + 유효한 가격이면 손절선을 조정한다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({
    existingPosition: { side: 'LONG', entry: 100, markPrice: 115, unrealizedPct: 15, quantity: 1 },
    verdict: { action: 'TIGHTEN_STOP', newStopPrice: 108, reasoning: '이익 구간이라 보호합니다.' },
  });
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].newStopPrice, 108);
  assert.equal(calls.notify[0].review.type, 'tighten_stop');
});

test('_maybeReviewPosition: TIGHTEN_STOP인데 newStopPrice가 없으면(0/null) 안전하게 아무 것도 안 한다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({
    existingPosition: { side: 'LONG', entry: 100, quantity: 1 },
    verdict: { action: 'TIGHTEN_STOP', newStopPrice: null, reasoning: 'x' },
  });
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
  assert.equal(calls.update.length, 0);
  assert.equal(calls.notify.length, 0);
});

test('_maybeReviewPosition: 쿨다운 안에서 같은 심볼을 두 번 검토하면 두 번째는 건너뛴다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({
    existingPosition: { side: 'LONG', entry: 100, quantity: 1 },
    verdict: { action: 'KEEP', reasoning: 'x' },
  });
  const w30 = reviewW({ cooldownMin: 30 });
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, w30);
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, w30);
  assert.equal(calls.agent.length, 1); // 두 번째는 쿨다운에 걸려 AI 호출 자체가 없다
});

test('_maybeReviewPosition: 로컬 장부에서 같은 심볼의 원래 목표가·손절가를 찾아 AI 컨텍스트에 넘긴다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({
    existingPosition: { side: 'LONG', entry: 100, quantity: 1 },
    openPositions: [
      { symbol: 'BTC', status: 'open', openedAt: '2026-09-19T00:00:00Z', target: 130, stop: 90 },
      { symbol: 'AAPL', status: 'open', openedAt: '2026-09-19T00:00:00Z', target: 999, stop: 999 }, // 다른 심볼 — 안 섞여야 함
    ],
  });
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
  assert.equal(calls.agent[0].existing.originalTarget, 130);
  assert.equal(calls.agent[0].existing.originalStop, 90);
});

test('_maybeReviewPosition: marketHoursOnly가 true고 지금 장 시간이 아니면 검토 자체를 안 한다', async () => {
  if (isUsMarketHours()) return; // 우연히 지금 장중이면 이 케이스는 검증 불가 — 건너뛴다
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({ existingPosition: { side: 'LONG', entry: 100, quantity: 1 } });
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW({ marketHoursOnly: true }));
  assert.equal(calls.agent.length, 0);
});

// --- status()에 포지션 검토 결과 노출 -------------------------------------------

test('status(): lastPositionReview 필드가 포함된다(기본값 null)', () => {
  const w = new Watcher({ engine: null, config: {}, notify: null });
  const s = w.status();
  assert.ok('lastPositionReview' in s);
  assert.equal(s.lastPositionReview, null);
});

test('status(): 포지션 검토가 일어나면 그 결과가 그대로 노출된다', async () => {
  const { w } = makeReviewWatcher({
    existingPosition: { side: 'LONG', entry: 100, quantity: 1 },
    verdict: { action: 'EXIT', reasoning: 'x' },
  });
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
  const s = w.status();
  assert.equal(s.lastPositionReview.symbol, 'BTCUSDT');
  assert.equal(s.lastPositionReview.action, 'EXIT');
});

// --- 익절 검토 심화: 기술지표·원래 근거·전용 쿨다운 -------------------------------

test('_maybeReviewPosition: 현재 기술 지표를 조회해서 AI 컨텍스트에 넘긴다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({
    existingPosition: { side: 'LONG', entry: 100, quantity: 1 },
    indicatorLines: ['SMA20 78,344 — 가격은 SMA20 위(강세)', 'RSI14 64.4'],
  });
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
  assert.equal(calls.market.length, 1);
  assert.deepEqual(calls.agent[0].indicatorLines, ['SMA20 78,344 — 가격은 SMA20 위(강세)', 'RSI14 64.4']);
});

test('_maybeReviewPosition: 로컬 장부에서 원래 판정 근거(rationale)를 찾아 AI 컨텍스트에 넘긴다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({
    existingPosition: { side: 'LONG', entry: 100, quantity: 1 },
    openPositions: [
      { symbol: 'BTC', status: 'open', openedAt: '2026-09-19T00:00:00Z', target: 130, stop: 90, rationale: '82,300 돌파 시 상승 재개' },
    ],
  });
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
  assert.equal(calls.agent[0].existing.originalRationale, '82,300 돌파 시 상승 재개');
});

test('_maybeReviewPosition: 지표 조회가 실패해도(market 모듈 오류) 검토 자체는 계속된다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({ existingPosition: { side: 'LONG', entry: 100, quantity: 1 } });
  w._market = { fetchMarket: async () => { throw new Error('네트워크 오류'); } };
  await assert.doesNotReject(w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW()));
  assert.equal(calls.agent.length, 1); // 지표 없이도 검토는 진행됨
  assert.equal(calls.agent[0].indicatorLines, null);
});

test('_maybeReviewPosition: 쿨다운은 cooldownMin이 아니라 positionReviewCooldownHours를 쓴다(분리 확인)', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({ existingPosition: { side: 'LONG', entry: 100, quantity: 1 } });
  // cooldownMin은 30(길게)인데 positionReviewCooldownHours가 0이면, 바로 다시 검토돼야 한다
  // — 만약 코드가 실수로 cooldownMin을 쓰고 있었다면 두 번째 호출이 막혔을 것이다.
  const w0 = reviewW({ cooldownMin: 30, positionReviewCooldownHours: 0 });
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, w0);
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, w0);
  assert.equal(calls.agent.length, 2);
});

// --- critical급 움직임은 쿨다운 무시 — "애매한 움직임에 검토 → 직후 큰 움직임을 놓침" 방지 --

test('_maybeReviewPosition: 정확히 사용자가 지적한 시나리오 — 애매한 움직임으로 쿨다운이 갱신된 직후, critical급 움직임은 그래도 즉시 검토된다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({ existingPosition: { side: 'LONG', entry: 100, quantity: 1 } });
  const w3h = reviewW({ positionReviewCooldownHours: 3 });

  // 1) 진입 직후 애매한 움직임(warn)으로 첫 검토 — 쿨다운 타이머가 지금 시점으로 갱신된다.
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, w3h);
  assert.equal(calls.agent.length, 1);

  // 2) 1시간15분 뒤(3시간 쿨다운 안), 진짜 큰 움직임(critical, 5% 급등)이 온다.
  //    쿨다운만 봤다면 막혔어야 하지만, critical이라 쿨다운을 무시하고 검토돼야 한다.
  await w._maybeReviewPosition(CRITICAL_ALERT, REVIEW_CFG, w3h);
  assert.equal(calls.agent.length, 2);
});

test('_maybeReviewPosition: critical이 아닌(warn/info) 움직임은 쿨다운 안에서 여전히 막힌다(과도하게 뚫리지 않음)', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({ existingPosition: { side: 'LONG', entry: 100, quantity: 1 } });
  const w3h = reviewW({ positionReviewCooldownHours: 3 });

  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, w3h); // warn, 첫 검토
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, w3h); // warn, 쿨다운 안 — 막혀야 함
  assert.equal(calls.agent.length, 1);
});

test('_maybeReviewPosition: critical 움직임도 자기 자신은 쿨다운 타이머를 갱신한다(연속 critical 남발은 막힘)', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({ existingPosition: { side: 'LONG', entry: 100, quantity: 1 } });
  const w3h = reviewW({ positionReviewCooldownHours: 3 });

  await w._maybeReviewPosition(CRITICAL_ALERT, REVIEW_CFG, w3h); // critical, 통과
  await w._maybeReviewPosition(CRITICAL_ALERT, REVIEW_CFG, w3h); // 바로 다음 틱에 또 critical
  assert.equal(calls.agent.length, 2); // critical은 매번 쿨다운을 무시하므로 둘 다 통과
});

// --- 같은 심볼 분석 vs 검토 교통정리 -------------------------------------------

test('_maybeReviewPosition: 같은 심볼로 전체 분석이 진행 중이면 검토를 양보한다(AI 호출 자체를 안 함)', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({ existingPosition: { side: 'LONG', entry: 100, quantity: 1 } });
  w.engine = { running: true, runningSymbol: 'BTC' }; // REVIEW_ALERT도 symbol:'BTC'
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
  assert.equal(calls.agent.length, 0);
  assert.match(w.lastPositionReview.action, /건너뜀/);
});

test('_maybeReviewPosition: 전체 분석이 "다른" 심볼로 진행 중이면 검토는 그대로 진행된다(교통정리가 과도하게 막지 않음)', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({ existingPosition: { side: 'LONG', entry: 100, quantity: 1 } });
  w.engine = { running: true, runningSymbol: 'AAPL' }; // REVIEW_ALERT은 symbol:'BTC' — 다른 심볼
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
  assert.equal(calls.agent.length, 1);
});

test('_maybeReviewPosition: engine.running이 false면(분석 안 도는 중) 검토는 정상 진행된다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({ existingPosition: { side: 'LONG', entry: 100, quantity: 1 } });
  w.engine = { running: false, runningSymbol: null };
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
  assert.equal(calls.agent.length, 1);
});

test('_maybeReviewPosition: engine 자체가 없어도(null) 검토는 정상 진행된다(에러 안 던짐)', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({ existingPosition: { side: 'LONG', entry: 100, quantity: 1 } });
  w.engine = null;
  await assert.doesNotReject(w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW()));
  assert.equal(calls.agent.length, 1);
});

// --- _maybeTrailStops (트레일링 스탑 — AI 없이 매 틱마다) --------------------------

function makeTrailWatcher({
  openPositions = [{ symbol: 'BTCUSDT', side: 'LONG', quantity: 1, markPrice: 100 }],
  ledgerOpen = [{ symbol: 'BTC', openedAt: '2026-09-01T00:00:00Z', stop: 90 }],
  candles = [
    { t: Date.parse('2026-09-01T00:00:00Z'), h: 101, l: 99, c: 100 },
    { t: Date.parse('2026-09-02T00:00:00Z'), h: 103, l: 101, c: 102 },
    { t: Date.parse('2026-09-03T00:00:00Z'), h: 105, l: 103, c: 104 },
    { t: Date.parse('2026-09-04T00:00:00Z'), h: 107, l: 105, c: 106 },
    { t: Date.parse('2026-09-05T00:00:00Z'), h: 109, l: 107, c: 108 },
  ],
  updateResult = { ok: true },
} = {}) {
  const calls = { getPosition: 0, market: [], update: [], ledgerUpdate: [], notify: [] };
  const exchangeMod = {
    createClient: () => ({
      getPosition: async () => {
        calls.getPosition += 1;
        return {};
      },
    }),
    toBinanceFuturesSymbol: (s) => `${s}USDT`,
    summarizeAllOpenPositions: () => openPositions,
    updateStopLoss: async (args) => {
      calls.update.push(args);
      return updateResult;
    },
    computeTrailingStop: require('../server/exchange.js').computeTrailingStop,
  };
  const positionsMod = {
    listPositions: () => ({ open: ledgerOpen }),
    updateStopInLedger: (symbol, newStop) => {
      calls.ledgerUpdate.push({ symbol, newStop });
      return { symbol, stop: newStop };
    },
  };
  const marketMod = {
    fetchMarket: async (resolved) => {
      calls.market.push(resolved);
      return { candles };
    },
  };
  const indicatorsMod = require('../server/indicators.js');
  const notifyMod = {
    sendExecutionEvent: async (payload) => {
      calls.notify.push(payload);
      return { ok: true };
    },
  };
  const w = new Watcher({
    engine: null,
    config: {},
    notify: notifyMod,
    exchangeMod,
    positionsMod,
    marketMod,
    indicatorsMod,
  });
  return { w, calls };
}

const TRAIL_CFG_BASE = { execution: { enabled: true }, watchlist: ['BTC'] };
const TRAIL_W = { marketHoursOnly: false, trailAtrMultiple: 2.5 };

test('_maybeTrailStops: execution.enabled가 false면 아무것도 안 한다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeTrailWatcher();
  await w._maybeTrailStops({ execution: { enabled: false }, watchlist: ['BTC'] }, TRAIL_W);
  assert.equal(calls.getPosition, 0);
});

test('_maybeTrailStops: 열린 포지션이 없으면 이후 단계를 진행하지 않는다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeTrailWatcher({ openPositions: [] });
  await w._maybeTrailStops(TRAIL_CFG_BASE, TRAIL_W);
  assert.equal(calls.market.length, 0);
});

test('_maybeTrailStops: 워치리스트 밖 종목의 포지션은 건너뛴다(지표를 조회할 방법이 없어서)', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeTrailWatcher({ openPositions: [{ symbol: 'RANDOMUSDT', side: 'LONG', quantity: 1, markPrice: 100 }] });
  await w._maybeTrailStops(TRAIL_CFG_BASE, TRAIL_W); // watchlist엔 BTC만 있음
  assert.equal(calls.market.length, 0);
  assert.equal(calls.update.length, 0);
});

test('_maybeTrailStops: 로컬 장부에 기준 손절가가 없으면(매칭 안 됨) 건너뛴다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeTrailWatcher({ ledgerOpen: [] }); // 장부 비어있음
  await w._maybeTrailStops(TRAIL_CFG_BASE, TRAIL_W);
  assert.equal(calls.market.length, 0);
});

test('_maybeTrailStops: 정상 흐름 — 고점 대비 ATR만큼 유리하면 실제로 손절선을 올리고, 장부도 갱신하고, 알림도 보낸다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  // 캔들: ATR=3, 고점=109 (손계산 검증 완료) → 새 손절 = 109 - 2.5*3 = 101.5,
  // 기존 손절 90보다 유리하므로 실제로 갱신돼야 한다.
  const { w, calls } = makeTrailWatcher();
  await w._maybeTrailStops(TRAIL_CFG_BASE, TRAIL_W);
  assert.equal(calls.market.length, 1);
  assert.equal(calls.update.length, 1);
  assert.equal(calls.update[0].symbol, 'BTCUSDT');
  assert.equal(calls.update[0].newStopPrice, 101.5);
  assert.equal(calls.ledgerUpdate.length, 1);
  assert.equal(calls.ledgerUpdate[0].symbol, 'BTC');
  assert.equal(calls.ledgerUpdate[0].newStop, 101.5);
  assert.equal(calls.notify.length, 1);
  assert.equal(calls.notify[0].review.type, 'tighten_stop');
  assert.match(calls.notify[0].review.reasoning, /AI 없이 자동 계산/);
});

test('_maybeTrailStops: 계산된 새 손절이 기존보다 안 유리하면 아무 것도 안 한다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  // 기존 손절을 아주 유리하게(129) 설정해서 트레일링 계산값이 절대 못 넘게 만든다.
  const { w, calls } = makeTrailWatcher({ ledgerOpen: [{ symbol: 'BTC', openedAt: '2026-09-01T00:00:00Z', stop: 129 }] });
  await w._maybeTrailStops(TRAIL_CFG_BASE, TRAIL_W);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.notify.length, 0);
});

test('_maybeTrailStops: marketHoursOnly가 true고 지금 장 시간이 아니면 아무것도 안 한다', async () => {
  if (isUsMarketHours()) return;
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeTrailWatcher();
  await w._maybeTrailStops(TRAIL_CFG_BASE, { ...TRAIL_W, marketHoursOnly: true });
  assert.equal(calls.getPosition, 0);
});

// --- EXIT 시 로컬 장부도 함께 청산 (성적표 데이터 정합성) --------------------------

test('_maybeReviewPosition: EXIT 성공하면 로컬 장부도 함께 청산 처리한다(성적표가 영원히 "열려있음"으로 안 남게)', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({
    existingPosition: { side: 'LONG', entry: 100, markPrice: 130, quantity: 1 },
    verdict: { action: 'EXIT', reasoning: '목표가 도달.' },
    openPositions: [{ id: 'pos-123', symbol: 'BTC', status: 'open', openedAt: '2026-09-19T00:00:00Z' }],
  });
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
  assert.equal(calls.ledgerClose.length, 1);
  assert.equal(calls.ledgerClose[0].id, 'pos-123');
});

test('_maybeReviewPosition: EXIT인데 실제 거래소 청산이 실패하면 로컬 장부는 안 건드린다(실제 상태와 어긋나지 않게)', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({
    existingPosition: { side: 'LONG', entry: 100, quantity: 1 },
    verdict: { action: 'EXIT', reasoning: 'x' },
    openPositions: [{ id: 'pos-123', symbol: 'BTC', status: 'open', openedAt: '2026-09-19T00:00:00Z' }],
    closeResult: { ok: false, error: '청산 거부' },
  });
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
  assert.equal(calls.ledgerClose.length, 0);
});

test('_maybeReviewPosition: EXIT인데 로컬 장부에 매칭되는 기록이 없어도 에러 없이 넘어간다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({
    existingPosition: { side: 'LONG', entry: 100, quantity: 1 },
    verdict: { action: 'EXIT', reasoning: 'x' },
    openPositions: [], // 매칭 없음
  });
  await assert.doesNotReject(w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW()));
  assert.equal(calls.ledgerClose.length, 0);
  assert.equal(calls.notify.length, 1); // 알림은 그대로 나간다
});

// --- 트레일링 스탑 vs AI 검토 교통정리 ------------------------------------------

test('_maybeTrailStops: 같은 심볼에 AI 검토가 진행 중(_reviewInFlight)이면 이번 틱은 건너뛴다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeTrailWatcher();
  w._reviewInFlight.add('BTCUSDT'); // 검토가 지금 이 심볼을 붙잡고 있다고 가정
  await w._maybeTrailStops(TRAIL_CFG_BASE, TRAIL_W);
  assert.equal(calls.update.length, 0);
  assert.equal(calls.market.length, 0);
});

test('_maybeTrailStops: _reviewInFlight가 비어있으면 정상적으로 진행된다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeTrailWatcher();
  await w._maybeTrailStops(TRAIL_CFG_BASE, TRAIL_W);
  assert.equal(calls.update.length, 1);
});

// --- 한도 소진 게이트 (engine.quotaExhaustedUntil) -------------------------------

test('_maybeAutoAnalyze: 한도 소진 중(리셋 시각 안 지남)이면 새 자동분석을 시작하지 않는다', () => {
  const runCalls = [];
  const fakeEngine = {
    running: false,
    quotaExhaustedUntil: Date.now() + 60 * 60 * 1000, // 1시간 뒤 리셋
    run: async (...args) => {
      runCalls.push(args);
    },
  };
  const w = new Watcher({ engine: fakeEngine, config: {}, notify: null });
  w._maybeAutoAnalyze({ symbol: 'BTC' }, {}, { autoAnalyze: true, marketHoursOnly: false, autoGapMin: 0 });
  assert.equal(runCalls.length, 0);
  assert.match(w.lastAutoAnalyze.result, /건너뜀\(한도 소진/);
});

test('_maybeAutoAnalyze: 한도 소진 리셋 시각이 이미 지났으면 정상적으로 시도한다', () => {
  const fakeEngine = {
    running: false,
    quotaExhaustedUntil: Date.now() - 1000, // 이미 지남
    run: async () => {},
  };
  const w = new Watcher({ engine: fakeEngine, config: {}, notify: null });
  // _runAndNotify는 내부에서 여러 걸 더 건드리므로 여기서는 "건너뜀(한도 소진)"으로
  // 막히지 않는지만 확인한다(lastAutoAnalyze.result가 '실행'으로 찍히는지).
  w._maybeAutoAnalyze({ symbol: 'BTC' }, {}, { autoAnalyze: true, marketHoursOnly: false, autoGapMin: 0 });
  assert.equal(w.lastAutoAnalyze.result, '실행');
});

test('_maybeAutoAnalyze: quotaExhaustedUntil이 아예 없으면(null) 정상적으로 시도한다', () => {
  const fakeEngine = { running: false, quotaExhaustedUntil: null, run: async () => {} };
  const w = new Watcher({ engine: fakeEngine, config: {}, notify: null });
  w._maybeAutoAnalyze({ symbol: 'BTC' }, {}, { autoAnalyze: true, marketHoursOnly: false, autoGapMin: 0 });
  assert.equal(w.lastAutoAnalyze.result, '실행');
});

test('_maybeReviewPosition: 한도 소진 중이면 포지션 검토도 건너뛰고, AI 호출 자체를 안 한다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({ existingPosition: { side: 'LONG', entry: 100, quantity: 1 } });
  w.engine = { running: false, quotaExhaustedUntil: Date.now() + 60 * 60 * 1000 };
  await w._maybeReviewPosition(REVIEW_ALERT, REVIEW_CFG, reviewW());
  assert.equal(calls.agent.length, 0);
  assert.match(w.lastPositionReview.action, /건너뜀\(한도 소진\)/);
});

// --- 차트 구조 필터 (structureFilterEnabled, kind:'move' 전용) --------------------

function makeStructureTestWatcher({ structureAgrees = true, fetchMarketFails = false, quotaExhaustedUntil = null } = {}) {
  const runCalls = [];
  const triggerLogCalls = [];
  const fakeEngine = { running: false, quotaExhaustedUntil, run: async (...args) => runCalls.push(args) };
  const marketMod = {
    fetchMarket: async () => {
      if (fetchMarketFails) throw new Error('네트워크 실패');
      return { indicators: { price: 100, sma20: 95, macd: { hist: 1 } } }; // 내용 자체는 가짜 판정 함수가 무시함
    },
  };
  const indicatorsMod = { structureAgreesWithDirection: () => structureAgrees };
  const triggerLogMod = { recordTrigger: (entry) => triggerLogCalls.push(entry) };
  const w = new Watcher({ engine: fakeEngine, config: {}, notify: null, marketMod, indicatorsMod, triggerLogMod });
  return { w, runCalls, triggerLogCalls };
}

test('_maybeAutoAnalyze: move 트리거인데 차트 구조가 방향과 안 맞으면(false) 자동분석을 건너뛴다', async () => {
  const { w, runCalls } = makeStructureTestWatcher({ structureAgrees: false });
  await w._maybeAutoAnalyze(
    { symbol: 'BTC', kind: 'move', value: 2.1 },
    {},
    { autoAnalyze: true, marketHoursOnly: false, autoGapMin: 0, structureFilterEnabled: true }
  );
  assert.equal(runCalls.length, 0);
  assert.match(w.lastAutoAnalyze.result, /건너뜀\(차트 구조 불일치/);
});

test('_maybeAutoAnalyze: move 트리거이고 차트 구조가 방향과 맞으면(true) 정상적으로 진행된다', async () => {
  const { w } = makeStructureTestWatcher({ structureAgrees: true });
  await w._maybeAutoAnalyze(
    { symbol: 'BTC', kind: 'move', value: 2.1 },
    {},
    { autoAnalyze: true, marketHoursOnly: false, autoGapMin: 0, structureFilterEnabled: true }
  );
  assert.equal(w.lastAutoAnalyze.result, '실행');
});

test('_maybeAutoAnalyze: structureFilterEnabled:false면 필터 자체를 건너뛰고 예전처럼 동작한다', async () => {
  const { w } = makeStructureTestWatcher({ structureAgrees: false }); // 구조는 불일치지만
  await w._maybeAutoAnalyze(
    { symbol: 'BTC', kind: 'move', value: 2.1 },
    {},
    { autoAnalyze: true, marketHoursOnly: false, autoGapMin: 0, structureFilterEnabled: false } // 필터 꺼둠
  );
  assert.equal(w.lastAutoAnalyze.result, '실행'); // 꺼져있으니 구조 불일치와 무관하게 진행
});

test('_maybeAutoAnalyze: 거래량(volume) 단독 신호는 분석을 시작하지 않는다(알림만 전송)', async () => {
  const { w, runCalls, triggerLogCalls } = makeStructureTestWatcher({ structureAgrees: true });
  await w._maybeAutoAnalyze(
    { symbol: 'BTC', kind: 'volume', value: 3.0 },
    {},
    { autoAnalyze: true, marketHoursOnly: false, autoGapMin: 0, structureFilterEnabled: true }
  );
  assert.equal(runCalls.length, 0);
  assert.equal(triggerLogCalls.length, 0); // 분석 후보가 아니므로 트리거 기록에도 안 남는다
  assert.match(w.lastAutoAnalyze.result, /volume 단독 신호는 분석을 시작하지 않음/);
});

test('_maybeAutoAnalyze: 지표 조회 자체가 실패하면(네트워크 등) 보수적으로 건너뛴다', async () => {
  const { w, runCalls } = makeStructureTestWatcher({ fetchMarketFails: true });
  await w._maybeAutoAnalyze(
    { symbol: 'BTC', kind: 'move', value: 2.1 },
    {},
    { autoAnalyze: true, marketHoursOnly: false, autoGapMin: 0, structureFilterEnabled: true }
  );
  assert.equal(runCalls.length, 0);
  assert.match(w.lastAutoAnalyze.result, /건너뜀\(차트 구조 불일치/);
});

test('_maybeAutoAnalyze: 하락 방향(value 음수)도 동일한 구조 필터를 거친다(대칭 확인)', async () => {
  const { w, runCalls } = makeStructureTestWatcher({ structureAgrees: false });
  await w._maybeAutoAnalyze(
    { symbol: 'BTC', kind: 'move', value: -2.1 }, // 하락 방향
    {},
    { autoAnalyze: true, marketHoursOnly: false, autoGapMin: 0, structureFilterEnabled: true }
  );
  assert.equal(runCalls.length, 0);
  assert.match(w.lastAutoAnalyze.result, /건너뜀\(차트 구조 불일치/);
});

// --- 트리거 기록 (한도와 완전히 무관하게 기록되는지) --------------------------------

test('_maybeAutoAnalyze: 구조 필터를 통과하면 한도 상태와 무관하게 트리거가 기록된다', async () => {
  const { w, triggerLogCalls } = makeStructureTestWatcher({ structureAgrees: true, quotaExhaustedUntil: null });
  await w._maybeAutoAnalyze(
    { symbol: 'BTC', kind: 'move', value: 2.1 },
    {},
    { autoAnalyze: true, marketHoursOnly: false, autoGapMin: 0, structureFilterEnabled: true }
  );
  assert.equal(triggerLogCalls.length, 1);
  assert.equal(triggerLogCalls[0].symbol, 'BTC');
  assert.equal(triggerLogCalls[0].kind, 'move');
});

test('_maybeAutoAnalyze: 한도가 소진돼 있어도 구조 필터만 통과하면 트리거는 기록된다(핵심 — 한도와 무관한 진짜 빈도 측정)', async () => {
  const { w, runCalls, triggerLogCalls } = makeStructureTestWatcher({
    structureAgrees: true,
    quotaExhaustedUntil: Date.now() + 60 * 60 * 1000, // 한도 소진 중
  });
  await w._maybeAutoAnalyze(
    { symbol: 'BTC', kind: 'move', value: 2.1 },
    {},
    { autoAnalyze: true, marketHoursOnly: false, autoGapMin: 0, structureFilterEnabled: true }
  );
  assert.equal(triggerLogCalls.length, 1); // 기록은 됨
  assert.equal(runCalls.length, 0); // 근데 한도 때문에 실제 실행은 안 됨
});

test('_maybeAutoAnalyze: 구조 필터에서 걸러지면(불일치) 애초에 트리거로 기록하지 않는다(진짜 실행 후보가 아니므로)', async () => {
  const { w, triggerLogCalls } = makeStructureTestWatcher({ structureAgrees: false });
  await w._maybeAutoAnalyze(
    { symbol: 'BTC', kind: 'move', value: 2.1 },
    {},
    { autoAnalyze: true, marketHoursOnly: false, autoGapMin: 0, structureFilterEnabled: true }
  );
  assert.equal(triggerLogCalls.length, 0);
});


// --- 하루 분석 상한(analysisBudget) -----------------------------------------------

function fakeBudget(okSequence) {
  const calls = [];
  let i = 0;
  return {
    calls,
    mod: {
      consume: (category, limits) => {
        calls.push({ category, limits });
        const ok = okSequence[Math.min(i, okSequence.length - 1)];
        i += 1;
        return ok ? { ok: true } : { ok: false, reason: '오늘 move 분석 한도 2번 소진' };
      },
    },
  };
}

const W_WITH_BUDGET = {
  autoAnalyze: true,
  marketHoursOnly: false,
  autoGapMin: 0,
  structureFilterEnabled: true,
  analysisTriggerKinds: ['move'],
  analysisBudget: { total: 6, move: 2, level: 2, planning: 2 },
};

test('_maybeAutoAnalyze: 하루 급변 칸이 남아있으면 1회 차감하고 실행한다', async () => {
  const { w } = makeStructureTestWatcher({ structureAgrees: true });
  const b = fakeBudget([true]);
  w._budget = b.mod;
  await w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: 2.1 }, {}, W_WITH_BUDGET);
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].category, 'move');
  assert.equal(w.lastAutoAnalyze.result, '실행');
});

test('_maybeAutoAnalyze: 하루 급변 칸이 소진되면 실행하지 않는다', async () => {
  const { w, runCalls } = makeStructureTestWatcher({ structureAgrees: true });
  w._budget = fakeBudget([false]).mod;
  await w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: 2.1 }, {}, W_WITH_BUDGET);
  assert.equal(runCalls.length, 0);
  assert.match(w.lastAutoAnalyze.result, /건너뜀\(오늘 move 분석 한도/);
});

test('_maybeAutoAnalyze: 한도 소진·구조 불일치 등 앞 게이트에서 걸러지면 하루 칸을 차감하지 않는다', async () => {
  const { w } = makeStructureTestWatcher({ structureAgrees: false });
  const b = fakeBudget([true]);
  w._budget = b.mod;
  await w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: 2.1 }, {}, W_WITH_BUDGET);
  assert.equal(b.calls.length, 0);

  const q = makeStructureTestWatcher({ structureAgrees: true, quotaExhaustedUntil: Date.now() + 3600000 });
  const b2 = fakeBudget([true]);
  q.w._budget = b2.mod;
  await q.w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: 2.1 }, {}, W_WITH_BUDGET);
  assert.equal(b2.calls.length, 0);
});

test('_maybeAutoAnalyze: 한도로 막혀도 트리거 기록은 남는다(실제 수요 측정용)', async () => {
  const { w, triggerLogCalls } = makeStructureTestWatcher({ structureAgrees: true });
  w._budget = fakeBudget([false]).mod;
  await w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: 2.1 }, {}, W_WITH_BUDGET);
  assert.equal(triggerLogCalls.length, 1);
});

// --- 익절 AI 검토는 가격 움직임 알림에만 반응 ------------------------------------

test('_maybeReviewPosition: 거래량 알림으로는 익절 AI 검토를 부르지 않는다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({ existingPosition: { side: 'LONG', entry: 100, quantity: 1 } });
  await w._maybeReviewPosition({ ...REVIEW_ALERT, kind: 'volume' }, REVIEW_CFG, reviewW());
  assert.equal(calls.agent.length, 0);
});

test('_maybeReviewPosition: 가격 움직임(move) 알림에는 그대로 반응한다', async () => {
  process.env.BINANCE_API_KEY = 'x';
  process.env.BINANCE_API_SECRET = 'x';
  process.env.BINANCE_FUTURES_BASE_URL = 'https://demo-fapi.binance.com';
  const { w, calls } = makeReviewWatcher({ existingPosition: { side: 'LONG', entry: 100, quantity: 1 } });
  await w._maybeReviewPosition({ ...REVIEW_ALERT, kind: 'move' }, REVIEW_CFG, reviewW());
  assert.equal(calls.agent.length, 1);
});


// --- 하루 분석 상한은 기본 꺼짐(구독 방식) — API 전환 시에만 켠다 ------------------------

test('readWatchCfg: 설정이 없으면 하루 분석 상한은 꺼져 있다(구독 방식 기본값)', () => {
  const w = readWatchCfg({ watcher: {} });
  assert.equal(w.analysisBudget.enabled, false);
});

test('readWatchCfg: enabled:true를 명시해야만 상한이 켜진다(API 전환용)', () => {
  assert.equal(readWatchCfg({ watcher: { analysisBudget: { enabled: true } } }).analysisBudget.enabled, true);
  assert.equal(readWatchCfg({ watcher: { analysisBudget: { enabled: 'yes' } } }).analysisBudget.enabled, false);
  assert.equal(readWatchCfg({ watcher: { analysisBudget: { total: 10 } } }).analysisBudget.enabled, false);
});

test('_maybeAutoAnalyze: 상한이 꺼져 있으면 하루 칸을 차감하지 않고 실행한다', async () => {
  const { w } = makeStructureTestWatcher({ structureAgrees: true });
  const b = fakeBudget([false]); // 켜져 있었다면 막혔을 상태
  w._budget = b.mod;
  await w._maybeAutoAnalyze(
    { symbol: 'BTC', kind: 'move', value: 2.1 },
    {},
    { ...W_WITH_BUDGET, analysisBudget: { ...W_WITH_BUDGET.analysisBudget, enabled: false } }
  );
  assert.equal(b.calls.length, 0);
  assert.equal(w.lastAutoAnalyze.result, '실행');
});

// --- 후보 기록: 모든 관문의 통과·탈락이 기록된다 ------------------------------------

function fakeCandidateLog() {
  const rows = [];
  let n = 0;
  return {
    rows,
    mod: {
      newCandidateId: () => `c-test-${++n}`,
      indicatorSnapshot: (ind) => (ind ? { price: ind.price ?? null } : null),
      recordCandidate: (r) => rows.push(r),
    },
  };
}

test('후보 기록: 구조 필터 탈락은 stage=structure로, 시장 데이터와 함께 기록된다', async () => {
  const { w } = makeStructureTestWatcher({ structureAgrees: false });
  const c = fakeCandidateLog();
  w._candidateLog = c.mod;
  await w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: 2.1 }, {}, W_WITH_BUDGET);
  assert.equal(c.rows.length, 1);
  assert.equal(c.rows[0].stage, 'structure');
  assert.equal(c.rows[0].passed, false);
  assert.equal(c.rows[0].candidateId, 'c-test-1');
  assert.equal(c.rows[0].features.price, 100);
});

test('후보 기록: 분석까지 가면 stage=analyzed로 기록되고 같은 ID가 엔진으로 넘어간다', async () => {
  const { w } = makeStructureTestWatcher({ structureAgrees: true });
  const c = fakeCandidateLog();
  w._candidateLog = c.mod;
  w._budget = fakeBudget([true]).mod;
  const alert = { symbol: 'BTC', kind: 'move', value: 2.1 };
  await w._maybeAutoAnalyze(alert, {}, W_WITH_BUDGET);
  assert.equal(c.rows.at(-1).stage, 'analyzed');
  assert.equal(c.rows.at(-1).passed, true);
  assert.equal(alert.candidateId, 'c-test-1');
});

test('후보 기록: 거래량 단독 신호 탈락도 stage=kind로 기록된다(분석 안 해도 수요는 남긴다)', async () => {
  const { w } = makeStructureTestWatcher({ structureAgrees: true });
  const c = fakeCandidateLog();
  w._candidateLog = c.mod;
  await w._maybeAutoAnalyze({ symbol: 'ETH', kind: 'volume', value: 3 }, {}, W_WITH_BUDGET);
  assert.equal(c.rows[0].stage, 'kind');
  assert.equal(c.rows[0].symbol, 'ETH');
});

test('후보 기록: 기록 모듈이 예외를 던져도 감시 흐름은 멈추지 않는다', async () => {
  const { w } = makeStructureTestWatcher({ structureAgrees: true });
  w._candidateLog = {
    newCandidateId: () => 'x',
    indicatorSnapshot: () => null,
    recordCandidate: () => {
      throw new Error('디스크 가득 참');
    },
  };
  w._budget = fakeBudget([true]).mod;
  await assert.doesNotReject(w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: 2.1 }, {}, W_WITH_BUDGET));
  assert.equal(w.lastAutoAnalyze.result, '실행');
});

// --- 24시간 체제 전환: marketHoursOnly 기본값이 false로 뒤집혔다(2026-09-25) -----------

test('readWatchCfg: marketHoursOnly를 안 정하면 기본은 false(24시간 체제) — 예전엔 true였다', () => {
  const w = readWatchCfg({ watcher: {} });
  assert.equal(w.marketHoursOnly, false);
});

test('readWatchCfg: marketHoursOnly:true를 명시하면 예전(미장 시간대만) 방식으로 되돌릴 수 있다', () => {
  assert.equal(readWatchCfg({ watcher: { marketHoursOnly: true } }).marketHoursOnly, true);
  assert.equal(readWatchCfg({ watcher: { marketHoursOnly: 'yes' } }).marketHoursOnly, false); // 정확히 true만 인정
});

test('_maybeAutoAnalyze: 설정을 안 건드리면(기본값) 미장 시간대 밖에서도 자동분석을 시작한다', async () => {
  const { w } = makeStructureTestWatcher({ structureAgrees: true });
  w._budget = fakeBudget([true]).mod;
  const cfg = readWatchCfg({ watcher: { autoAnalyze: true } }); // marketHoursOnly 명시 안 함
  await w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: 2.1 }, {}, cfg);
  assert.equal(w.lastAutoAnalyze.result, '실행');
});

// --- 추세 추종 + 역추세 병행 필터 (워뇨띠 초기 매매 재분석 반영, 2026-09-25) ----------

function makeDualFilterWatcher({ trend, reversal, indicators }) {
  const runCalls = [];
  const fakeEngine = { running: false, quotaExhaustedUntil: null, run: async (...a) => runCalls.push(a) };
  const marketMod = { fetchMarket: async () => ({ indicators: indicators || { price: 105, low20: 100, high20: 200 } }) };
  const reversalArgs = [];
  const indicatorsMod = {
    structureAgreesWithDirection: () => trend,
    reversalAgreesWithDirection: (dir, ind, opts) => {
      reversalArgs.push({ dir, opts });
      return reversal;
    },
    rangePosition: () => 5,
  };
  const c = fakeCandidateLog();
  const w = new Watcher({ engine: fakeEngine, config: {}, notify: null, marketMod, indicatorsMod, triggerLogMod: { recordTrigger() {} }, candidateLogMod: c.mod });
  return { w, runCalls, rows: c.rows, reversalArgs };
}

const W_DUAL = { ...W_WITH_BUDGET, reversalFilterEnabled: true, reversalBandPct: 20, analysisBudget: { enabled: false } };

test('병행 필터: 추세는 불일치여도 역추세 자리면 분석 후보로 통과한다', async () => {
  const { w, rows } = makeDualFilterWatcher({ trend: false, reversal: true });
  await w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: -2.1 }, {}, W_DUAL);
  assert.equal(w.lastAutoAnalyze.result, '실행');
  assert.deepEqual(rows.at(-1).features.signals, ['reversal']);
});

test('병행 필터: 추세만 맞아도 통과하고, 어느 신호였는지 기록된다', async () => {
  const { w, rows } = makeDualFilterWatcher({ trend: true, reversal: false });
  await w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: 2.1 }, {}, W_DUAL);
  assert.equal(w.lastAutoAnalyze.result, '실행');
  assert.deepEqual(rows.at(-1).features.signals, ['trend']);
});

test('병행 필터: 둘 다 맞으면 두 신호 모두 기록된다(나중에 겹친 경우도 따로 비교 가능)', async () => {
  const x = makeDualFilterWatcher({ trend: true, reversal: true });
  await x.w._maybeAutoAnalyze({ symbol: 'ETH', kind: 'move', value: -2.1 }, {}, W_DUAL);
  assert.deepEqual(x.rows.at(-1).features.signals, ['trend', 'reversal']);
});

test('병행 필터: 둘 다 불일치면 탈락하고 구간 위치가 기록된다', async () => {
  const { w, rows, runCalls } = makeDualFilterWatcher({ trend: false, reversal: false });
  await w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: -2.1 }, {}, W_DUAL);
  assert.equal(runCalls.length, 0);
  assert.equal(rows.at(-1).stage, 'structure');
  assert.equal(rows.at(-1).features.rangePosition, 5);
  assert.deepEqual(rows.at(-1).features.signals, []);
});

test('병행 필터: reversalFilterEnabled:false면 역추세는 보지 않는다(추세 추종만)', async () => {
  const { w, reversalArgs } = makeDualFilterWatcher({ trend: false, reversal: true });
  await w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: -2.1 }, {}, { ...W_DUAL, reversalFilterEnabled: false });
  assert.equal(reversalArgs.length, 0);
  assert.match(w.lastAutoAnalyze.result, /건너뜀\(차트 구조 불일치/);
});

test('병행 필터: 설정한 구간 기준(%)이 역추세 판단에 그대로 전달된다', async () => {
  const { w, reversalArgs } = makeDualFilterWatcher({ trend: false, reversal: true });
  await w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: -2.1 }, {}, { ...W_DUAL, reversalBandPct: 30 });
  assert.equal(reversalArgs[0].opts.bandPct, 30);
  assert.equal(reversalArgs[0].dir, 'down');
});

test('readWatchCfg: 역추세 기본 켜짐·20%, 범위 밖 값은 5~45로 제한', () => {
  const d = readWatchCfg({ watcher: {} });
  assert.equal(d.reversalFilterEnabled, true);
  assert.equal(d.reversalBandPct, 20);
  assert.equal(readWatchCfg({ watcher: { reversalBandPct: 90 } }).reversalBandPct, 45);
  assert.equal(readWatchCfg({ watcher: { reversalFilterEnabled: false } }).reversalFilterEnabled, false);
});

// --- 가설(H1·H2·M0) 기계 판정 기록 — AI vs 기계 비교용 (docs/04-BACKTEST.md D2) -------------

function bars15m(n, price, range) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ t: i * 900000, o: price, h: price + range / 2, l: price - range / 2, c: price, v: 1 });
  return out;
}

function makeHypothesisWatcher({ trend = true, reversal = true, candles15m = bars15m(30, 84000, 400), price = 84000 } = {}) {
  const runCalls = [];
  const fakeEngine = { running: false, quotaExhaustedUntil: null, run: async (...a) => runCalls.push(a) };
  const marketMod = { fetchMarket: async () => ({ indicators: { price, low20: 83000, high20: 95000 }, intraday: { candles15m } }) };
  const indicatorsMod = { structureAgreesWithDirection: () => trend, reversalAgreesWithDirection: () => reversal, rangePosition: () => 8 };
  const c = fakeCandidateLog();
  // hypothesesMod 를 주입하지 않는다 → 실제 server/hypotheses.js 가 쓰인다
  const w = new Watcher({ engine: fakeEngine, config: {}, notify: null, marketMod, indicatorsMod, triggerLogMod: { recordTrigger() {} }, candidateLogMod: c.mod });
  return { w, runCalls, rows: c.rows };
}

test('가설 기록: BTC -2.3% 급락 + 역추세 → H1 롱(손절 1.5ATR·목표 2.5R), M0 숏, H2 는 종목 불일치', async () => {
  const { w, rows } = makeHypothesisWatcher({ trend: true, reversal: true });
  await w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: -2.3, price: 84000 }, {}, W_DUAL);
  const hy = rows.at(-1).features.hypotheses;
  assert.ok(Array.isArray(hy) && hy.length === 3);
  const h1 = hy.find((x) => x.id === 'H1');
  assert.equal(h1.applies, true);
  assert.equal(h1.side, 'LONG');
  assert.equal(h1.atr, 400);
  assert.equal(h1.stop, 84000 - 600);
  assert.equal(h1.target, 84000 + 1500);
  assert.equal(h1.maxHoldBars, 96);
  const m0 = hy.find((x) => x.id === 'M0');
  assert.equal(m0.applies, true);
  assert.equal(m0.side, 'SHORT');
  const h2 = hy.find((x) => x.id === 'H2');
  assert.equal(h2.applies, false);
  assert.match(h2.reason, /대상 종목 아님/);
});

test('가설 기록: 구조 필터에서 탈락한 후보에도 가설 판정이 남는다(전부 미적용이어도 사유와 함께)', async () => {
  const { w, rows, runCalls } = makeHypothesisWatcher({ trend: false, reversal: false });
  await w._maybeAutoAnalyze({ symbol: 'ETH', kind: 'move', value: 2.4, price: 2700 }, {}, W_DUAL);
  assert.equal(runCalls.length, 0);
  assert.equal(rows.at(-1).stage, 'structure');
  const hy = rows.at(-1).features.hypotheses;
  assert.equal(hy.length, 3);
  for (const x of hy) assert.equal(x.applies, false);
  assert.match(hy.find((x) => x.id === 'H2').reason, /trend 필터 불통과/);
});

test('가설 기록: 15분봉이 없으면 ATR 없음으로 미적용 기록, 흐름은 그대로 진행', async () => {
  const { w, rows } = makeHypothesisWatcher({ candles15m: [] });
  await w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: -2.3, price: 84000 }, {}, W_DUAL);
  assert.equal(w.lastAutoAnalyze.result, '실행');
  const h1 = rows.at(-1).features.hypotheses.find((x) => x.id === 'H1');
  assert.equal(h1.applies, false);
  assert.match(h1.reason, /ATR 없음/);
});

test('가설 기록: hypothesesMod 가 없어도(주입 null) 감시·분석은 정상 동작한다', async () => {
  const runCalls = [];
  const fakeEngine = { running: false, quotaExhaustedUntil: null, run: async (...a) => runCalls.push(a) };
  const marketMod = { fetchMarket: async () => ({ indicators: { price: 84000, low20: 83000, high20: 95000 } }) };
  const indicatorsMod = { structureAgreesWithDirection: () => true, reversalAgreesWithDirection: () => true, rangePosition: () => 8 };
  const c = fakeCandidateLog();
  const w = new Watcher({ engine: fakeEngine, config: {}, notify: null, marketMod, indicatorsMod, triggerLogMod: { recordTrigger() {} }, candidateLogMod: c.mod, hypothesesMod: null });
  await w._maybeAutoAnalyze({ symbol: 'BTC', kind: 'move', value: -2.3, price: 84000 }, {}, W_DUAL);
  assert.equal(w.lastAutoAnalyze.result, '실행');
  assert.equal(c.rows.at(-1).features.hypotheses, undefined);
});

// --- alertKinds: 텔레그램으로 보낼 알림 종류 제한 (거래량 알림 소음 제거) ------------------------

test('readWatchCfg: alertKinds 기본은 전부, 설정하면 그대로', () => {
  assert.deepEqual(readWatchCfg({ watcher: {} }).alertKinds, ['move', 'volume', 'funding', 'premium']);
  assert.deepEqual(readWatchCfg({ watcher: { alertKinds: ['move'] } }).alertKinds, ['move']);
});

test('_raise: alertKinds 에 없는 종류는 텔레그램으로 보내지 않지만 기록·방송은 된다', () => {
  const sent = [];
  const notify = { sendAlert: async (a) => { sent.push(a.kind); return { ok: true }; } };
  const w = new Watcher({ engine: { running: false, run: async () => {} }, config: {}, notify, marketMod: null, indicatorsMod: null, triggerLogMod: null, candidateLogMod: null, hypothesesMod: null });
  const cfg = readWatchCfg({ watcher: { alertKinds: ['move'], autoAnalyze: false } });
  w._raise({ symbol: 'BTC', display: 'BTC', kind: 'volume', severity: 'info', value: 3, threshold: 2.5, price: 100, message: 'v' }, {}, cfg, false);
  w._raise({ symbol: 'BTC', display: 'BTC', kind: 'move', severity: 'warn', value: 2, threshold: 1.5, price: 100, message: 'm' }, {}, cfg, false);
  assert.deepEqual(sent, ['move']);
  assert.equal(w.alerts.length, 2, '기록은 둘 다 남는다');
});

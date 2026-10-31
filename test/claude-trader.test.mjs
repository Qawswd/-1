import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CT = require('../server/claude-trader.js');
const OR = require('../server/owner-record.js');

const MIN = 60000;
const P = CT.effectiveParams({ enabled: true });
const fresh = () => ({ startT: 0, cash: 10000, positions: [], closed: [], decisions: [], rejections: 0, failures: 0, snapshots: [], runKeys: {}, lastMonitorAt: 0, ended: null });

test('validateActions: 손절 없는 진입·반대편 손절·1배 초과·잡주는 막고, 청산으로 생긴 여유는 쓴다', () => {
  const st = fresh();
  const marks = { BTCUSDT: 100000, ETHUSDT: 2500, NVDAUSDT: 180 };
  const r = CT.validateActions([
    { type: 'OPEN', symbol: 'BTCUSDT', side: 'LONG', sizePct: 60, stop: 95000, target: 110000, reason: 'a' },
    { type: 'OPEN', symbol: 'ETHUSDT', side: 'SHORT', sizePct: 50, stop: 2600 },
    { type: 'OPEN', symbol: 'NVDAUSDT', side: 'LONG', sizePct: 10 },
    { type: 'OPEN', symbol: 'DOGEUSDT', side: 'LONG', sizePct: 10, stop: 0.09 },
    { type: 'OPEN', symbol: 'NVDAUSDT', side: 'LONG', sizePct: 10, stop: 190 },
  ], { st, marks, p: P });
  assert.deepEqual(r.accepted.map((a) => a.symbol), ['BTCUSDT']);
  assert.deepEqual(r.rejected.map((x) => x.why), ['1배 넘음(이미 60% + 50%)', '손절 필수 — 현재가 반대편 0.3~25%', '허용 종목 아님', '손절 필수 — 현재가 반대편 0.3~25%']);
  // 열린 BTC 60% 를 닫고 같은 판단에서 ETH 숏 90% — 청산이 먼저라 된다
  CT.openPos(st, r.accepted[0], 100000, P, 1);
  const r2 = CT.validateActions([{ type: 'OPEN', symbol: 'ETHUSDT', side: 'SHORT', sizePct: 90, stop: 2700 }, { type: 'CLOSE', symbol: 'BTCUSDT' }], { st, marks, p: P });
  assert.deepEqual(r2.accepted.map((a) => a.type), ['CLOSE', 'OPEN']);
  const r3 = CT.validateActions([{ type: 'MOVE_STOP', symbol: 'BTCUSDT', stop: 90000 }, { type: 'MOVE_STOP', symbol: 'BTCUSDT', stop: 98000 }], { st, marks, p: P });
  assert.deepEqual(r3.accepted.map((a) => a.stop), [98000], '손절은 당기기만');
});

test('checkExit: 진입 전 봉은 보지 않고, 한 봉에 손절·익절이 다 있으면 손절 먼저, 갭이면 시가', () => {
  const pos = { side: 'LONG', stop: 95, target: 110, openedAt: 10 * MIN };
  const bar = (i, o, h, l, c) => ({ t: i * MIN, o, h, l, c });
  assert.equal(CT.checkExit(pos, [bar(9, 100, 100, 90, 95)]), null, '진입 전 봉');
  assert.deepEqual(CT.checkExit(pos, [bar(11, 100, 112, 94, 100)]), { why: '손절', price: 95, t: 11 * MIN });
  assert.deepEqual(CT.checkExit(pos, [bar(12, 93, 94, 92, 93)]), { why: '손절', price: 93, t: 12 * MIN });
  assert.deepEqual(CT.checkExit(pos, [bar(13, 100, 111, 99, 110)]), { why: '익절', price: 110, t: 13 * MIN });
  const short = { side: 'SHORT', stop: 105, target: 90, openedAt: 0 };
  assert.equal(CT.checkExit(short, [bar(1, 100, 104, 91, 100)]), null);
  assert.equal(CT.checkExit(short, [bar(2, 100, 106, 95, 100)]).why, '손절');
});

test('features · equityOf · returnSince', () => {
  const daily = Array.from({ length: 60 }, (_, i) => ({ t: i, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i }));
  const hourly = Array.from({ length: 48 }, (_, i) => ({ t: i, o: 150 + i * 0.1, h: 151, l: 149, c: 150 }));
  const f = CT.features(daily, hourly, 160, Array.from({ length: 30 }, (_, i) => ({ t: i, o: 150, h: 151, l: 149, c: 150 })));
  assert.ok(f.vs4hSma20 > 6 && f.vs4hSma20 < 7, `4시간 20봉선 대비 ${f.vs4hSma20}`);
  assert.equal(f.price, 160);
  assert.equal(f.days, 59);
  assert.ok(f.vsSma20 > 0 && f.vsSma200 === null);
  assert.equal(f.rsi14, 100);
  const st = fresh();
  st.positions.push({ symbol: 'BTCUSDT', side: 'SHORT', qty: 0.1, entry: 100000, lastMark: 100000 });
  assert.equal(CT.equityOf(st, { BTCUSDT: 90000 }), 11000);
  assert.equal(CT.returnSince([{ t: 1, equity: 100 }, { t: 5, equity: 110 }, { t: 9, equity: 121 }], 4), 10);
  assert.equal(CT.returnSince([{ t: 1, equity: 100 }], 0), null);
});

test('buildPrompt: 규칙·종목·출력 형식이 들어간다', () => {
  const txt = CT.buildPrompt({ now: Date.parse('2026-10-16T00:30:00Z'), feats: { BTCUSDT: { price: 1, days: 200 } }, funding: {}, st: fresh(), marks: {}, p: P });
  for (const k of ['1배', '손절(stop) 필수', 'BTCUSDT', '"actions"', 'WebSearch', '−15%', '내 원칙', '지난 판단 메모', '09:30, 23:40']) assert.ok(txt.includes(k), k);
  const st = fresh();
  st.decisions.push({ t: Date.parse('2026-10-15T00:30:00Z'), ok: true, view: '약세 전환 의심', note: 'CPI 뒤 다시 보기' });
  assert.ok(CT.buildPrompt({ now: Date.now(), feats: {}, funding: {}, st, marks: {}, p: P }).includes('CPI 뒤 다시 보기'), '지난 메모를 다음 판단에 넘긴다');
});

// 가짜 바이낸스: 마크가 · 펀딩 · 봉
function fakeMarket(box) {
  return async (url) => {
    const sym = (/symbol=([A-Z]+)/.exec(url) || [])[1];
    if (/premiumIndex/.test(url)) return { markPrice: String(box.mark[sym] || 100), lastFundingRate: '0.0001', nextFundingTime: box.nextFunding || 0 };
    if (/interval=1d/.test(url)) return Array.from({ length: 30 }, (_, i) => [i * 86400000, '100', '101', '99', String(100 + i)]);
    if (/interval=1h/.test(url)) return Array.from({ length: 48 }, (_, i) => [i * 3600000, '100', '101', '99', '100']);
    if (/interval=(1m|15m)/.test(url)) return box.candles || [];
    return {};
  };
}
const cli = (obj) => ({ stdout: JSON.stringify({ type: 'result', result: JSON.stringify(obj), total_cost_usd: 0.2 }), stderr: '', code: 0 });

test('runTraderOnce: 첫 틱에 판단해 진입 → 손절에 닿으면 실제 봉으로 청산 · 알림', async () => {
  const msgs = [];
  const box = { mark: { BTCUSDT: 100000 } };
  const T0 = Date.parse('2026-10-16T01:00:00Z'); // 한국 10:00
  const spawnFn = async () => cli({ view: '강세', actions: [{ type: 'OPEN', symbol: 'BTCUSDT', side: 'LONG', sizePct: 50, stop: 95000, target: null, reason: '추세' }] });
  const cfg = { claudeTrader: { enabled: true } };
  let r = await CT.runTraderOnce({ cfg, now: T0, fetchJson: fakeMarket(box), spawnFn, notify: async (m) => msgs.push(m) });
  assert.equal(r.state.positions.length, 1);
  assert.match(msgs[0], /Claude 진입/);
  assert.equal(r.state.snapshots.length, 1);
  // 같은 날 다시 불러도 판단은 한 번
  let calls = 0;
  r = await CT.runTraderOnce({ cfg, now: T0 + 6 * MIN, state: r.state, fetchJson: fakeMarket(box), spawnFn: async () => { calls++; return cli({ actions: [] }); } });
  assert.equal(calls, 0);
  // 1분봉 저가가 손절에 닿았다
  box.candles = [[T0 + 8 * MIN, '99000', '99500', '94000', '94500']];
  box.mark.BTCUSDT = 94500;
  r = await CT.runTraderOnce({ cfg, now: T0 + 12 * MIN, state: r.state, fetchJson: fakeMarket(box), spawnFn, notify: async (m) => msgs.push(m) });
  assert.equal(r.state.positions.length, 0);
  assert.equal(r.state.closed[0].why, '손절');
  assert.equal(r.state.closed[0].exit, 95000);
  assert.ok(r.state.cash < 10000 && r.state.cash > 9700, `5% 손실 × 50% + 비용 → ${r.state.cash}`);
  assert.match(msgs[msgs.length - 1], /Claude 손절/);
});

test('runTraderOnce: 판단 실패(한도)는 기록·알림만, 꺼져 있으면 아무것도 안 한다, −15% 면 경기 끝', async () => {
  const box = { mark: {} };
  const T0 = Date.parse('2026-10-16T01:00:00Z');
  const msgs = [];
  const limit = async () => ({ stdout: JSON.stringify({ type: 'result', is_error: true, api_error_status: 429, result: "You've hit your session limit" }), stderr: '', code: 0 });
  let r = await CT.runTraderOnce({ cfg: { claudeTrader: { enabled: true } }, now: T0, fetchJson: fakeMarket(box), spawnFn: limit, notify: async (m) => msgs.push(m) });
  assert.equal(r.state.failures, 1);
  assert.match(msgs[0], /사용량 한도/);
  assert.equal((await CT.runTraderOnce({ cfg: { claudeTrader: { enabled: false } }, now: T0 })).skipped, '꺼짐');
  const st = { ...r.state, cash: 8400 };
  r = await CT.runTraderOnce({ cfg: { claudeTrader: { enabled: true } }, now: T0 + 10 * MIN, state: st, fetchJson: fakeMarket(box), spawnFn: limit });
  assert.ok(r.state.ended && /손실 한도/.test(r.state.ended.reason));
});

test('pickExtraStocks: 거래대금 상위 + 많이 움직인 바이낸스 미국 주식만 — 핵심 종목·원자재·알트·레버리지 제외', () => {
  const info = { symbols: [
    ...['PLTRUSDT', 'MSTRUSDT', 'COINUSDT', 'AMDUSDT', 'IONQUSDT', 'INTCUSDT', 'NVDAUSDT', 'XAUUSDT', 'SOXLUSDT'].map((symbol) => ({ symbol, contractType: 'TRADIFI_PERPETUAL' })),
    { symbol: 'DOGEUSDT', contractType: 'PERPETUAL' },
  ] };
  OR._setTradfiMetaForTest({ symbols: [...['PLTR', 'MSTR', 'COIN', 'AMD', 'IONQ', 'INTC', 'NVDA'].map((binance) => ({ binance, ok: true })), { binance: 'SOXL', ok: false, reason: '레버리지 ETF' }, { binance: 'MVLL', ok: false, reason: 'Yahoo 에 없음' }] });
  info.symbols.push({ symbol: 'MVLLUSDT', contractType: 'TRADIFI_PERPETUAL' });
  const t = (symbol, qv, chg) => ({ symbol, quoteVolume: String(qv), priceChangePercent: String(chg) });
  const tickers = [t('PLTRUSDT', 900, 1), t('MSTRUSDT', 800, 2), t('COINUSDT', 700, 1), t('AMDUSDT', 600, 1), t('IONQUSDT', 500, 25), t('INTCUSDT', 10, 40), t('NVDAUSDT', 5000, 3), t('XAUUSDT', 9000, 1), t('SOXLUSDT', 9000, 9), t('DOGEUSDT', 9000, 9), t('MVLLUSDT', 9999, 30)];
  try {
    assert.deepEqual(CT.pickExtraStocks(tickers, info, CT.UNIVERSE, 3), ['PLTRUSDT', 'MSTRUSDT', 'COINUSDT']);
    const all = CT.pickExtraStocks(tickers, info);
    assert.ok(!all.includes('NVDAUSDT') && !all.includes('XAUUSDT') && !all.includes('SOXLUSDT') && !all.includes('DOGEUSDT') && !all.includes('MVLLUSDT'), all.join(' '));
    assert.ok(all.includes('IONQUSDT'), '거래대금 중간 이상 + 등락 상위');
    assert.deepEqual(CT.pickExtraStocks(null, info), []);
    OR._setTradfiMetaForTest(null);
    assert.deepEqual(CT.pickExtraStocks(tickers, info), [], '확인 목록이 없으면 추가 종목 없이 핵심 11개만');
  } finally {
    OR._setTradfiMetaForTest(undefined);
  }
});

test('validateActions: 허용 판단 함수를 넘기면 표 밖의 미국 주식도 된다(현재가가 있을 때)', () => {
  const st = fresh();
  const isAllowed = (s) => CT.UNIVERSE.includes(s) || s === 'PLTRUSDT';
  const r = CT.validateActions([{ type: 'OPEN', symbol: 'PLTRUSDT', side: 'LONG', sizePct: 10, stop: 170 }, { type: 'OPEN', symbol: 'DOGEUSDT', side: 'LONG', sizePct: 10, stop: 0.09 }], { st, marks: { PLTRUSDT: 180, DOGEUSDT: 0.1 }, p: P, isAllowed });
  assert.deepEqual(r.accepted.map((a) => a.symbol), ['PLTRUSDT']);
  assert.deepEqual(r.rejected.map((x) => x.why), ['허용 종목 아님']);
});

test('askClaude: 실패하면 이유와 응답 일부를 남긴다', async () => {
  const r = await CT.askClaude('x', P, async () => ({ stdout: JSON.stringify({ type: 'result', result: 'model not available for your plan' }), stderr: '', code: 1 }));
  assert.equal(r.ok, false);
  assert.match(r.error, /응답을 읽지 못함\(종료코드 1\)/);
  assert.match(r.detail, /model not available/);
});

test('tradeStats: 롱/숏 · 코인/주식 · 나간 방식별 성적(복기의 근거)', () => {
  const c = (symbol, side, pnl, pct, why) => ({ symbol, side, pnl, pct, why, openedAt: 0, closedAt: 2 * 3600000 });
  const ts = CT.tradeStats([c('BTCUSDT', 'LONG', 100, 2, '익절'), c('NVDAUSDT', 'SHORT', -50, -1, '손절'), c('ETHUSDT', 'LONG', -50, -1, '손절')]);
  assert.equal(ts.all.n, 3);
  assert.equal(ts.all.winRate, 33.33);
  assert.equal(ts.all.pf, 1);
  assert.equal(ts.long.pnl, 50);
  assert.equal(ts.short.n, 1);
  assert.equal(ts.stock.n, 1);
  assert.equal(ts.coin.n, 2);
  assert.deepEqual(ts.byExit, { 손절: 2, 익절: 1, '판단 청산': 0 });
  assert.equal(ts.all.holdHours, 2);
  assert.equal(CT.tradeStats([]).all.winRate, null);
});

test('복기 루프: 프롬프트에 성적표·복기 대상·교훈 노트가 들어가고, 답의 교훈·거래별 복기·복기를 저장해 다음에 넘긴다', async () => {
  const st = fresh();
  st.closed.push({ symbol: 'BTCUSDT', side: 'LONG', entry: 100, exit: 95, why: '손절', pct: -5, pnl: -250, openedAt: 1, closedAt: 2, reason: '돌파 기대' });
  st.lessons = ['큰 일정 전엔 작게'];
  const txt = CT.buildPrompt({ now: Date.now(), feats: {}, funding: {}, st, marks: {}, p: P });
  for (const k of ['내 성적표', '복기 대상', '진입 이유: 돌파 기대', '1. 큰 일정 전엔 작게', '먼저 복기하라', '"lessons"', '"postmortems"', '한두 번 결과로 원칙을 뒤집지 마라']) assert.ok(txt.includes(k), k);

  const box = { mark: {} };
  const T0 = Date.parse('2026-10-16T01:00:00Z');
  const ans = { review: '돌파가 거짓이었다', postmortems: [{ symbol: 'BTCUSDT', lesson: '거래량 없는 돌파는 믿지 말자' }], lessons: ['큰 일정 전엔 작게', '거래량 없는 돌파는 믿지 말자'], view: '관망', actions: [] };
  const r = await CT.runTraderOnce({ cfg: { claudeTrader: { enabled: true } }, now: T0, state: { ...st, startT: T0 - 1000, snapshots: [] }, fetchJson: fakeMarket(box), spawnFn: async () => cli(ans) });
  assert.deepEqual(r.state.lessons, ['큰 일정 전엔 작게', '거래량 없는 돌파는 믿지 말자']);
  assert.equal(r.state.lessonHistory.length, 1);
  assert.equal(r.state.closed[0].postmortem, '거래량 없는 돌파는 믿지 말자');
  assert.equal(r.state.decisions[r.state.decisions.length - 1].review, '돌파가 거짓이었다');
  const next = CT.buildPrompt({ now: T0 + 1, feats: {}, funding: {}, st: r.state, marks: {}, p: P });
  assert.ok(next.includes('2. 거래량 없는 돌파는 믿지 말자'), '고친 교훈이 다음 판단으로 간다');
  assert.ok(next.includes('(복기 대상):\n- 없음'), '이미 복기한 거래는 다시 묻지 않는다');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const OR = require('../server/owner-record.js');

const MIN = 60000;
const NOW = Date.parse('2026-10-20T03:00:00Z'); // 한국 12:00 (월요일)
const INFO = { symbols: [
  { symbol: 'TSLAUSDT', contractType: 'TRADIFI_PERPETUAL' },
  { symbol: 'XAUUSDT', contractType: 'TRADIFI_PERPETUAL' },
  { symbol: 'DOGEUSDT', contractType: 'PERPETUAL' },
] };

test('checkKeyRestrictions: 읽기만 켜진 키만 쓴다 — 주문·출금·이체 권한이 하나라도 있으면 거부', () => {
  assert.deepEqual(OR.checkKeyRestrictions({ enableReading: true, ipRestrict: true, enableFutures: false, enableWithdrawals: false, enableFixReadOnly: true }), { ok: true, problems: [], warnings: [] });
  const bad = OR.checkKeyRestrictions({ enableReading: true, ipRestrict: false, enableFutures: true, enableWithdrawals: true });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.problems, ['선물 주문 권한이 켜져 있음', '출금 권한이 켜져 있음']);
  assert.equal(bad.warnings.length, 1, 'IP 제한 없음은 경고');
  assert.deepEqual(OR.checkKeyRestrictions({ enableReading: false, ipRestrict: true }).problems, ['읽기 권한이 꺼져 있음']);
  assert.equal(OR.checkKeyRestrictions(null).ok, false);
  assert.equal(OR.checkKeyRestrictions({ enableReading: true, enableSomethingNew: true }).ok, false, '모르는 새 권한도 켜져 있으면 거부');
});

test('isAllowedSymbol: BTC·ETH 와 바이낸스 미국 주식만 — 원자재·알트는 아님, 종목 정보가 없으면 보류(null)', () => {
  assert.equal(OR.isAllowedSymbol('BTCUSDT', null), true);
  assert.equal(OR.isAllowedSymbol('ETHUSDC', INFO), true);
  assert.equal(OR.isAllowedSymbol('TSLAUSDT', INFO), true);
  assert.equal(OR.isAllowedSymbol('XAUUSDT', INFO), false);
  assert.equal(OR.isAllowedSymbol('DOGEUSDT', INFO), false);
  assert.equal(OR.isAllowedSymbol('TSLAUSDT', null), null);
});

test('checkRules: 손절 없는 포지션(열고 5분 지남) · 1배 넘는 노출 · 잡주를 잡는다', () => {
  const positions = [
    { symbol: 'BTCUSDT', positionAmt: '0.01', markPrice: '100000', notional: '1000', updateTime: NOW - 60 * MIN },
    { symbol: 'ETHUSDT', positionAmt: '-0.2', markPrice: '2500', notional: '-500', updateTime: NOW - 60 * MIN },
    { symbol: 'TSLAUSDT', positionAmt: '1', markPrice: '300', notional: '300', updateTime: NOW - 2 * MIN },
    { symbol: 'DOGEUSDT', positionAmt: '0', markPrice: '0.1', notional: '0' },
  ];
  const stopOrders = { BTCUSDT: [{ orderType: 'STOP_MARKET', side: 'SELL', triggerPrice: '90000', algoStatus: 'NEW' }], ETHUSDT: [{ type: 'TAKE_PROFIT_MARKET', side: 'BUY', stopPrice: '2000' }] };
  const r = OR.checkRules({ positions, stopOrders, equity: 2000, info: INFO, now: NOW });
  assert.deepEqual(r.violations.map((v) => v.key), ['stop:ETHUSDT:SHORT'], 'ETH 숏은 익절만 있고 손절 없음 · TSLA 는 아직 5분 전');
  assert.equal(r.exposure, 0.9);
  const lev = OR.checkRules({ positions, stopOrders, equity: 1000, info: INFO, now: NOW });
  assert.ok(lev.violations.some((v) => v.kind === 'leverage'));
  const junk = OR.checkRules({ positions: [{ symbol: 'DOGEUSDT', positionAmt: '100', markPrice: '0.1', updateTime: NOW }], stopOrders: {}, equity: 1000, info: INFO, now: NOW });
  assert.deepEqual(junk.violations.map((v) => v.kind), ['symbol']);
  assert.deepEqual(OR.junkSymbolsFromIncome([{ symbol: 'DOGEUSDT', incomeType: 'REALIZED_PNL', income: '1' }, { symbol: 'BTCUSDT', incomeType: 'COMMISSION', income: '-1' }], INFO), ['DOGEUSDT']);
});

test('flowsOf · chainReturns: 입금·출금은 수익에서 뺀다', () => {
  const income = [
    { time: 10, incomeType: 'TRANSFER', income: '100', asset: 'USDT' },
    { time: 11, incomeType: 'REALIZED_PNL', income: '50', asset: 'USDT' },
    { time: 12, incomeType: 'TRANSFER', income: '-30', asset: 'BNB' },
  ];
  assert.equal(OR.flowsOf(income, 0, 20), 100);
  assert.equal(OR.flowsOf(income, 10, 20), 0, '구간은 (from, to]');
  const snaps = [{ equity: 1000, flows: 0 }, { equity: 1100, flows: 100 }, { equity: 1210, flows: 0 }, { equity: 968, flows: 0 }];
  const r = OR.chainReturns(snaps);
  assert.equal(r.totalPct, -12, '0% → +10% → −20% = 1.1 × 0.8');
  assert.equal(r.maxDrawdownPct, 20);
  assert.equal(OR.ownerEquity([{ asset: 'USDT', balance: '100', crossUnPnl: '-5' }, { asset: 'USDC', balance: '50', crossUnPnl: '0' }]), 145);
  assert.equal(OR.ownerEquity([]), null);
});

test('createReadOnlyClient: GET 만 보내고 주문·취소 함수가 없다', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, method: opts.method }); return { ok: true, json: async () => [] }; };
  const c = OR.createReadOnlyClient({ apiKey: 'k', apiSecret: 's', fetchImpl });
  for (const fn of Object.values(c)) await fn('BTCUSDT');
  assert.ok(calls.length >= 6);
  assert.ok(calls.every((x) => x.method === 'GET'));
  assert.ok(calls.every((x) => /^https:\/\/(fapi|api)\.binance\.com\/(fapi|sapi)\//.test(x.url)));
  assert.ok(calls.every((x) => /signature=/.test(x.url)));
  for (const name of ['placeMarketOrder', 'placeStopLoss', 'flattenPosition', 'cancelAllAlgoOrders', 'setLeverage']) assert.equal(c[name], undefined);
  assert.ok(Object.isFrozen(c));
  assert.throws(() => OR.createReadOnlyClient({}), /OWNER_BINANCE_API_KEY/);
});

function fakeClient({ restrictions = { enableReading: true, ipRestrict: true }, equity = 1000, positions = [], income = [] } = {}) {
  const box = { equity, positions, income, restrictions };
  return {
    box,
    getApiRestrictions: async () => box.restrictions,
    getAccountBalance: async () => [{ asset: 'USDT', balance: String(box.equity), crossUnPnl: '0' }],
    getPositions: async () => box.positions,
    getOpenOrders: async () => [],
    getOpenAlgoOrders: async () => [],
    getIncomeHistory: async () => box.income,
  };
}
const fetchJson = async (url) => (/exchangeInfo/.test(url) ? INFO : { markPrice: '500' });
const CFG = { ownerRecord: { enabled: true, startDate: '2026-10-20', days: 90, maxLossPct: 15 } };

test('runOwnerOnce: 키 권한이 넘치면 아무것도 읽지 않고 하루 한 번만 알린다', async () => {
  const msgs = [];
  const client = fakeClient({ restrictions: { enableReading: true, enableFutures: true } });
  let r = await OR.runOwnerOnce({ cfg: CFG, client, fetchJson, notify: async (m) => msgs.push(m), now: NOW });
  assert.equal(r.skipped, '키 권한');
  r = await OR.runOwnerOnce({ cfg: CFG, client, fetchJson, notify: async (m) => msgs.push(m), now: NOW + 5 * MIN, state: r.state });
  assert.equal(msgs.length, 1);
  assert.match(msgs[0], /선물 주문 권한/);
  assert.equal(r.state.snapshots.length, 0);
});

test('runOwnerOnce: 기준점 기록 → 위반은 한 번만 알림 → 손실 한도면 끝', async () => {
  const msgs = [];
  const notify = async (m) => msgs.push(m);
  const client = fakeClient();
  let r = await OR.runOwnerOnce({ cfg: CFG, client, fetchJson, notify, now: NOW });
  assert.equal(r.state.snapshots.length, 1);
  assert.match(msgs[0], /기록 시작/);
  // 손절 없는 숏이 생겼다 — 두 번 점검해도 알림은 한 번
  client.box.positions = [{ symbol: 'ETHUSDT', positionAmt: '-0.1', markPrice: '2500', notional: '-250', updateTime: NOW }];
  r = await OR.runOwnerOnce({ cfg: CFG, client, fetchJson, notify, now: NOW + 20 * MIN, state: r.state });
  r = await OR.runOwnerOnce({ cfg: CFG, client, fetchJson, notify, now: NOW + 40 * MIN, state: r.state });
  assert.equal(msgs.filter((m) => /규칙 위반/.test(m)).length, 1);
  assert.equal(r.state.violationLog.length, 1);
  // 다음 날 순자산 −20% → 손실 한도로 끝
  client.box.positions = [];
  client.box.equity = 800;
  r = await OR.runOwnerOnce({ cfg: CFG, client, fetchJson, notify, now: NOW + 24 * 60 * MIN, state: r.state });
  assert.ok(r.state.ended && /손실 한도/.test(r.state.ended.reason));
  assert.match(msgs[msgs.length - 1], /겨루기 끝/);
  const after = await OR.runOwnerOnce({ cfg: CFG, client, fetchJson, notify, now: NOW + 25 * 60 * MIN, state: r.state });
  assert.equal(after.skipped, '끝남');
});

test('runOwnerOnce: 시작 전·꺼짐이면 아무것도 안 한다, 입금은 수익으로 세지 않는다', async () => {
  assert.equal((await OR.runOwnerOnce({ cfg: { ownerRecord: { enabled: false } }, client: fakeClient(), fetchJson, now: NOW })).skipped, '꺼짐');
  assert.equal((await OR.runOwnerOnce({ cfg: CFG, client: fakeClient(), fetchJson, now: Date.parse('2026-10-19T00:00:00Z') })).skipped, '시작 전');
  const client = fakeClient();
  let r = await OR.runOwnerOnce({ cfg: CFG, client, fetchJson, now: NOW });
  client.box.equity = 1500;
  client.box.income = [{ time: NOW + 60 * MIN, incomeType: 'TRANSFER', income: '500', asset: 'USDT' }];
  r = await OR.runOwnerOnce({ cfg: CFG, client, fetchJson, now: NOW + 24 * 60 * MIN, state: r.state });
  assert.equal(OR.chainReturns(r.state.snapshots).totalPct, 0);
});

test('keyDiagnostics: 키 값은 내보내지 않고 원인만 — 데모 키 · 길이 · 공백 · 바이낸스 오류 종류', () => {
  const k = 'a'.repeat(64);
  const h = OR.keyDiagnostics({ ownerKey: k, ownerSecret: 'b'.repeat(64), demoKey: k, error: '[owner] x 실패: Invalid Api-Key ID.' });
  assert.ok(h.some((x) => /데모/.test(x)));
  assert.ok(h.some((x) => /모릅니다/.test(x)));
  assert.ok(h.every((x) => !x.includes(k)), '키 값이 메시지에 없다');
  assert.ok(OR.keyDiagnostics({ ownerKey: 'abc ', ownerSecret: 'x'.repeat(64) }).some((x) => /공백/.test(x)));
  assert.ok(OR.keyDiagnostics({ ownerKey: 'a'.repeat(60), ownerSecret: 'x'.repeat(64) }).some((x) => /60자/.test(x)));
  assert.ok(OR.keyDiagnostics({ ownerKey: k, ownerSecret: 'x'.repeat(64), error: 'Signature for this request is not valid.' }).some((x) => /HMAC/.test(x)));
  assert.deepEqual(OR.keyDiagnostics({ ownerKey: k, ownerSecret: 'x'.repeat(64), demoKey: 'z'.repeat(64) }), []);
});

test('chainReturns 수정 디에츠: 빈 계좌에서 하루 중간에 넣은 돈으로 번 수익이 수천 % 로 부풀지 않는다', () => {
  const income = [{ time: 50, incomeType: 'TRANSFER', income: '1000', asset: 'USDT' }];
  assert.equal(OR.weightedFlowsOf(income, 0, 100), 500, '구간 한가운데 입금 → 절반만');
  assert.equal(OR.weightedFlowsOf(income, 0, 0), 0);
  const snaps = [{ equity: 1.11 }, { equity: 1051.11, flows: 1000, wFlows: 500 }];
  const r = OR.chainReturns(snaps);
  assert.ok(r.totalPct > 9 && r.totalPct < 10.5, `${r.totalPct}`);
  const noW = OR.chainReturns([{ equity: 1.11 }, { equity: 1051.11, flows: 1000 }]);
  assert.ok(noW.totalPct > 4.9 && noW.totalPct < 5.1, '머문 비율을 모르면 처음에 넣은 것으로(보수적)');
  const sys = OR.chainReturns([{ systemEquity: 5000 }, { systemEquity: 5500 }], 'systemEquity', '_none');
  assert.equal(sys.totalPct, 10);
});

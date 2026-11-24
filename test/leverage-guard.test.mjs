import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../server/leverage-guard.js');

const READ_ONLY = { enableReading: true, enableFutures: false, enableWithdrawals: false, ipRestrict: true };
const MIN = 60000;
const T0 = Date.parse('2026-10-30T01:00:00Z'); // 한국 10:00

function fakeClient({ rows = [], positions = [], restrictions = READ_ONLY, symbolConfigFails = false } = {}) {
  const box = { rows, positions, restrictions, calls: [] };
  box.client = {
    getApiRestrictions: async () => (box.calls.push('restrictions'), box.restrictions),
    getSymbolConfig: async () => {
      box.calls.push('symbolConfig');
      if (symbolConfigFails) throw new Error('404');
      return box.rows;
    },
    getPositionsV2: async () => (box.calls.push('positionRisk v2'), box.rows),
    getPositions: async () => (box.calls.push('positions'), box.positions),
  };
  return box;
}

function guard(box, cfgExtra = {}) {
  const sent = [];
  let now = T0;
  const cfg = { leverageGuard: { enabled: true }, ownerSignal: { symbols: ['BTCUSDT', 'ETHUSDT'], stocks: ['PLTR', 'BRK-B'] }, ...cfgExtra };
  const g = new L.LeverageGuard({ loadConfig: () => cfg, notifyMod: { sendMessage: async (t) => sent.push(t) }, makeClient: () => box.client, now: () => now });
  return { g, sent, cfg, at: (ms) => (now = ms) };
}

test('leverageMap: symbolConfig · v2 positionRisk 모양 둘 다, 이상한 줄은 버린다', () => {
  const m = L.leverageMap([{ symbol: 'BTCUSDT', leverage: 1 }, { symbol: 'PLTRUSDT', leverage: '20', positionAmt: '0' }, { symbol: 'X', leverage: 'abc' }, null]);
  assert.deepEqual([...m], [['BTCUSDT', 1], ['PLTRUSDT', 20]]);
  assert.equal(L.leverageMap(null).size, 0);
});

test('watchedSymbols: 신호의 코인 + 주식(BRK-B → BRKBUSDT) + 따로 넣은 종목, 중복 없음', () => {
  const cfg = { ownerSignal: { symbols: ['BTCUSDT'], stocks: ['PLTR', 'BRK-B'] }, leverageGuard: { extraSymbols: ['msftusdt', 'BTCUSDT', 'bad'] } };
  assert.deepEqual(L.watchedSymbols(cfg), ['BTCUSDT', 'PLTRUSDT', 'BRKBUSDT', 'MSFTUSDT']);
});

test('evaluate: 1배 넘는 설정 · 1배 넘는 채 열린 포지션 · 못 읽은 종목', () => {
  const levMap = new Map([['BTCUSDT', 1], ['ETHUSDT', 5], ['PLTRUSDT', 20]]);
  const ev = L.evaluate({ levMap, positions: [{ symbol: 'PLTRUSDT', positionAmt: '-3' }, { symbol: 'BTCUSDT', positionAmt: '0.01' }], watched: ['BTCUSDT', 'ETHUSDT', 'PLTRUSDT', 'LLYUSDT'] });
  assert.deepEqual(ev.over, [{ symbol: 'ETHUSDT', leverage: 5 }, { symbol: 'PLTRUSDT', leverage: 20 }]);
  assert.deepEqual(ev.openOver, [{ symbol: 'PLTRUSDT', leverage: 20, side: '숏' }]);
  assert.deepEqual(ev.unknown, ['LLYUSDT']);
});

test('tick: 꺼져 있으면 아무것도 읽지 않는다', async () => {
  const box = fakeClient();
  const { g, cfg } = guard(box);
  cfg.leverageGuard.enabled = false;
  assert.equal(await g.tick(), null);
  assert.deepEqual(box.calls, []);
});

test('tick: 키에 주문 권한이 있으면 레버리지를 읽지 않고 한 번만 알린다', async () => {
  const box = fakeClient({ restrictions: { ...READ_ONLY, enableFutures: true } });
  const { g, sent, at } = guard(box);
  assert.deepEqual(await g.tick(), { skipped: '키 권한' });
  at(T0 + 10 * MIN);
  await g.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /키를 쓰지 않았습니다[\s\S]*선물 주문 권한이 켜져 있음/);
  assert.ok(!box.calls.includes('symbolConfig'));
});

test('tick: 1배 넘는 설정은 바로 한 번 경고, 같은 배수면 다시 안 함, 배수가 바뀌면 다시', async () => {
  const box = fakeClient({ rows: [{ symbol: 'BTCUSDT', leverage: 1 }, { symbol: 'ETHUSDT', leverage: 1 }, { symbol: 'PLTRUSDT', leverage: 20 }] });
  const { g, sent, at } = guard(box);
  await g.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0], /레버리지 경고.*PLTRUSDT <b>20배<\/b>/);
  at(T0 + 2 * MIN);
  assert.equal(await g.tick(), null, '5분이 안 지났으면 읽지 않는다');
  at(T0 + 5 * MIN);
  await g.tick();
  assert.equal(sent.length, 1, '같은 배수는 다시 경고하지 않는다');
  box.rows[2].leverage = 10;
  at(T0 + 10 * MIN);
  await g.tick();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /PLTRUSDT <b>10배<\/b>/);
  box.rows[2].leverage = 1;
  at(T0 + 15 * MIN);
  await g.tick();
  box.rows[2].leverage = 10;
  at(T0 + 20 * MIN);
  await g.tick();
  assert.equal(sent.length, 3, '1배로 고쳤다가 다시 올리면 다시 경고');
});

test('tick: 17:20(한국) 에 아직 1배가 아니면 하루 한 번 다시 알린다', async () => {
  const box = fakeClient({ rows: [{ symbol: 'ETHUSDT', leverage: 3 }] });
  const { g, sent, at } = guard(box);
  await g.tick();
  at(Date.parse('2026-10-30T08:20:00Z'));
  await g.tick();
  at(Date.parse('2026-10-30T08:30:00Z'));
  await g.tick();
  assert.equal(sent.length, 2);
  assert.match(sent[1], /ETHUSDT <b>3배<\/b>/);
  at(Date.parse('2026-10-31T08:25:00Z'));
  await g.tick();
  assert.equal(sent.length, 3, '다음 날 다시');
});

test('tick: 1배 넘는 채 열린 포지션은 긴급, 30분마다 다시, 정리되면 멈춘다', async () => {
  const box = fakeClient({ rows: [{ symbol: 'PLTRUSDT', leverage: 20 }], positions: [{ symbol: 'PLTRUSDT', positionAmt: '5' }] });
  const { g, sent, at } = guard(box);
  await g.tick();
  assert.equal(sent.length, 1, '긴급 하나만(같은 종목 설정 경고는 겹쳐 보내지 않는다)');
  assert.match(sent[0], /레버리지 긴급.*PLTRUSDT 롱이 <b>20배<\/b>[\s\S]*약 −5%/);
  at(T0 + 10 * MIN);
  await g.tick();
  assert.equal(sent.length, 1);
  at(T0 + 30 * MIN);
  await g.tick();
  assert.equal(sent.length, 2);
  box.positions = [];
  at(T0 + 60 * MIN);
  await g.tick();
  assert.equal(sent.length, 2, '포지션이 닫히면 긴급은 멈추고, 설정 경고는 이미 본 배수라 조용');
});

test('tick: symbolConfig 가 안 되면 v2 positionRisk 로 읽는다', async () => {
  const box = fakeClient({ rows: [{ symbol: 'BTCUSDT', leverage: 2 }], symbolConfigFails: true });
  const { g, sent } = guard(box);
  await g.tick();
  assert.ok(box.calls.includes('positionRisk v2'));
  assert.match(sent[0], /BTCUSDT <b>2배<\/b>/);
});

test('currentStatus: 종목마다 배수와 할 일, 키에 권한이 있으면 읽지 않는다', async () => {
  const cfg = { ownerSignal: { symbols: ['BTCUSDT', 'ETHUSDT'], stocks: ['LLY'] } };
  const box = fakeClient({ rows: [{ symbol: 'BTCUSDT', leverage: 1 }, { symbol: 'ETHUSDT', leverage: 4 }] });
  const r = await L.currentStatus(cfg, { client: box.client });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'symbolConfig');
  assert.match(r.text, /BTCUSDT 1x ✓\nETHUSDT 4x ⚠️\nLLYUSDT 없음/);
  assert.match(r.text, /들어가기 전에 위 종목을 1배로/);
  box.rows[1].leverage = 1;
  assert.match((await L.currentStatus(cfg, { client: box.client })).text, /모두 1배 ✓/);
  const bad = fakeClient({ restrictions: { ...READ_ONLY, enableWithdrawals: true } });
  const r2 = await L.currentStatus(cfg, { client: bad.client });
  assert.equal(r2.ok, false);
  assert.match(r2.text, /출금 권한/);
  assert.ok(!bad.calls.includes('symbolConfig'));
});

test('effectiveParams: 점검 간격 1~60분, 시각 형식, 기본은 꺼짐', () => {
  assert.deepEqual(L.effectiveParams(undefined), { enabled: false, checkEveryMin: 5, remindKst: '17:20', extraSymbols: [] });
  const p = L.effectiveParams({ enabled: true, checkEveryMin: 0, remindKst: '25:00' });
  assert.equal(p.checkEveryMin, 1);
  assert.equal(p.remindKst, '17:20');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TC = require('../server/telegram-commands.js');
const EX = require('../server/exchange.js');
const { Heartbeat } = require('../server/heartbeat.js');

test('parseCommand: 한국어·영어 명령, 확인 코드, 봇 이름 붙은 명령 · 일반 대화는 무시', () => {
  assert.deepEqual(TC.parseCommand('/긴급정지'), { cmd: 'stop', code: null });
  assert.deepEqual(TC.parseCommand('/stop 4821'), { cmd: 'stop', code: '4821' });
  assert.deepEqual(TC.parseCommand('/status@my_floor_bot'), { cmd: 'status', code: null });
  assert.deepEqual(TC.parseCommand('상태'), { cmd: 'status', code: null });
  assert.deepEqual(TC.parseCommand('/재개 1234'), { cmd: 'resume', code: '1234' });
  assert.equal(TC.parseCommand('BTC 숏 가자').cmd, null);
  assert.equal(TC.parseCommand('/stop now').cmd, null);
});

function harness({ positions = { BTCUSDT: { amt: 0.02, entry: 80000 } }, chatId = '777' } = {}) {
  const sent = [];
  const saved = [];
  let t = 1_000_000;
  const pos = JSON.parse(JSON.stringify(positions));
  const orders = [];
  const client = {
    getPosition: async (symbol) => [{ symbol, positionAmt: String(pos[symbol] ? pos[symbol].amt : 0), entryPrice: String(pos[symbol] ? pos[symbol].entry : 0), markPrice: '80000', unRealizedProfit: '0' }],
    cancelAllAlgoOrders: async (symbol) => { orders.push(['cancel', symbol]); return {}; },
    flattenPosition: async (symbol, side, qty) => { orders.push(['flat', symbol, side, qty]); delete pos[symbol]; return {}; },
    getAccountBalance: async () => [{ asset: 'USDT', balance: '5000', crossUnPnl: '0' }],
    getOpenAlgoOrders: async () => [],
  };
  const cfg = { telegram: { enabled: true, botToken: 'x', chatId }, trend: { enabled: true } };
  const tc = new TC.TelegramCommander({
    loadConfig: () => cfg,
    saveConfig: (patch) => { saved.push(patch); Object.assign(cfg.trend, patch.trend); },
    exchangeMod: EX,
    notifyMod: { sendMessage: async (text) => sent.push(text) },
    makeClient: () => client,
    now: () => t,
  });
  tc._startedAt = t;
  const msg = (text, chat = chatId, date = t) => ({ update_id: 1, message: { chat: { id: Number(chat) }, date: Math.floor(date / 1000), text } });
  return { tc, sent, saved, orders, pos, cfg, msg, tick: (ms) => (t += ms) };
}

test('긴급 정지: 코드 없이는 아무것도 안 하고, 맞는 코드면 추세추종 끄기 + 포지션 전량 정리', async () => {
  const h = harness();
  await h.tc.handle(h.msg('/긴급정지'));
  assert.equal(h.orders.length, 0);
  const code = /\/stop (\d{4})/.exec(h.sent[0])[1];
  await h.tc.handle(h.msg('/stop 0000' === `/stop ${code}` ? '/stop 0001' : '/stop 0000'));
  assert.match(h.sent[1], /맞지 않거나/);
  assert.equal(h.orders.length, 0, '틀린 코드면 아무것도 안 한다');
  await h.tc.handle(h.msg('/긴급정지'));
  const code2 = /\/stop (\d{4})/.exec(h.sent[2])[1];
  await h.tc.handle(h.msg(`/stop ${code2}`));
  assert.equal(h.cfg.trend.enabled, false);
  assert.deepEqual(h.orders.map((o) => o[0]), ['cancel', 'flat']);
  assert.equal(h.orders[1][2], 'SELL', '롱은 팔아서 정리');
  assert.match(h.sent[3], /긴급 정지[\s\S]*BTCUSDT: 롱 0.02 정리 완료[\s\S]*ETHUSDT: 포지션 없음/);
});

test('긴급 정지: 2분 지난 코드 · 다른 채팅방 · 서버 켜기 전 메시지는 무시', async () => {
  const h = harness();
  await h.tc.handle(h.msg('/stop'));
  const code = /\/stop (\d{4})/.exec(h.sent[0])[1];
  h.tick(TC.CODE_TTL_MS + 1000);
  await h.tc.handle(h.msg(`/stop ${code}`));
  assert.equal(h.orders.length, 0);
  assert.equal(h.cfg.trend.enabled, true);
  const n = h.sent.length;
  await h.tc.handle(h.msg('/stop', '999'));
  await h.tc.handle(h.msg('/상태', '777', 1_000_000 - 60_000));
  assert.equal(h.sent.length, n, '다른 방·예전 메시지엔 답하지 않는다');
});

test('재개 · 상태 · 도움', async () => {
  const h = harness();
  h.cfg.trend.enabled = false;
  await h.tc.handle(h.msg('/재개'));
  const code = /\/resume (\d{4})/.exec(h.sent[0])[1];
  await h.tc.handle(h.msg(`/resume ${code}`));
  assert.equal(h.cfg.trend.enabled, true);
  await h.tc.handle(h.msg('/상태'));
  assert.match(h.sent[h.sent.length - 1], /추세추종: 켜짐[\s\S]*순자산 5000 USDT[\s\S]*BTCUSDT 롱 0.02 @80000/);
  await h.tc.handle(h.msg('/도움'));
  assert.match(h.sent[h.sent.length - 1], /긴급정지/);
});

test('pollOnce · start: 쌓여 있던 메시지는 건너뛰고, 다음 메시지부터 offset 을 올리며 처리', async () => {
  const calls = [];
  const queue = [[{ update_id: 41 }], [{ update_id: 42, message: { chat: { id: 777 }, date: 2000, text: '/도움' } }]];
  const sent = [];
  const tc = new TC.TelegramCommander({
    loadConfig: () => ({ telegram: { enabled: true, botToken: 'x', chatId: '777' } }),
    saveConfig: () => {},
    notifyMod: { sendMessage: async (t) => sent.push(t) },
    fetchImpl: async (url) => { calls.push(url); return { ok: true, json: async () => ({ ok: true, result: queue.shift() || [] }) }; },
    now: () => 1_999_000,
  });
  tc._stopped = true; // 반복은 돌리지 않고 한 번씩만
  tc._startedAt = 1_999_000;
  const backlog = await tc.api('getUpdates', { offset: -1, timeout: 0 });
  tc.offset = backlog[backlog.length - 1].update_id + 1;
  await tc.pollOnce();
  assert.match(calls[1], /offset=42/);
  assert.equal(tc.offset, 43);
  assert.match(sent[0], /명령/);
});

test('Heartbeat: 주소가 없으면 꺼짐, 있으면 신호를 보내고 실패해도 던지지 않는다', async () => {
  assert.equal(new Heartbeat({ url: '' }).start(), false);
  let n = 0;
  const hb = new Heartbeat({ url: 'https://hc-ping.com/abc', fetchImpl: async () => { n++; return { ok: true }; } });
  assert.equal(await hb.ping(), true);
  assert.ok(hb.lastOkAt);
  const bad = new Heartbeat({ url: 'https://hc-ping.com/abc', fetchImpl: async () => { throw new Error('down'); } });
  assert.equal(await bad.ping(), false);
  assert.equal(bad.lastError, 'down');
  assert.equal(n, 1);
});

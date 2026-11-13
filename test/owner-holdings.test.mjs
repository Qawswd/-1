import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const H = require('../server/owner-holdings.js');
const OS = require('../server/owner-signal.js');
const TC = require('../server/telegram-commands.js');

const withTmp = (fn) => async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holdings-'));
  H._setPath(path.join(dir, 'owner-holdings.json'));
  try {
    await fn(dir);
  } finally {
    H._setPath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('테스트 중 기본 경로는 읽지도 쓰지도 않는다', () => {
  H._setPath(null);
  assert.deepEqual(H.load(), { known: false, items: {}, updatedAt: null });
  H.bought('MSFT', { avg: 543.43 });
  assert.equal(fs.existsSync(H.FILE), false);
});

test('샀다 · 더 삼 · 팔았다 — 주식 손절선은 평균 × 0.75, 더 싸게 사서 평균이 내려가도 손절은 내리지 않는다', withTmp(() => {
  const now = Date.UTC(2026, 10, 11, 9);
  assert.equal(H.load().known, false);
  const a = H.bought('msft', { avg: 543.43, now });
  assert.equal(a.sym, 'MSFT');
  assert.ok(Math.abs(a.item.stop - 407.5725) < 1e-9);
  assert.equal(a.item.since, '2026-11-11');
  assert.match(H.boughtReply(a), /MSFT 들고 있음.*평균 \$543\.43 → 손절선 <b>\$407\.57<\/b>/);
  const b = H.bought('MSFT', { avg: 500, now: now + 86400000 });
  assert.ok(Math.abs(b.item.stop - 407.5725) < 1e-9, '500 × 0.75 = 375 로 내리지 않는다');
  assert.equal(b.item.since, '2026-11-11', '처음 산 날 그대로');
  const c = H.bought('MSFT', { avg: 600 });
  assert.equal(c.item.stop, 450, '평균이 올라가면 손절도 올라간다');
  assert.equal(H.bought('MSFT').item.avg, 600, '값 없이 보내면 평균 그대로');
  assert.match(H.listReply(), /MSFT · 2026-11-11부터 · 평균 \$600 · 손절 \$450/);
  const s = H.sold('MSFT');
  assert.equal(s.had, true);
  assert.equal(H.load().known, true);
  assert.deepEqual(H.load().items, {});
  assert.match(H.listReply(), /없음\(전부 현금\)/);
  assert.match(H.soldReply(H.sold('NVDA')), /적혀 있지 않았습니다/);
}));

test('코인은 원화 평균으로 업비트 손절 예약 값 · 주식에 원화를 보내면 되묻는다 · 이름 줄임', withTmp(() => {
  const r = H.bought('비트코인', { avg: 135000000 });
  assert.equal(r.sym, 'BTC');
  assert.match(H.boughtReply(r), /감시가 <b>121,500,000원<\/b> · 주문 가격 117,450,000원 · 수량 전부/);
  const bad = H.bought('MSFT', { avg: 736159 });
  assert.equal(bad.ok, false);
  assert.match(H.boughtReply(bad), /달러로 보내 주세요/);
  assert.equal(H.bought('', {}).ok, false);
  assert.equal(H.normSymbol('엔비디아'), 'NVDA');
  assert.equal(H.normSymbol('btcusdt'), 'BTC');
}));

const row = (name, c, f, s, stock = true) => ({ name, stock, j: { c, f, s, state: c > f && c > s ? 'long' : stock && c > s ? 'hold' : 'flat' } });

test('오늘 할 일: 들고 있는 것과 신호를 맞대어 종목마다 하나 — 팔기 먼저, 수익이면 (익절) · 손실이면 (손절)', () => {
  const rows = [
    row('BTC', 70000, 75000, 68000, false), // 50일선 아래 · 200일선 위
    row('ETH', 2500, 2400, 2300, false), // 두 선 위
    row('NVDA', 170, 190, 200), // 200일선 아래
    row('QQQ', 620, 600, 560), // 두 선 위
    row('MSFT', 545, 517, 439), // 두 선 위
  ];
  const holdings = { known: true, items: { MSFT: { avg: 543.43, stop: 407.57 }, BTC: { avg: 135000000, stop: 121500000 } } };
  const lines = OS.todoLines(rows, holdings);
  assert.match(lines[0], /오늘 17:30 할 일<\/b> — 팔기 1 · 사기 2 · 유지 1/);
  assert.match(lines[1], /🔔 <b>BTC 팔기<\/b> — 50일선 아래 마감 · 17:30 업비트 손절 예약을 먼저 취소하고 전부 팔기/);
  assert.ok(lines.some((l) => /🛒 <b>ETH 사기<\/b> — 두 선 위 · 17:30 업비트 한 칸\(순자산 × 20%\) · 바로 손절 예약\(감시가 산 값 × 0\.90 · 주문가 × 0\.87/.test(l)));
  assert.ok(lines.some((l) => /🛒 <b>QQQ 사기<\/b> — 두 선 위 · 17:30 토스 소수점 한 칸/.test(l)));
  assert.ok(lines.some((l) => /✋ <b>MSFT 유지<\/b> — 200일선 \+24\.15% · 손절선 407\.57 · 산 값 대비 \+0\.3%/.test(l)));
  assert.ok(lines.some((l) => /😴 NVDA 쉼 — 200일선 아래/.test(l)));
  // 주식: 200일선 아래 마감 → 팔기(손실이면 손절) · 손절선 아래 마감 → 팔기
  const sell = OS.actionFor(row('MSFT', 430, 500, 439), { avg: 543.43, stop: 407.57 });
  assert.equal(sell.kind, 'sell');
  assert.match(sell.text, /200일선 아래 마감.*산 값 대비 −20\.9%\(손절\)/);
  const win = OS.actionFor(row('NVDA', 300, 320, 310), { avg: 200, stop: 150 });
  assert.match(win.text, /200일선 아래 마감.*\+50\.0%\(익절\)/);
  const stopHit = OS.actionFor(row('QQQ', 400, 380, 390), { avg: 600, stop: 450 });
  assert.match(stopHit.text, /손절선 450\.00 아래 마감/);
  assert.match(OS.actionFor(row('SPY', 740, 760, 720), null).text, /😴 SPY 안 삼 — 50일선 아래/);
  // 아무것도 바뀔 게 없으면 '할 일 없음' · 신호에 없는 종목을 들고 있다고 적혀 있으면 알린다
  const calm = OS.todoLines([row('MSFT', 545, 517, 439)], { known: true, items: { MSFT: { avg: 543.43 } , SPY: { avg: 700 } } });
  assert.match(calm[0], /오늘 17:30 할 일 없음<\/b> — 유지 1 · 쉼 0/);
  assert.match(calm[calm.length - 1], /신호에 없는 종목을 들고 있다고 적혀 있음: SPY/);
  // 알려 준 적이 없으면 안내 한 줄
  assert.match(OS.todoLines(rows, { known: false, items: {} })[0], /\/샀다 MSFT 543\.43/);
});

test('신호 메시지 맨 위에 오늘 할 일이 붙는다', async () => {
  const now = Date.UTC(2026, 10, 20, 0, 10);
  const today = Math.floor(now / 86400000) * 86400000;
  const kl = Array.from({ length: 400 }, (_, i) => { const t = today - (400 - i) * 86400000; const c = 100 + i; return [t, c, c, c, String(c), 0, t + 86400000 - 1]; });
  const fetchImpl = async () => ({ ok: true, json: async () => kl });
  const r = await OS.currentMessage({ ownerSignal: { symbols: ['BTCUSDT'], ledger: false } }, { now, fetchImpl, holdings: { known: true, items: { BTC: { avg: 1 } } } });
  const lines = r.text.split('\n');
  assert.match(lines[2], /오늘 17:30 할 일 없음<\/b> — 유지 1/);
  assert.match(lines[3], /✋ <b>BTC 유지<\/b>/);
});

test('텔레그램 /샀다 · /팔았다 · /보유 — 오너 채팅방에서만', withTmp(async () => {
  const sent = [];
  const cfg = { telegram: { enabled: true, botToken: 'x', chatId: '777' } };
  const tc = new TC.TelegramCommander({ loadConfig: () => cfg, saveConfig: () => {}, notifyMod: { sendMessage: async (t) => sent.push(t) }, now: () => 1_000_000 });
  tc._startedAt = 1_000_000;
  const msg = (text, chat = 777) => ({ update_id: 1, message: { chat: { id: chat }, date: 1000, text } });
  await tc.handle(msg('/샀다 QQQ 612.30'));
  assert.match(sent[0], /QQQ 들고 있음.*손절선 <b>\$459\.22<\/b>/);
  await tc.handle(msg('/샀다 QQQ 612.30', 999));
  assert.equal(sent.length, 1, '다른 채팅방은 무시');
  await tc.handle(msg('/보유'));
  assert.match(sent[1], /QQQ · .*평균 \$612\.3/);
  await tc.handle(msg('/팔았다 QQQ'));
  assert.match(sent[2], /QQQ 판 것으로 적었습니다/);
  await tc.handle(msg('/도움'));
  assert.match(sent[3], /\/샀다 종목 평균가/);
  assert.equal(TC.parseHoldingCommand('BTC 샀다'), null, '일반 대화는 무시');
  assert.deepEqual(TC.parseHoldingCommand('/샀다 BTC 135,000,000'), { cmd: 'bought', sym: 'BTC', price: 135000000 });
}));

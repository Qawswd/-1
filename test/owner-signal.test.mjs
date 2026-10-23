import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const OS = require('../server/owner-signal.js');
const TC = require('../server/telegram-commands.js');

const DAY = 86400000;
const rising = (n, from = 100) => Array.from({ length: n }, (_, i) => from + i);

test('judge: 두 선 위 롱 · 50일선 하나라도 아래면 쉼(어제 상태도) · 하락 배열 아래면 숏 · 주식은 숏 없음', () => {
  const up = rising(250);
  const j = OS.judge(up);
  assert.equal(j.state, 'long');
  assert.equal(j.prevState, 'long');
  const sma50 = up.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const dip = OS.judge([...up, sma50 - 0.01]); // 50일선보다 아주 조금 아래(0.01) — 그래도 아래
  assert.equal(dip.state, 'flat');
  assert.equal(dip.prevState, 'long');
  const down = Array.from({ length: 250 }, (_, i) => 400 - i);
  assert.equal(OS.judge(down).state, 'short');
  assert.equal(OS.judge(down, { allowShort: false }).state, 'flat');
  assert.equal(OS.judge(rising(150)).state, null, '200일선을 낼 봉이 모자라면 판단하지 않는다');
});

test('메시지: 숫자·거리·할 일 · 바뀐 날 표시 · 롱이면 손절·익절 값', () => {
  const up = rising(250);
  const sma50 = up.slice(-50).reduce((a, b) => a + b, 0) / 50;
  const flat = OS.symbolLines('BTC', OS.judge([...up, sma50 - 0.01])).join('\n');
  assert.match(flat, /50일선 아래/);
  assert.match(flat, /어제 🟢 롱 → 바뀜/);
  assert.match(flat, /17:30 정리/);
  const edge = OS.symbolLines('BTC', { c: 81797.0, f: 81797.6, s: 72866.9, state: 'flat', prevState: 'long' }).join('\n');
  assert.match(edge, /종가 81,797\.0 · 50일선 81,797\.6 \(−0\.001%\)/, '선 바로 아래도 숫자로 갈린다(소수점 · 셋째 자리)');
  const long = OS.symbolLines('ETH', OS.judge(up)).join('\n');
  assert.match(long, /손절 −10% · 익절 \+30%/);
  assert.match(long, /오늘 종가로 치면 314\.10 · 453\.70/, '349 × 0.9 · × 1.3');
  const short = OS.symbolLines('ETH', OS.judge(Array.from({ length: 250 }, (_, i) => 400 - i))).join('\n');
  assert.match(short, /손절 \+4% · 익절 −8%/);
  const downCloses = Array.from({ length: 250 }, (_, i) => 400 - i);
  const off = OS.symbolLines('ETH', OS.judge(downCloses, { allowShort: false }), { noShort: true }).join('\n');
  assert.match(off, /두 선 아래\(숏 안 함\) — 롱 들고 있으면 17:30 정리/);
  assert.doesNotMatch(off, /숏\(손절/);
  assert.match(OS.symbolLines('NVDA', null, { stock: true })[0], /데이터 없음/);
  const msg = OS.buildMessage({ dateLabel: '10/24', rows: [{ name: 'BTC', j: OS.judge(up) }] });
  assert.match(msg, /10\/24 09:00 마감 일봉/);
  assert.match(msg, /한 칸 = 순자산 20%/);
});

test('마감된 봉만: 바이낸스 진행 중 봉 · Yahoo 장중 봉은 뺀다 · 설정은 BTC·ETH 와 주식 티커만', () => {
  const now = Date.UTC(2026, 9, 24, 0, 10);
  const k = [[now - 2 * DAY, 0, 0, 0, '10', 0, now - DAY - 1], [now - DAY, 0, 0, 0, '11', 0, now + DAY]];
  assert.deepEqual(OS.closedKlines(k, now).map((x) => x.c), [10]);
  const y = [{ t: now - 20 * 3600000, c: 1 }, { t: now - 3 * 3600000, c: 2 }];
  assert.deepEqual(OS.closedYahoo(y, now).map((x) => x.c), [1]);
  const p = OS.effectiveParams({ enabled: true, symbols: ['btcusdt', 'DOGEUSDT'], stocks: ['nvda', 'qqq', 'not a ticker!'] });
  assert.deepEqual(p.symbols, ['BTCUSDT']);
  assert.deepEqual(p.stocks, ['NVDA', 'QQQ']);
  assert.equal(OS.effectiveParams({}).enabled, false);
  assert.equal(OS.effectiveParams({}).shorts, true);
  assert.equal(OS.effectiveParams({ shorts: false }).shorts, false);
});

function fakeKlines(now, closes) {
  const today = Math.floor(now / DAY) * DAY;
  const rows = closes.map((c, i) => {
    const t = today - (closes.length - i) * DAY;
    return [t, c, c, c, String(c), 0, t + DAY - 1];
  });
  rows.push([today, 1, 1, 1, '1', 0, today + DAY - 1]); // 진행 중인 오늘 봉(값이 이상해도 무시돼야 함)
  return rows;
}

test('스케줄러: 09:05 전엔 안 보냄 · 하루 한 번 · 상태 저장 · /신호 는 언제든', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-signal-'));
  OS._setStatePath(path.join(dir, 'state.json'));
  try {
    const sent = [];
    const cfg = { ownerSignal: { enabled: true }, telegram: { enabled: true, botToken: 'x', chatId: '777' } };
    let now = Date.UTC(2026, 9, 24, 0, 1); // 한국 09:01
    const fetchImpl = async () => ({ ok: true, json: async () => fakeKlines(now, rising(250)) });
    const s = new OS.OwnerSignalScheduler({ loadConfig: () => cfg, notifyMod: { sendMessage: async (t) => (sent.push(t), { ok: true }) }, fetchImpl });
    assert.equal(await s._tick(now), null, '09:05 전');
    now = Date.UTC(2026, 9, 24, 0, 6);
    const r = await s._tick(now);
    assert.equal(r.ok, true);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /BTC<\/b> 종가 349\.00/);
    assert.match(sent[0], /🟢 롱/);
    assert.equal(OS.loadState().lastSent, '2026-10-24');
    assert.equal(await s._tick(now + 3600000), null, '같은 날 두 번 안 보냄');
    cfg.ownerSignal.enabled = false;
    assert.equal(await s._tick(Date.UTC(2026, 9, 25, 0, 6)), null, '꺼져 있으면 안 보냄');

    const replies = [];
    const tc = new TC.TelegramCommander({ loadConfig: () => cfg, saveConfig: () => {}, notifyMod: { sendMessage: async (t) => replies.push(t) }, fetchImpl, now: () => now });
    tc._startedAt = now;
    await tc.handle({ update_id: 1, message: { chat: { id: 777 }, date: Math.floor(now / 1000), text: '/신호' } });
    assert.match(replies[0], /대표님 규칙 신호<\/b> — 10\/24 09:00 마감/);
    now = Date.UTC(2026, 9, 24, 20, 0); // 한국 10/25 05:00 — 아직 10/24 09:00 봉이 마지막
    const early = await OS.currentMessage(cfg, { now, fetchImpl: async () => ({ ok: true, json: async () => fakeKlines(now, rising(250)) }) });
    assert.match(early.text, /10\/24 09:00 마감/);
  } finally {
    OS._setStatePath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('스케줄러: 거래소 일봉이 아직 어제 것이면 30분 뒤 다시', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-signal-'));
  OS._setStatePath(path.join(dir, 'state.json'));
  try {
    const sent = [];
    const now = Date.UTC(2026, 9, 24, 0, 6);
    const stale = fakeKlines(now - DAY, rising(250)).slice(0, -1); // 하루 늦은 봉들
    const s = new OS.OwnerSignalScheduler({ loadConfig: () => ({ ownerSignal: { enabled: true } }), notifyMod: { sendMessage: async (t) => (sent.push(t), { ok: true }) }, fetchImpl: async () => ({ ok: true, json: async () => stale }) });
    const r = await s._tick(now);
    assert.equal(r.retry, true);
    assert.equal(sent.length, 0);
    assert.equal(await s._tick(now + 10 * 60000), null, '30분 안엔 다시 안 함');
  } finally {
    OS._setStatePath(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

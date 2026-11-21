import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../server/owner-dca.js');
const OS = require('../server/owner-signal.js');
const DAY = 86400000;

const on = (o = {}) => D.effectiveDca({ enabled: true, since: '2026-11-21', ...o });
// 한국 날짜 d 일 09:10
const kstAt = (y, m, d) => Date.UTC(y, m, d) - 9 * 3600000 + (9 * 60 + 10) * 60000;
const bars = (closes, t0 = Date.UTC(2026, 10, 21, 14, 30)) => closes.map((c, i) => ({ t: t0 + i * DAY, o: c, h: c, l: c, c }));

test('effectiveDca: 기본 꺼짐 · 11일 · 25만 · 15만 더 · −40% · 이상한 값은 기본으로', () => {
  const d = D.effectiveDca({});
  assert.equal(d.enabled, false);
  assert.deepEqual([d.symbol, d.day, d.base, d.extra, d.ddPct, d.since], ['TQQQ', 11, 250000, 150000, 40, '2026-11-21']);
  const bad = D.effectiveDca({ enabled: true, day: 40, base: -1, ddPct: 200, since: 'x', symbol: 'tqqq!' });
  assert.deepEqual([bad.day, bad.base, bad.ddPct, bad.since, bad.symbol], [11, 250000, 40, '2026-11-21', 'TQQQ']);
  assert.equal(D.effectiveDca({ base: 450000 }).base, 450000);
});

test('산 뒤 최고가에서 −40% 아래면 그달 40만 · 시작 전 고점은 안 본다 · 사는 날(11일)만 "오늘" 줄', () => {
  const p = on();
  const old = [{ t: Date.UTC(2026, 9, 1), c: 200 }]; // 시작 전 고점 — 안 본다
  const up = [...old, ...bars([100, 110, 105])];
  const calm = D.plan(up, p, kstAt(2026, 11, 11));
  assert.equal(calm.deep, false);
  assert.ok(Math.abs(calm.d.dd - (1 - 105 / 110)) < 1e-12);
  assert.equal(calm.amount, 250000);
  const l1 = D.dcaLines(up, p, kstAt(2026, 11, 11));
  assert.match(l1[0], /🗓️ <b>오늘 TQQQ 적립<\/b> — 17:30 토스 TQQQ <b>25만 원<\/b> 소수점 예약.*산 뒤 최고가 \$110\.00 대비 −4\.5% · 팔지 않는다/);
  const crash = bars([100, 110, 60]); // −45.5%
  const l2 = D.dcaLines(crash, p, kstAt(2026, 11, 11));
  assert.match(l2[0], /<b>40만 원<\/b>\(−40% 아래 — 예비 저축에서 15만 원 더 · 예비가 없으면 25만 원\)/);
  const l3 = D.dcaLines(crash, p, kstAt(2026, 11, 12));
  assert.match(l3[0], /📈 TQQQ 적립: 다음 11일 40만 원\(−40% 아래\) · TQQQ 종가 \$60\.00/);
  assert.match(D.dcaLines(null, p, kstAt(2026, 11, 11))[0], /<b>25만 원<\/b>.*TQQQ 시세 없음/);
  assert.deepEqual(D.dcaLines(crash, D.effectiveDca({}), kstAt(2026, 11, 11)), [], '꺼져 있으면 아무 줄도 없다');
});

test('신호 메시지 맨 위(오늘 할 일보다 먼저)에 TQQQ 적립 줄', async () => {
  const now = kstAt(2026, 11, 11);
  const today = Math.floor(now / DAY) * DAY;
  const kl = Array.from({ length: 400 }, (_, i) => { const t = today - (400 - i) * DAY; const c = 100 + i; return [t, c, c, c, String(c), 0, t + DAY - 1]; });
  const fetchImpl = async () => ({ ok: true, json: async () => kl });
  const cfg = { ownerSignal: { symbols: ['BTCUSDT'], ledger: false, dca: { enabled: true } } };
  const r = await OS.currentMessage(cfg, { now, fetchImpl, holdings: { known: true, items: {} }, dcaBars: bars([100, 120, 90]) });
  const lines = r.text.split('\n');
  assert.match(lines[2], /🗓️ <b>오늘 TQQQ 적립<\/b>.*<b>25만 원<\/b>.*−25\.0%/);
  assert.ok(r.text.indexOf('TQQQ 적립') < r.text.indexOf('오늘 17:30 할 일'), '할 일 블록보다 위');
  const off = await OS.currentMessage({ ownerSignal: { symbols: ['BTCUSDT'], ledger: false } }, { now, fetchImpl, holdings: { known: true, items: {} } });
  assert.doesNotMatch(off.text, /TQQQ 적립/);
});

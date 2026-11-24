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
  assert.deepEqual([d.symbol, d.day, d.base, d.extra, d.ddPct, d.since], ['TQQQ', 11, 250000, 150000, 40, '2010-02-11'], '기본은 사상 최고가(상장일부터)');
  const bad = D.effectiveDca({ enabled: true, day: 40, base: -1, ddPct: 200, since: 'x', symbol: 'tqqq!' });
  assert.deepEqual([bad.day, bad.base, bad.ddPct, bad.since, bad.symbol], [11, 250000, 40, '2010-02-11', 'TQQQ']);
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
  assert.match(l1[0], /🗓️ <b>오늘 TQQQ 적립<\/b> — 18:00 ~ 21:00 토스 프리마켓에서 TQQQ <b>25만 원<\/b> 안에서 온주 · 지정가.*21:00 까지 안 사지면 그 주문 그대로 장 시작까지.*2026-11-21 뒤 최고가 \$110\.00 대비 −4\.5% · 팔지 않는다/);
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

test('계단식: −60% 아래면 여윳돈 최대 월급 한 달 치 더(기본 25만) · −40 ~ −60% 는 15만만', () => {
  const p = on();
  assert.deepEqual([p.deepPct, p.deepMax], [60, 250000]);
  const mid = D.plan(bars([100, 50]), p, kstAt(2026, 11, 11)); // −50%
  assert.deepEqual([mid.deep, mid.deeper, mid.amount, mid.upTo], [true, false, 400000, 400000]);
  const deep = D.plan(bars([100, 35]), p, kstAt(2026, 11, 11)); // −65%
  assert.deepEqual([deep.deep, deep.deeper, deep.amount, deep.upTo], [true, true, 400000, 650000]);
  const line = D.dcaLines(bars([100, 35]), p, kstAt(2026, 11, 11))[0];
  assert.match(line, /<b>40만 원<\/b>\(−40% 아래 — 예비 저축에서 15만 원 더 · 예비가 없으면 25만 원\) \+ 여윳돈이 있으면 최대 25만 원 더\(−60% 아래 · 빚 · 생활비 · 비상금 금지\)/);
  assert.match(D.dcaLines(bars([100, 35]), p, kstAt(2026, 11, 12))[0], /다음 11일 40만 원 \+ 여윳돈 최대 25만 원\(−60% 아래\)/);
  assert.doesNotMatch(D.dcaLines(bars([100, 50]), p, kstAt(2026, 11, 11))[0], /여윳돈/);
  assert.equal(D.effectiveDca({ deepMax: 450000 }).deepMax, 450000, '병장 땐 45만으로');
});

test('사상 최고가 기준(기본): 이미 빠진 시장에서 시작해도 이전 고점에서 잰다 — 대표님 2026-11-23', () => {
  const p = D.effectiveDca({ enabled: true });
  assert.equal(D.peakLabel(p), '사상 최고가');
  const history = [{ t: Date.UTC(2025, 1, 1, 14, 30), c: 100 }, ...bars([60, 55, 45])]; // 예전 고점 100 → 지금 45(−55%)
  const r = D.plan(history, p, kstAt(2026, 11, 11));
  assert.equal(r.d.hi, 100);
  assert.ok(Math.abs(r.d.dd - 0.55) < 1e-12);
  assert.deepEqual([r.deep, r.deeper, r.amount], [true, false, 400000], '−55%: 40만 · −60% 는 아직');
  assert.match(D.dcaLines(history, p, kstAt(2026, 11, 11))[0], /사상 최고가 \$100\.00 대비 −55\.0%/);
  // 예전 방식(산 뒤 최고가)이었다면 같은 날 −25% 로 기본만
  assert.equal(D.plan(history, on(), kstAt(2026, 11, 11)).deep, false);
});


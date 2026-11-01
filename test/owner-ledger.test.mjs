import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../server/owner-ledger.js');
const OS = require('../server/owner-signal.js');
const DAY = 86400000;

// 하루 한 봉(t, o=h=l=c 는 f(i))
const series = (n, f, t0 = Date.UTC(2025, 0, 1)) => Array.from({ length: n }, (_, i) => { const c = f(i); return { t: t0 + i * DAY, o: c, h: c, l: c, c }; });

test('시작한 날 전이면 D-n 한 줄만', () => {
  const from = Date.UTC(2026, 10, 11);
  const lines = L.ledgerLines([{ name: 'BTC', bars: series(300, (i) => 100 + i) }], { from, now: from - 3 * DAY + 1000 });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /가상 장부<\/b>는 11\/11부터 — D-3/);
});

test('오르는 코인: 시작한 날부터 플러스 · 들고 있음 · 시작 전부터 들고 있던 것 표시', () => {
  const bars = series(400, (i) => 100 * Math.pow(1.002, i));
  const from = bars[350].t;
  const lines = L.ledgerLines([{ name: 'BTC', bars }], { from, now: bars[399].t + DAY });
  assert.match(lines[0], /가상 장부<\/b> — \d{2}\/\d{2}부터 규칙대로 했다면\(칸 20% · 돈·주문 없음\)/);
  const pct = Number(lines[1].match(/지금 <b>([+−])([\d.]+)%/).slice(1).join('').replace('−', '-'));
  // 49일 동안 0.2%씩 · 칸 20% · 중간에 +30% 익절과 다시 사기가 섞일 수 있다
  assert.ok(pct > 1 && pct < 3, `칸 20% 만큼 — ${pct}`);
  assert.match(lines[2], /BTC 들고 있음\(/);
});

test('주식: 50일선만 깨지면 새 규칙은 들고 있고, 옛 규칙(선 하나)은 정리 — 두 숫자가 갈린다', () => {
  // 260일 오르다가 50일선 아래·200일선 위로 내려온 뒤 다시 오른다
  const f = (i) => (i < 260 ? 100 + i : i < 275 ? 359 - (i - 260) * 3 : 314 + (i - 275) * 4);
  const bars = series(330, f);
  const from = bars[250].t;
  const lines = L.ledgerLines([{ name: 'MSFT', stock: true, bars }], { from, now: bars[329].t + DAY });
  const m = lines[1].match(/지금 <b>([+−][\d.]+)%<\/b> · 옛 주식 규칙\(−10% · \+30% · 선 하나\)이었다면 ([+−][\d.]+)%/);
  assert.ok(m, lines[1]);
  const nums = [m[1], m[2]].map((x) => Number(x.replace('−', '-')));
  assert.ok(nums[0] > nums[1], `새 규칙(${nums[0]}) > 옛 규칙(${nums[1]}) — 눌림에서 안 털림`);
  assert.match(lines[2], /MSFT 들고 있음/);
});

test('데이터가 모자라거나 이상하면 그 종목만 빼고 적는다', () => {
  const good = series(300, (i) => 100 + i);
  const from = good[280].t;
  const lines = L.ledgerLines([{ name: 'BTC', bars: good }, { name: 'NVDA', stock: true, bars: series(50, (i) => 10 + i) }], { from, now: good[299].t + DAY });
  assert.match(lines[lines.length - 1], /데이터 부족: NVDA/);
  assert.match(L.ledgerLines([{ name: 'X', bars: null }], { from, now: from + DAY })[0], /데이터 없음\(X\)/);
});

test('신호 메시지 아래에 가상 장부가 붙고, 설정으로 시작한 날 · 끄기', async () => {
  const now = Date.UTC(2026, 10, 20, 0, 10);
  const today = Math.floor(now / DAY) * DAY;
  const kl = Array.from({ length: 400 }, (_, i) => { const t = today - (400 - i) * DAY; const c = 100 + i; return [t, c, c, c, String(c), 0, t + DAY - 1]; });
  const fetchImpl = async () => ({ ok: true, json: async () => kl });
  const r = await OS.currentMessage({ ownerSignal: { symbols: ['BTCUSDT'], ledgerFrom: '2026-11-11' } }, { now, fetchImpl });
  assert.match(r.text, /📒 <b>가상 장부<\/b> — 11\/11부터 규칙대로 했다면/);
  assert.match(r.text, /BTC 들고 있음/);
  assert.ok(r.text.indexOf('가상 장부') < r.text.indexOf('한 칸 = 순자산'), '맺음말 위에');
  const off = await OS.currentMessage({ ownerSignal: { symbols: ['BTCUSDT'], ledger: false } }, { now, fetchImpl });
  assert.doesNotMatch(off.text, /가상 장부/);
  assert.equal(OS.effectiveParams({ ledgerFrom: 'nope' }).ledgerFrom, '2026-11-11');
  assert.equal(OS.effectiveParams({ ledgerFrom: '2026-12-01' }).ledgerFrom, '2026-12-01');
});

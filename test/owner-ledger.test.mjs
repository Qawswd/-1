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

test('오르는 코인: 시작한 날부터 플러스 · 들고 있음', () => {
  const bars = series(400, (i) => 100 * Math.pow(1.002, i));
  const from = bars[350].t;
  const lines = L.ledgerLines([{ name: 'BTC', bars }], { from, now: bars[399].t + DAY });
  assert.match(lines[0], /가상 장부<\/b> — \d{2}\/\d{2}부터 규칙대로 했다면\(칸 20% · 돈·주문 없음\)/);
  const pct = Number(lines[1].match(/지금 <b>([+−])([\d.]+)%/).slice(1).join('').replace('−', '-'));
  // 49일 동안 0.2%씩 · 칸 20% · 코인은 익절 없이 들고 있다
  assert.ok(pct > 1 && pct < 3, `칸 20% 만큼 — ${pct}`);
  assert.match(lines[2], /BTC 들고 있음\(/);
});

test('주식: 50일선만 깨지면 새 규칙은 들고 있고, 옛 규칙(선 하나)은 정리 — 두 숫자가 갈린다', () => {
  // 260일 오르다가 50일선 아래·200일선 위로 내려온 뒤 다시 오른다
  const f = (i) => (i < 260 ? 100 + i : i < 275 ? 359 - (i - 260) * 3 : 314 + (i - 275) * 4);
  const bars = series(330, f);
  const from = bars[250].t;
  const lines = L.ledgerLines([{ name: 'MSFT', stock: true, bars }], { from, now: bars[329].t + DAY });
  const m = lines[1].match(/지금 <b>([+−][\d.]+)%<\/b> · 옛 규칙\(코인 \+30% 익절 · 주식 −10% · \+30% · 선 하나\)이었다면 ([+−][\d.]+)%/);
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

test('빈손으로 시작: 시작한 날 전에 산 것은 없고, 그때 유지만(50일선 아래 · 200일선 위)인 주식은 두 선 위로 돌아올 때 산다', () => {
  // 260일 오르다 50일선 아래로 눌렸다가(유지만) 다시 오른다 — 눌린 동안 시작
  const f = (i) => (i < 260 ? 100 + i : i < 275 ? 359 - (i - 260) * 3 : 314 + (i - 275) * 4);
  const bars = series(330, f);
  const from = bars[270].t; // 눌린 동안
  const lines = L.ledgerLines([{ name: 'MSFT', stock: true, bars }], { from, now: bars[329].t + DAY });
  const m = lines[2].match(/MSFT 들고 있음\((\d{2}\/\d{2}) 삼/);
  assert.ok(m, lines[2]);
  const bought = bars.find((b) => {
    const d = new Date(b.t + 9 * 3600000);
    return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}` === m[1];
  });
  assert.ok(bought && bought.t > from, '시작한 날 뒤에 두 선 위로 돌아와서 샀다');
  // 그 전 상승은 장부에 안 들어간다 — 시작한 날부터 산 날까지는 0%
  const none = L.ledgerLines([{ name: 'MSFT', stock: true, bars: bars.slice(0, 274) }], { from, now: bars[273].t + DAY });
  assert.match(none[1], /지금 <b>\+0\.0%<\/b>/);
  assert.match(none[2], /MSFT 쉼/);
});

test('주식 손절은 종가로: 들고 있으면 손절선(산 값 −25%) 가격을 적고, 그 아래로 마감하면 17:30 정리', () => {
  const bars = series(300, (i) => 100 + i);
  const from = bars[250].t;
  const held = L.ledgerLines([{ name: 'SPY', stock: true, bars }], { from, now: bars[299].t + DAY });
  const m = held[2].match(/SPY 들고 있음\(\d{2}\/\d{2} 삼 ([\d.]+) · [+−][\d.]+% · 손절선 ([\d.]+)\)/);
  assert.ok(m, held[2]);
  assert.ok(Math.abs(Number(m[2]) - Number(m[1]) * 0.75) < 0.01, '산 값 × 0.75');
  // 장중 꼬리가 아니라 종가가 손절선 아래 → 다음 장 시작에 정리(아직 들고 있음 + 표시)
  const crash = [...bars, { t: bars[299].t + DAY, o: 300, h: 300, l: 200, c: 200 }];
  const hit = L.ledgerLines([{ name: 'SPY', stock: true, bars: crash }], { from, now: crash[300].t + DAY });
  assert.match(hit[2], /SPY 들고 있음\(.* · 손절선 [\d.]+ 아래 마감 → 17:30 정리\)/);
  // 코인은 업비트에 손절·익절이 걸려 있어 손절선 표시가 없다
  const coin = L.ledgerLines([{ name: 'BTC', bars }], { from, now: bars[299].t + DAY });
  assert.doesNotMatch(coin[2], /손절선/);
});

test('코인은 익절 없음: +30% 넘게 올라도 들고 있고, 옛 규칙(+30% 익절)과 숫자가 갈린다', () => {
  const bars = series(400, (i) => 100 * Math.pow(1.004, i)); // 두 선 위로 꾸준히 — 99일에 약 +48%
  const from = bars[300].t;
  const lines = L.ledgerLines([{ name: 'BTC', bars }], { from, now: bars[399].t + DAY });
  const m = lines[1].match(/지금 <b>([+−][\d.]+)%<\/b> · 옛 규칙\(코인 \+30% 익절 · 주식 −10% · \+30% · 선 하나\)이었다면 ([+−][\d.]+)% · 정리된 거래 (\d+)번/);
  assert.ok(m, lines[1]);
  assert.equal(m[3], '0', '새 규칙은 정리한 거래가 없다(익절 없음)');
  assert.notEqual(m[1], m[2], '옛 규칙은 +30% 에서 팔고 다음 날 다시 사서 비용만큼 갈린다');
  assert.match(lines[2], /BTC 들고 있음\(\d{2}\/\d{2} 삼 [\d.]+ · \+4\d\.\d%\)/, '산 날부터 +40%대 그대로');
});

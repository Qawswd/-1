import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const R = require('../server/backtest/toss-rules.js');
const D = 86400000;

// 평일만 이어지는 일봉(가격은 f(i))
function bars(from, n, f) {
  const out = [];
  let t = Date.parse(from);
  while (out.length < n) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) { const c = f(out.length); out.push({ t, o: c, h: c, l: c, c, v: 1 }); }
    t += D;
  }
  return out;
}

test('signalDays: 월말 = 다음 봉이 다음 달인 봉(끝의 덜 끝난 달은 뺀다) · 15일 = 15일 이후 첫 거래일', () => {
  const b = bars('2024-01-01', 40, () => 100); // 1월 전체(평일 23) + 2월 23일까지
  const end = [...R.signalDays(b, 'end')].map((i) => new Date(b[i].t).toISOString().slice(0, 10));
  assert.deepEqual(end, ['2024-01-31']);
  const mid = [...R.signalDays(b, 'mid')].map((i) => new Date(b[i].t).toISOString().slice(0, 10));
  assert.deepEqual(mid, ['2024-01-15', '2024-02-15']);
  const wk = bars('2024-06-10', 20, () => 1); // 2024-06-15 은 토요일 → 17일(월)
  assert.deepEqual([...R.signalDays(wk, 'mid')].map((i) => new Date(wk[i].t).toISOString().slice(0, 10)), ['2024-06-17']);
});

test('simulateSwitch: 신호 다음 봉 시가에 들어가고 나간다 · 한쪽 비용 · 매매 수', () => {
  const b = [100, 100, 110, 121, 121, 100].map((c, i) => ({ t: i * D, o: i === 2 ? 105 : c, h: c, l: c, c, v: 1 }));
  b[4].o = 120;
  const want = (i) => (i === 1 ? true : i === 3 ? false : null);
  const r = R.simulateSwitch(b, want, { cost: 0.01 });
  // 2번 봉 시가 105 에 들어감: 110/105 − 1 − 0.01 · 3번 봉 121/110 − 1 · 4번 봉 시가 120 에 나감: 120/121 − 1 − 0.01 · 5번 봉 쉼
  const exp = [0, 110 / 105 - 1 - 0.01, 121 / 110 - 1, 120 / 121 - 1 - 0.01, 0];
  r.days.forEach((d, i) => assert.ok(Math.abs(d.ret - exp[i]) < 1e-12, `봉 ${i + 1}`));
  assert.equal(r.trades, 1);
  assert.equal(r.exposurePct, 40);
});

test('monthlySma · dailySma: 오르는 동안은 들고, 꺾여 평균 아래로 내려가면 현금', () => {
  const up = bars('2015-01-01', 600, (i) => 100 * Math.pow(1.001, i));
  assert.equal(R.monthlySma(up).trades, 1);
  assert.ok(R.monthlySma(up).days.slice(-50).every((d) => d.ret > 0));
  const upDown = bars('2015-01-01', 900, (i) => (i < 500 ? 100 + i : 600 - (i - 500) * 1.2));
  const m = R.monthlySma(upDown);
  assert.ok(m.days.slice(-60).every((d) => d.ret === 0), '내리막 끝에는 현금');
  const d2 = R.dailySma(upDown, { n: 200 });
  assert.ok(d2.days.slice(-60).every((d) => d.ret === 0));
  assert.equal(d2.trades, 1);
});

test('halfHalf: 반씩 넣고 따로 굴린다(다시 맞추지 않음)', () => {
  const a = [{ t: 1, ret: 1 }, { t: 2, ret: 0 }]; // 2배
  const b = [{ t: 1, ret: 0 }, { t: 2, ret: 0.5 }];
  const h = R.halfHalf(a, b, 0);
  assert.ok(Math.abs(h[0].ret - 0.5) < 1e-12); // 0.5→1 + 0.5 = 1.5
  assert.ok(Math.abs(h[1].ret - 0.25 / 1.5) < 1e-12); // 1 + 0.75 = 1.75
});

test('longestUnderwater: 고점에서 다시 고점까지 가장 긴 날, 회복 못 하면 끝날까지', () => {
  const xs = [{ t: 0, ret: 0.1 }, { t: 10 * D, ret: -0.1 }, { t: 20 * D, ret: 0.2 }, { t: 30 * D, ret: -0.5 }, { t: 45 * D, ret: 0.1 }];
  assert.equal(R.longestUnderwater(xs), 25); // 20일 고점 → 45일까지 회복 못 함
});

test('judge: 손실 2/3 · 칼마 · 연% −3%p 세 가지', () => {
  const base = { cagr: 10, dd: 60, calmar: 0.17 };
  assert.deepEqual(R.judge({ cagr: 9, dd: 30, calmar: 0.3 }, base), []);
  const w = R.judge({ cagr: 6, dd: 45, calmar: 0.13 }, base);
  assert.equal(w.length, 3);
  assert.deepEqual(R.judge(null, base), ['데이터 없음']);
});

test('main: 지수 넷이 있으면 표 · 판정 · 세후 줄, 없으면 받는 명령을 알려 준다(합성 데이터)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toss-'));
  try {
    const none = execFileSync(process.execPath, ['server/backtest/toss-rules.js', '--dir', dir], { encoding: 'utf8' });
    assert.match(none, /fetch-stocks\.js --from 1950/);
    const wave = (k) => (i) => 100 * Math.pow(1.0003, i) * (1 + 0.25 * Math.sin(i / (90 + k * 7)));
    [['_GSPC', 0], ['_IXIC', 1], ['SPY', 2], ['QQQ', 3]].forEach(([n, k]) => {
      const b = bars('1999-01-04', 6000, wave(k));
      fs.writeFileSync(path.join(dir, `${n}-1d.csv`), 't,o,h,l,c,v\n' + b.map((x) => `${x.t},${x.o},${x.h},${x.l},${x.c},1`).join('\n') + '\n');
    });
    const out = execFileSync(process.execPath, ['server/backtest/toss-rules.js', '--dir', dir], { encoding: 'utf8' });
    assert.match(out, /S&P500지수 — /);
    assert.match(out, /T1 월말 10개월선: 전체 -?[\d.]+% \/ −[\d.]+% /);
    assert.match(out, /T1 이웃.*12개월 15일/);
    assert.match(out, /판정[\s\S]*T4 반반\(T0\+T1\): (통과|탈락)/);
    assert.match(out, /→ 토스 규칙: /);
    assert.match(out, /세후 연%\(2007~, 참고\) QQQ: 시작 1000만 원 들고 있기 -?[\d.]+% · T1/);
    assert.doesNotMatch(out, /NaN|undefined/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

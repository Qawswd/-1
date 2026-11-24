import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const Q = require('../server/backtest/quarter-century.js');
const U = require('../server/backtest/stock-universe.js');
const D = 86400000;

test('quarter-century: 25년 · 2001~2010 · 2011~ 로 나누고, 데이터가 모자라면 받는 명령을 알려 준다(합성 데이터)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-'));
  try {
    const none = execFileSync(process.execPath, ['server/backtest/quarter-century.js', '--dir', dir], { encoding: 'utf8' });
    assert.match(none, /fetch-stocks\.js --from 1995 SPY QQQ MSFT NVDA/);
    const t0 = Date.parse('1999-01-04');
    const series = (seed, n) => {
      const r = U.rng(seed);
      let c = 50;
      return Array.from({ length: n }, (_, k) => { c *= 1 + (r() - 0.48) * 0.04; return `${t0 + k * D},${c},${c * 1.01},${c * 0.99},${c},1000`; });
    };
    ['SPY', 'QQQ', 'MSFT', 'NVDA'].forEach((s, i) => fs.writeFileSync(path.join(dir, `${s}-1d.csv`), 't,o,h,l,c,v\n' + series(20 + i, 10000).join('\n') + '\n'));
    const out = execFileSync(process.execPath, ['server/backtest/quarter-century.js', '--dir', dir], { encoding: 'utf8' });
    assert.match(out, /■ 지난 25년 — 2001-11-01 ~ /);
    assert.equal((out.match(/\[(SPY · QQQ · MSFT|SPY · MSFT · NVDA|NVDA · QQQ · MSFT)\]/g) || []).length, 3);
    assert.match(out, /25년 전체: 1년 평균 -?[\d.]+% · 1,000만 원 → [\d,]+만 · 최대 손실 −[\d.]+% · 최악의 해 -?[\d.]+% · 마이너스 해 \d+\/\d+/);
    assert.match(out, /2001~2010\(닷컴 붕괴 · 금융위기\): 1년 평균/);
    assert.match(out, /2011~: 1년 평균/);
    assert.match(out, /연도별 2001 -?[\d.]+% · 2002/);
    assert.match(out, /NVDA: 25년 규칙 -?[\d.]+% \/ −[\d.]+% · 들고 있기 -?[\d.]+% \/ −[\d.]+% \| ~2010 규칙/);
    assert.doesNotMatch(out, /NaN|undefined/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('comboStats: 코인 칸은 현금 — 주식이 0 이면 0%', () => {
  const days = Array.from({ length: 800 }, (_, k) => ({ t: Date.UTC(2001, 0, 1) + k * D, ret: 0, inMarket: false }));
  const s = Q.comboStats([{ days }, { days }, { days }], ['A', 'B', 'C'], Math.floor(Date.UTC(2001, 0, 1) / D), 800);
  assert.equal(s.cagr, 0);
  assert.equal(s.dd, 0);
  assert.deepEqual(Q.DEFAULT_COMBOS.map((c) => c.join(',')), ['SPY,QQQ,MSFT', 'SPY,MSFT,NVDA', 'NVDA,QQQ,MSFT']);
});

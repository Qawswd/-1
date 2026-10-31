import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const U = require('../server/backtest/stock-universe.js');

test('씨앗 고정 난수 · 서로 다른 k 개 고르기 · 분위수', () => {
  const a = U.rng(1);
  const b = U.rng(1);
  assert.equal(a(), b(), '같은 씨앗이면 같은 수열');
  const pick = U.pickK(10, 3, U.rng(5));
  assert.equal(new Set(pick).size, 3);
  assert.ok(pick.every((i) => i >= 0 && i < 10));
  assert.equal(U.quant([5, 1, 3, null, 2, 4], 0.5), 3);
  assert.equal(U.quant([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.1), 2);
  assert.equal(U.quant([], 0.5), null);
});

test('롱 보유 비용(연%)을 날마다 고르게 · 들고 있기 수익률은 첫날만 비용', () => {
  const D = 86400000;
  const bars = [{ t: 0, c: 100 }, { t: D, c: 110 }, { t: 2 * D, c: 99 }];
  const f = U.flatFunding(bars, 36.5);
  assert.ok(Math.abs(f.get(D) - 0.001) < 1e-12);
  assert.equal(U.flatFunding(bars, null).size, 0);
  const h = U.holdDays(bars, 0.001, f);
  assert.ok(Math.abs(h[0].ret - (0.1 - 0.001 - 0.001)) < 1e-12);
  assert.ok(Math.abs(h[1].ret - (-0.1 - 0.001)) < 1e-12);
});

test('종목 목록: meta.json 의 ok 만 · 2020 전부터 기록 있는 것만(짧은 것은 따로 센다)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'universe-'));
  try {
    fs.mkdirSync(path.join(dir, 'tradfi'));
    const csv = (from) => 't,o,h,l,c,v\n' + [0, 1, 2].map((k) => `${Date.parse(from) + k * 86400000},1,1,1,1,1`).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'tradfi', 'OLD-1d.csv'), csv('2016-01-04'));
    fs.writeFileSync(path.join(dir, 'tradfi', 'NEW-1d.csv'), csv('2023-01-03'));
    fs.writeFileSync(path.join(dir, 'tradfi', 'meta.json'), JSON.stringify({ symbols: [{ yahoo: 'OLD', ok: true, fundingAnnualPct: 5 }, { yahoo: 'NEW', ok: true }, { binance: 'XAU', ok: false }] }));
    const u = U.loadUniverse(dir);
    assert.deepEqual(u.stocks.map((s) => s.name), ['OLD']);
    assert.deepEqual(u.short, ['NEW']);
    assert.equal(U.loadUniverse(path.join(dir, 'none')).missing, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('afterTax: 해마다 250만 원 넘는 이익의 22% · 손실 해는 0 · 이월 없음', () => {
  const D = 86400000;
  const y = (s) => Date.parse(s);
  // 2021 +100%(1000만 → 2000만), 2022 −50%, 2023 +0
  const days = [{ t: y('2021-06-01'), ret: 1 }, { t: y('2022-06-01'), ret: -0.5 }, { t: y('2023-06-01'), ret: 0 }];
  const r = U.afterTax(days, 0, 1e7);
  // 2021 세금 (1000만 − 250만) × 22% = 165만 → 1835만, 2022 917.5만, 2023 그대로
  assert.equal(r.taxPaid, 1650000);
  assert.equal(r.endKrw, 9175000);
  const small = U.afterTax([{ t: y('2021-06-01'), ret: 0.2 }, { t: y('2022-06-01'), ret: 0 }], 0, 1e7);
  assert.equal(small.taxPaid, 0, '이익 200만 원은 공제 안');
  assert.equal(U.afterTax([], 0, 1e7), null);
  assert.ok(D > 0);
});

test('--five · --why · --toss · --stocks-only · --coins · --many · --plan: 주식 5종목 · 바이낸스 vs 토스 줄, 세후 연%, 차이 나누기가 나온다(합성 데이터)', async () => {
  const { execFileSync } = await import('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'universe5-'));
  try {
    const D = 86400000;
    const t0 = Date.parse('2019-01-01');
    const series = (seed) => {
      const r = U.rng(seed);
      let c = 100;
      return Array.from({ length: 2400 }, (_, k) => { // 2019-01 ~ 2025-07 — 2024~ 구간까지
        c *= 1 + (r() - 0.48) * 0.04;
        return `${t0 + k * D},${c},${c * 1.01},${c * 0.99},${c},1`;
      });
    };
    fs.mkdirSync(path.join(dir, 'tradfi'));
    const names = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'QQQ', 'SPY'];
    names.forEach((n, i) => fs.writeFileSync(path.join(dir, 'tradfi', `${n}-1d.csv`), 't,o,h,l,c,v\n' + series(i + 1).join('\n') + '\n'));
    fs.writeFileSync(path.join(dir, 'tradfi', 'meta.json'), JSON.stringify({ symbols: names.map((n) => ({ yahoo: n, ok: true, fundingAnnualPct: 8 })) }));
    for (const [sym, seed] of [['BTCUSDT', 11], ['ETHUSDT', 12]]) fs.writeFileSync(path.join(dir, `${sym}-1d.csv`), 't,o,h,l,c,v\n' + series(seed).join('\n') + '\n');
    const out = execFileSync(process.execPath, ['server/backtest/stock-universe.js', '--dir', dir, '--five', '--sets', '10'], { encoding: 'utf8' });
    assert.match(out, /\[2c\]/);
    assert.match(out, /바이낸스 · 주식 5종목만/);
    assert.match(out, /토스 · 주식 5종목만[\s\S]*세후\(해외주식 양도세\) 연%: 시작 500만 원/);
    assert.match(out, /토스 주식 3칸 \+ 업비트/);
    assert.doesNotMatch(out, /NaN|undefined/);
    assert.ok(!/\[1\] 종목마다/.test(out), '--five 면 다른 칸은 건너뛴다');
    const why = execFileSync(process.execPath, ['server/backtest/stock-universe.js', '--dir', dir, '--why', '--sets', '10'], { encoding: 'utf8' });
    assert.match(why, /\[2d\] 차이 나누기/);
    assert.match(why, /② ①에서 코인 숏만 뺌: 연 -?[\d.]+% \(앞 줄보다 [+-][\d.]+%p\)/);
    assert.match(why, /BTC 롱: 선물\(펀딩 냄\) 연 -?[\d.]+% · 현물 연/);
    assert.match(why, /주식 7종목 롱/);
    assert.doesNotMatch(why, /NaN|undefined/);
    const toss = execFileSync(process.execPath, ['server/backtest/stock-universe.js', '--dir', dir, '--toss', '--sets', '10'], { encoding: 'utf8' });
    assert.match(toss, /\[2e\] 토스로만/);
    assert.match(toss, /QQQ 사서 들고 있기\(100%\): 연 -?[\d.]+%/);
    assert.match(toss, /QQQ 50·200 규칙/);
    assert.match(toss, /칸 20%\(다 차면 100%\): 연 -?[\d.]+% \[/);
    assert.match(toss, /QQQ 들고 있기 50% \+ 주식 5종목/);
    assert.doesNotMatch(toss, /NaN|undefined|데이터 없음/);
    const so = execFileSync(process.execPath, ['server/backtest/stock-universe.js', '--dir', dir, '--stocks-only', '--sets', '10'], { encoding: 'utf8' });
    assert.match(so, /\[2f\] 개별 주식만[\s\S]*주식 5종목에서/);
    assert.match(so, /S2 칸 20% \+ QQQ 신호등으로 들어가기: 연 -?[\d.]+%/);
    assert.match(so, /판정 S3 .*: (통과|탈락)/);
    assert.match(so, /→ 토스 개별 주식 규칙: /);
    assert.doesNotMatch(so, /NaN|undefined/);
    const co = execFileSync(process.execPath, ['server/backtest/stock-universe.js', '--dir', dir, '--coins', '--sets', '10'], { encoding: 'utf8' });
    assert.match(co, /\[2g\] 코인만/);
    assert.match(co, /코인만 칸 25%\(합 50%\): 연 -?[\d.]+% · 최대 손실 −[\d.]+%/);
    assert.match(co, /토스 주식 3칸 \+ 업비트 코인 2칸\(칸 15%, \d+조합 중간값\): 연 -?[\d.]+%/);
    assert.doesNotMatch(co, /NaN|undefined|데이터 없음/);
    const many = execFileSync(process.execPath, ['server/backtest/stock-universe.js', '--dir', dir, '--many', '--sets', '10'], { encoding: 'utf8' });
    assert.match(many, /\[2h\] 종목 수만 바꾸기/);
    assert.match(many, /3종목\(칸 33\.3%\) 규칙: 연 -?[\d.]+% \[/);
    assert.match(many, /10종목: 종목 부족/);
    assert.match(many, /전 종목 5개 같은 몫 규칙: 연 -?[\d.]+%[\s\S]*연도별 2019/);
    assert.doesNotMatch(many, /NaN|undefined/);
    const plan = execFileSync(process.execPath, ['server/backtest/stock-universe.js', '--dir', dir, '--plan', '--sets', '10'], { encoding: 'utf8' });
    assert.match(plan, /\[2i\] 토스 계획 — 개별 주식 5종목에서 무작위 5종목/);
    assert.match(plan, /C30 SPY 규칙 30% \+ 주식 20종목 × 3\.5%: 연 -?[\d.]+% \[/);
    assert.match(plan, /목표 (안|밖)/);
    assert.match(plan, /→ 고른 계획: [ABCD]/);
    assert.match(plan, /종목 목록\(5,.*\): AAA BBB CCC DDD EEE/);
    assert.doesNotMatch(plan, /NaN|undefined/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

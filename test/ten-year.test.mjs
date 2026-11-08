import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const TY = require('../server/backtest/ten-year.js');
const FC = require('../server/backtest/fetch-coins-long.js');
const U = require('../server/backtest/stock-universe.js');
const D = 86400000;

test('fetch-coins-long: Coinbase [초, 저, 고, 시, 종, 량] · Bitfinex [ms, 시, 종, 고, 저, 량] 순서를 맞춰 읽는다', () => {
  const cb = FC.parseCoinbase([[1464825600, 13.1, 14.2, 13.5, 14.0, 100], ['bad']]);
  assert.deepEqual(cb, [{ t: 1464825600000, o: 13.5, h: 14.2, l: 13.1, c: 14.0, v: 100 }]);
  const bf = FC.parseBitfinex([[1457481600000, 9.5, 10.1, 10.4, 9.2, 50]]);
  assert.deepEqual(bf, [{ t: 1457481600000, o: 9.5, h: 10.4, l: 9.2, c: 10.1, v: 50 }]);
  assert.throws(() => FC.parseCoinbase({ message: 'NotFound' }), /목록이 아님/);
  assert.equal(FC.closedOnly([{ t: 0 }, { t: D }], D + 1000).length, 1, '안 끝난 오늘 봉은 버린다');
  assert.equal(FC.gaps([{ t: 0 }, { t: D }, { t: 4 * D }]), 2);
});

test('fetchCoinbase: 300일씩 나눠 묻고 이어 붙인다(최신 먼저인 응답도 날짜순으로)', async () => {
  const urls = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    const s = Date.parse(new URL(url).searchParams.get('start'));
    const e = Date.parse(new URL(url).searchParams.get('end'));
    const rows = [];
    for (let t = e; t >= s; t -= D) rows.push([t / 1000, 1, 2, 1.5, 1.8, 10]);
    return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
  };
  const from = Date.parse('2020-01-01T00:00:00Z');
  const rows = await FC.fetchCoinbase('ETH-USD', { from, to: from + 700 * D, fetchImpl, pause: 0 });
  assert.equal(urls.length, 3);
  assert.equal(rows.length, 701);
  assert.ok(rows.every((b, i) => i === 0 || b.t - rows[i - 1].t === D));
});

test('toGrid · yearRanges · equityStats: 날짜 칸 · 연도별 · 최대 손실 · 다시 고점까지', () => {
  const d0 = Math.floor(Date.parse('2020-12-30') / D);
  const g = TY.toGrid([{ t: (d0 + 1) * D + 14.5 * 3600000, ret: 0.1 }, { t: (d0 + 5) * D, ret: 0.5 }], d0, 4);
  [0, 0.1, 0, 0].forEach((v, i) => assert.ok(Math.abs(g[i] - v) < 1e-12, `칸 ${i}`));
  const yr = TY.yearRanges(d0, 4);
  assert.deepEqual(yr.map((y) => [y.y, y.s, y.e]), [[2020, 0, 1], [2021, 2, 3]]);
  const acc = Float64Array.from([0.1, -0.5, 0.2, 1]);
  const E2 = new Float64Array(5);
  const s = TY.equityStats(acc, E2, yr.map((y) => [y.s, y.e]));
  assert.ok(Math.abs(s.multiple - 1.1 * 0.5 * 1.2 * 2) < 1e-12);
  assert.ok(Math.abs(s.dd - 0.5) < 1e-12);
  assert.equal(s.under, 2, '1.1 고점 → 2일 뒤 1.32 로 회복');
  assert.ok(Math.abs(s.yearly[0] - (1.1 * 0.5 - 1)) < 1e-12);
  assert.equal(s.negYears, 1);
});

test('Hist: 1% 칸으로 분위수 · 마이너스 · −20% 이하 · 최저·최고와 그 표시', () => {
  const H = new TY.Hist(1000);
  [-30, -5, 0, 10, 20, 50].forEach((v, i) => H.add(v, i));
  assert.equal(H.n, 6);
  assert.equal(H.neg, 2);
  assert.equal(H.le20, 1);
  assert.deepEqual(H.min, { v: -30, tag: 0 });
  assert.deepEqual(H.max, { v: 50, tag: 5 });
  assert.equal(H.quantile(0.5), 0.5);
  assert.equal(TY.quantiles([3, 1, 2])[5], 2);
});

test('runAll: 주식 N 개 중 3개 모든 조합(C(N,3)) · 기간마다 시작한 날 전부', () => {
  const n = 800;
  const flat = new Float64Array(n);
  const up = new Float64Array(n).fill(0.001);
  const stockG = [up, flat, up, flat, up];
  const res = TY.runAll({ coinG: [flat, flat], stockG, names: ['A', 'B', 'C', 'D', 'E'], w: 0.2, d0: Math.floor(Date.parse('2020-01-01') / D), n });
  assert.equal(res.total, 10);
  assert.equal(res.hist[0].n, 10 * (n - 365 + 1));
  assert.equal(res.hist[2].n, 0, '5년보다 짧으면 0');
  assert.deepEqual(res.best[0].names, ['A', 'C', 'E']);
  assert.ok(res.worst[0].names.filter((x) => x === 'A' || x === 'C' || x === 'E').length === 1);
});

test('main: 합성 데이터로 끝까지 — 조합 수 · 해마다 · 기간별 줄', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenyear-'));
  try {
    const none = execFileSync(process.execPath, ['server/backtest/ten-year.js', '--dir', dir], { encoding: 'utf8' });
    assert.match(none, /fetch-coins-long\.js/);
    const t0 = Date.parse('2015-01-01');
    const series = (seed, n, step = 1) => {
      const r = U.rng(seed);
      let c = 100;
      return Array.from({ length: n }, (_, k) => { c *= 1 + (r() - 0.47) * 0.05; return `${t0 + k * step * D},${c},${c * 1.02},${c * 0.98},${c},1`; });
    };
    fs.mkdirSync(path.join(dir, 'long'));
    fs.writeFileSync(path.join(dir, 'long', 'BTC-USD-1d.csv'), 't,o,h,l,c,v\n' + series(1, 4300).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'long', 'ETH-USD-1d.csv'), 't,o,h,l,c,v\n' + series(2, 4300).join('\n') + '\n');
    fs.mkdirSync(path.join(dir, 'tradfi'));
    const names = ['AAA', 'BBB', 'CCC', 'DDD'];
    names.forEach((nm, i) => fs.writeFileSync(path.join(dir, 'tradfi', `${nm}-1d.csv`), 't,o,h,l,c,v\n' + series(10 + i, 4300).join('\n') + '\n'));
    fs.writeFileSync(path.join(dir, 'tradfi', 'meta.json'), JSON.stringify({ symbols: names.map((nm) => ({ yahoo: nm, ok: true })) }));
    const out = execFileSync(process.execPath, ['server/backtest/ten-year.js', '--dir', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.match(out, /주식 4개 중 3개/);
    assert.match(out, /■ 칸 20% — 주식 4개 중 3개 모든 조합 4가지/);
    assert.match(out, /■ 칸 15%/);
    assert.match(out, /1,000만 원 → 끝에\(만 원\): 최악 [\d,]+/);
    assert.match(out, /최대 손실 %\(고점 대비\): 최악 −[\d.]+/);
    assert.match(out, /2017: -?[\d.]+ ·/);
    assert.match(out, /5년 뒤\([\d,]+가지\): 최악 -?[\d.]+%/);
    assert.match(out, /가장 나빴던 경우: [A-D]{3}·[A-D]{3}·[A-D]{3} · \d{4}-\d{2}-\d{2} 시작/);
    assert.doesNotMatch(out, /NaN|undefined/);
    const cmp = execFileSync(process.execPath, ['server/backtest/ten-year.js', '--dir', dir, '--combo', 'AAA,BBB,CCC', 'AAA,BBB,ZZZ'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.match(cmp, /■ 조합 비교/);
    assert.match(cmp, /\[AAA · BBB · CCC\][\s\S]*코인과 함께: 1년 평균 -?[\d.]+% · 1,000만 원 → [\d,]+만 · 최대 손실 −[\d.]+%/);
    assert.match(cmp, /코인이 못 벌 때: 1년 평균/);
    assert.match(cmp, /3년 뒤 마이너스 [\d.]+% · 최악 -?[\d.]+%/);
    assert.match(cmp, /세 종목이 같이 움직이는 정도\(하루 수익 상관 평균, 1 = 똑같이\): -?[\d.]+/);
    assert.match(cmp, /AAA·BBB·ZZZ: 데이터 없음\(ZZZ\)/);
    assert.doesNotMatch(cmp, /NaN|undefined/);
    const sc = execFileSync(process.execPath, ['server/backtest/ten-year.js', '--dir', dir, '--combo', 'AAA,BBB,CCC', '--stop-close'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.match(sc, /— 손절 걸어 두기\(장중에 −25% 닿으면 그 값에\)[\s\S]*— 종가 손절\(−25% 아래로 마감하면 다음 날 장 시작에 시장가/);
    assert.equal((sc.match(/손절로 나간 거래: /g) || []).length, 2, '두 방식 모두 손절 거래를 적는다');
    assert.match(sc, / · 손절 \d+번 \(그냥 들고 있기/);
    assert.doesNotMatch(cmp, /손절로 나간 거래/, '--stop-close 없으면 지금 규칙 하나만');
    assert.doesNotMatch(sc, /NaN|undefined/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dollarVolume: 그 날 전 거래일만 · 평균 종가 × 거래량 · 기록이 모자라면 null', () => {
  const bars = Array.from({ length: 200 }, (_, k) => ({ t: k * D, c: 10 + k, v: 100 }));
  assert.equal(TY.dollarVolume(bars, 150 * D, 120), (100 * (30 + 149) / 2 + 100 * 10));
  assert.equal(TY.dollarVolume(bars, 30 * D, 120), null);
});

test('--big · --now: 거래대금 순위 · 상위 묶음과 전체 줄 · 판정 · 지금 순위(합성 데이터)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenyear-big-'));
  try {
    const t0 = Date.parse('2015-01-01');
    const series = (seed, n, vol) => {
      const r = U.rng(seed);
      let c = 100;
      return Array.from({ length: n }, (_, k) => { c *= 1 + (r() - 0.48) * 0.05; return `${t0 + k * D},${c},${c * 1.02},${c * 0.98},${c},${vol}`; });
    };
    fs.mkdirSync(path.join(dir, 'long'));
    fs.writeFileSync(path.join(dir, 'long', 'BTC-USD-1d.csv'), 't,o,h,l,c,v\n' + series(1, 4300, 1).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'long', 'ETH-USD-1d.csv'), 't,o,h,l,c,v\n' + series(2, 4300, 1).join('\n') + '\n');
    fs.mkdirSync(path.join(dir, 'tradfi'));
    const names = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'];
    names.forEach((nm, i) => fs.writeFileSync(path.join(dir, 'tradfi', `${nm}-1d.csv`), 't,o,h,l,c,v\n' + series(10 + i, 4300, 1000 * (i + 1)).join('\n') + '\n'));
    fs.writeFileSync(path.join(dir, 'tradfi', 'meta.json'), JSON.stringify({ symbols: names.map((nm) => ({ yahoo: nm, ok: true })) }));
    const out = execFileSync(process.execPath, ['server/backtest/ten-year.js', '--dir', dir, '--big'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.match(out, /순위: 1\.EEE 2\.DDD /, '거래량이 큰 순서(가격도 곱해서)');
    assert.match(out, /상위 20\(10가지\): 1년 평균 최악 -?[\d.]+%/);
    assert.match(out, /전체 5\(10가지\)/);
    assert.match(out, /판정\(docs\/07.*→ (채택|근거 부족)/);
    assert.doesNotMatch(out, /■ 칸 15%/, '--big 은 칸 20% 묶음 비교만');
    const nc = execFileSync(process.execPath, ['server/backtest/ten-year.js', '--dir', dir, '--big', '--no-coin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.match(nc, /코인 두 칸은 현금\(0%\)/);
    assert.match(nc, /상위 20\(10가지\): 1년 평균 최악 -?[\d.]+%/);
    assert.notEqual(nc.match(/전체 5\(10가지\): [^|]+/)[0], out.match(/전체 5\(10가지\): [^|]+/)[0], '코인을 빼면 숫자가 달라진다');
    const sr = execFileSync(process.execPath, ['server/backtest/ten-year.js', '--dir', dir, '--stock-rules'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.match(sr, /■ 주식 규칙만 바꾸기/);
    assert.match(sr, /S1 익절 없음\(−10% · 두 선\) · 코인이 못 벌 때\(10가지\): 1년 평균 최악 -?[\d.]+%/);
    assert.match(sr, /S2 200일선만.* · 코인과 함께\(10가지\)/);
    assert.match(sr, /코인이 못 벌 때 중간 연% 앞\(~2021\) -?[\d.]+% · 뒤\(2022~\) -?[\d.]+%/);
    assert.match(sr, /참고 H 그냥 들고 있기/);
    assert.match(sr, /판정 S2 .*: (통과|탈락)/);
    assert.match(sr, /→ 주식 칸 규칙: S[012]/);
    assert.doesNotMatch(sr, /NaN|undefined/);
    const sg = execFileSync(process.execPath, ['server/backtest/ten-year.js', '--dir', dir, '--stock-grid'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.match(sg, /■ 주식 규칙 격자 — 24개/);
    assert.match(sg, /★ 두 선 위→선 하나 아래 · 손절 −10% · 익절 \+30%: -?[\d.]+% \|/);
    assert.match(sg, /200일선 위→아래 · 손절 −25% · 익절 없음/);
    assert.match(sg, /→ 주식 칸 규칙: /);
    assert.equal((sg.match(/ · 손절 −/g) || []).length >= 24, true);
    assert.doesNotMatch(sg, /NaN|undefined/);
    const now = execFileSync(process.execPath, ['server/backtest/ten-year.js', '--dir', dir, '--now'], { encoding: 'utf8' });
    assert.match(now, /지금 거래대금 순위 — 바이낸스 상장 미국 주식·ETF 5개/);
    assert.match(now, / 1\. EEE /);
    assert.match(now, /하루 [\d,]+백만 달러/);
    assert.doesNotMatch(now, /NaN|undefined/);
    assert.doesNotMatch(out, /NaN|undefined/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('halvesMedian: 연도별 수익을 곱해 앞·뒤 기간 연% 중간값', () => {
  const d0 = Math.floor(Date.parse('2021-01-01') / D);
  const n = 730; // 2021 · 2022
  const res = { total: 1, years: [2021, 2022], yearly: [Float64Array.from([0.1]), Float64Array.from([-0.1])] };
  const [a, b] = TY.halvesMedian(res, d0, n, 2022);
  assert.ok(Math.abs(a - (Math.pow(1.1, 365.25 / 365) - 1)) < 1e-9);
  assert.ok(Math.abs(b - (Math.pow(0.9, 365.25 / 365) - 1)) < 1e-9);
});

test('gridVariants: 24개 · 익절 +30% 는 손절 크기와 상관없이 +30%(R 로 바꿔 넣음)', () => {
  const v = TY.gridVariants();
  assert.equal(v.length, 24);
  assert.equal(new Set(v.map((x) => x.key)).size, 24);
  const a = v.find((x) => x.key === '두 선 위→200일선 아래|15|30');
  assert.ok(Math.abs(a.o.tp * a.o.stop.v - 30) < 1e-9);
  assert.equal(a.o.exitOn, 'slow');
  const b = v.find((x) => x.key === '200일선 위→아래|25|0');
  assert.equal(b.o.fast, 200);
  assert.equal(b.o.tp, 0);
});

test('avgCorrelation: 똑같이 움직이면 1, 반대로 움직이면 −1', () => {
  const t0 = Date.UTC(2020, 0, 1);
  const a = Array.from({ length: 60 }, (_, i) => ({ t: t0 + i * D, c: 100 * (1 + 0.01 * Math.sin(i)) }));
  const b = a.map((x) => ({ t: x.t, c: x.c * 2 }));
  assert.ok(Math.abs(TY.avgCorrelation([a, b], t0) - 1) < 1e-9);
  const inv = a.map((x, i) => ({ t: x.t, c: 100 * (1 - 0.01 * Math.sin(i)) }));
  assert.ok(TY.avgCorrelation([a, inv], t0) < -0.9);
});

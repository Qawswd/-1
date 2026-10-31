'use strict';

// backtest/run.js — 감시기 트리거 규칙 백테스트 실행기 (Claude 호출 0, 네트워크 0).
//
//   node server/backtest/run.js                          # BTCUSDT·ETHUSDT × 전략 5종, 기본 파라미터
//   node server/backtest/run.js --symbol BTCUSDT --strategy reversal --move 1.5 --atr 1.5 --rr 1.8 --hold 48
//   node server/backtest/run.js --sweep                  # 파라미터 이웃 탐색(과최적화 방지용 — 이웃도 좋아야 믿는다)
//   node server/backtest/run.js --from 2024-01-01 --to 2026-12-31
//
// 입력: reports/backtest/data/<SYMBOL>-15m.csv  (fetch-data.js 가 만든 것)
// 출력: 콘솔 표 + reports/backtest/results/<UTC시각>-<이름>.json / .md

const fs = require('fs');
const path = require('path');
const E = require('./engine');

const DATA_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data');
const OUT_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'results');

function parseArgs(argv) {
  const a = { symbols: ['BTCUSDT', 'ETHUSDT'], strategies: [...E.STRATEGIES], params: {}, sweep: false, from: null, to: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    const num = () => {
      i += 1;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`${k} 값이 숫자가 아닙니다: ${v}`);
      return n;
    };
    if (k === '--symbol') { a.symbols = String(v).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean); i += 1; }
    else if (k === '--strategy') { a.strategies = String(v).split(',').map((s) => s.trim()).filter(Boolean); i += 1; }
    else if (k === '--move') a.params.movePct = num();
    else if (k === '--atr') a.params.stopAtrMult = num();
    else if (k === '--rr') a.params.rr = num();
    else if (k === '--hold') a.params.maxHoldBars = num();
    else if (k === '--cooldown') a.params.cooldownBars = num();
    else if (k === '--band') a.params.reversalBandPct = num();
    else if (k === '--fee') a.params.feePct = num();
    else if (k === '--from') { a.from = Date.parse(v); i += 1; }
    else if (k === '--to') { a.to = Date.parse(v); i += 1; }
    else if (k === '--sweep') a.sweep = true;
    else if (k === '--quiet') a.quiet = true;
    else if (k === '--help' || k === '-h') { a.help = true; }
    else throw new Error(`알 수 없는 인자: ${k}`);
  }
  for (const s of a.strategies) if (!E.STRATEGIES.includes(s)) throw new Error(`알 수 없는 전략: ${s} (가능: ${E.STRATEGIES.join(', ')})`);
  return a;
}

function loadBars(symbol, from, to) {
  const file = path.join(DATA_DIR, `${symbol}-15m.csv`);
  if (!fs.existsSync(file)) {
    throw new Error(`데이터 없음: ${file} — 먼저 node server/backtest/fetch-data.js 를 실행하세요`);
  }
  let bars = E.parseCandleCsv(fs.readFileSync(file, 'utf8'));
  if (Number.isFinite(from)) bars = bars.filter((b) => b.t >= from);
  if (Number.isFinite(to)) bars = bars.filter((b) => b.t <= to);
  return bars;
}

function fmt(v, dp = 2) {
  if (v == null || !Number.isFinite(v)) return '-';
  return v.toFixed(dp);
}

function pad(s, w, right = false) {
  s = String(s);
  return right ? s.padStart(w) : s.padEnd(w);
}

function tableLine(cols, widths, right) {
  return cols.map((c, i) => pad(c, widths[i], right ? right[i] : i > 0)).join('  ');
}

// 결과 한 줄 (심볼·전략 단위)
function row(label, res) {
  const s = res.summary;
  return [
    label,
    String(res.triggers),
    String(res.filtered),
    String(s.n),
    fmt(s.winRate, 1),
    fmt(s.profitFactor),
    fmt(s.expectancyPct, 3),
    fmt(s.avgR, 2),
    fmt(s.totalPct, 1),
    fmt(s.maxDrawdownPct, 1),
    fmt(s.equityMaxDrawdownPct, 1),
  ];
}

const HEAD = ['심볼·전략', '트리거', '탈락', '거래', '승률%', 'PF', '기대값%', '평균R', '누적%', '명목DD%', '계좌DD%'];
const WIDTHS = [22, 7, 6, 6, 6, 6, 8, 6, 8, 8, 8];

function renderTable(rows) {
  const lines = [tableLine(HEAD, WIDTHS), tableLine(WIDTHS.map((w) => '-'.repeat(w)), WIDTHS)];
  for (const r of rows) lines.push(tableLine(r, WIDTHS));
  return lines.join('\n');
}

function renderYearTable(byYear) {
  const years = Object.keys(byYear);
  const head = ['연도', '거래', '승률%', 'PF', '기대값%', '누적%', '계좌DD%'];
  const w = [6, 6, 6, 6, 8, 8, 8];
  const lines = [tableLine(head, w), tableLine(w.map((x) => '-'.repeat(x)), w)];
  for (const y of years) {
    const s = byYear[y];
    lines.push(tableLine([y, s.n, fmt(s.winRate, 1), fmt(s.profitFactor), fmt(s.expectancyPct, 3), fmt(s.totalPct, 1), fmt(s.equityMaxDrawdownPct, 1)], w));
  }
  return lines.join('\n');
}

function runOne(symbol, bars, strategy, params) {
  const r = E.runStrategy(bars, strategy, params);
  return {
    symbol,
    strategy,
    params: r.params,
    triggers: r.triggers,
    filtered: r.filtered,
    summary: E.summarize(r.trades),
    byYear: E.byYear(r.trades),
    bySide: E.bySide(r.trades),
    trades: r.trades,
  };
}

function verdict(s) {
  // 채택 기준(docs/00-CEO-PLAN.md): 표본 ≥ 30 · 기대값 > 0 · PF ≥ 1.3 · 계좌 기준 최대DD ≤ 15%
  // (계좌DD = 명목DD × 포지션 비중 20%. 낙폭은 계좌 관점으로 판정한다)
  if (!s || s.n < 30) return '표본 부족';
  const dd = Number.isFinite(s.equityMaxDrawdownPct) ? s.equityMaxDrawdownPct : s.maxDrawdownPct;
  const ok = s.expectancyPct > 0 && s.profitFactor >= 1.3 && dd <= 15;
  if (ok) return '✅ 기준 통과';
  if (s.expectancyPct > 0) return '△ 양(+)이지만 기준 미달';
  return '❌ 음(−)';
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 12).join('\n'));
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const results = [];
  const rows = [];

  for (const symbol of args.symbols) {
    const bars = loadBars(symbol, args.from, args.to);
    if (!args.quiet) {
      console.log(`\n== ${symbol}: 15분봉 ${bars.length.toLocaleString()}개 (${new Date(bars[0].t).toISOString().slice(0, 10)} ~ ${new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)}) ==`);
    }
    for (const strategy of args.strategies) {
      const res = runOne(symbol, bars, strategy, args.params);
      results.push(res);
      rows.push(row(`${symbol} ${strategy}`, res));
    }
  }

  const p = { ...E.DEFAULTS, ...args.params };
  console.log(`\n파라미터: 트리거 ${p.movePct}% / 쿨다운 ${p.cooldownBars}봉 / 손절 ATR×${p.stopAtrMult} / 손익비 ${p.rr} / 최대보유 ${p.maxHoldBars}봉 / 비용 왕복 ${2 * (p.feePct + p.slipPct)}%`);
  console.log(renderTable(rows));
  console.log('\n판정(표본≥30 · 기대값>0 · PF≥1.3 · 계좌DD≤15% — 포지션 비중 20% 기준):');
  for (const r of results) console.log(`  ${pad(`${r.symbol} ${r.strategy}`, 22)} ${verdict(r.summary)}`);

  let sweep = null;
  if (args.sweep) {
    console.log('\n== 파라미터 이웃 탐색 (과최적화 검사 — 이웃 대부분이 양(+)이어야 믿는다) ==');
    sweep = [];
    const grid = [];
    for (const movePct of [1.0, 1.5, 2.0]) for (const stopAtrMult of [1.0, 1.5, 2.0]) for (const rr of [1.5, 1.8, 2.5]) for (const maxHoldBars of [24, 48, 96]) grid.push({ movePct, stopAtrMult, rr, maxHoldBars });
    for (const symbol of args.symbols) {
      const bars = loadBars(symbol, args.from, args.to);
      for (const strategy of args.strategies) {
        let pos = 0;
        let tot = 0;
        let best = null;
        for (const g of grid) {
          const r = E.runStrategy(bars, strategy, { ...args.params, ...g });
          const s = E.summarize(r.trades);
          if (s.n < 30) continue;
          tot += 1;
          if (s.expectancyPct > 0) pos += 1;
          if (!best || s.expectancyPct > best.s.expectancyPct) best = { g, s };
          sweep.push({ symbol, strategy, ...g, n: s.n, winRate: s.winRate, pf: s.profitFactor, expectancyPct: s.expectancyPct, maxDd: s.maxDrawdownPct });
        }
        console.log(
          `  ${pad(`${symbol} ${strategy}`, 22)} 조합 ${tot}개 중 양(+) ${pos}개 (${tot ? Math.round((pos / tot) * 100) : 0}%)` +
            (best ? ` · 최고 기대값 ${fmt(best.s.expectancyPct, 3)}% @ move${best.g.movePct}/atr${best.g.stopAtrMult}/rr${best.g.rr}/hold${best.g.maxHoldBars} (n=${best.s.n}, PF ${fmt(best.s.profitFactor)})` : '')
        );
      }
    }
  }

  // 저장 — 거래 목록은 JSON 에만, 요약은 MD 에도
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const name = `${stamp}-${args.symbols.join('+')}-${args.strategies.length === E.STRATEGIES.length ? 'all' : args.strategies.join('+')}`;
  fs.writeFileSync(path.join(OUT_DIR, `${name}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), params: p, results, sweep }, null, 1));
  const md = [];
  md.push(`# 백테스트 ${stamp}`);
  md.push('');
  md.push(`파라미터: 트리거 ${p.movePct}% · 쿨다운 ${p.cooldownBars}봉 · 손절 ATR×${p.stopAtrMult} · 손익비 ${p.rr} · 최대보유 ${p.maxHoldBars}봉 · 비용 왕복 ${2 * (p.feePct + p.slipPct)}% · 펀딩비 미반영`);
  md.push('');
  md.push('```');
  md.push(renderTable(rows));
  md.push('```');
  for (const r of results) {
    md.push('');
    md.push(`## ${r.symbol} ${r.strategy} — ${verdict(r.summary)}`);
    md.push('');
    md.push('```');
    md.push(renderYearTable(r.byYear));
    md.push('```');
    md.push(`롱 ${r.bySide.LONG.n}건 기대값 ${fmt(r.bySide.LONG.expectancyPct, 3)}% · 숏 ${r.bySide.SHORT.n}건 기대값 ${fmt(r.bySide.SHORT.expectancyPct, 3)}% · 청산 사유 ${JSON.stringify(r.summary.reasons)}`);
  }
  md.push('');
  md.push('한계: 15분봉 종가 대비 종가 트리거(실전 1분 감시보다 적게 잡힘) · 펀딩비 미반영 · 과거는 미래를 보장하지 않음.');
  fs.writeFileSync(path.join(OUT_DIR, `${name}.md`), md.join('\n') + '\n');
  if (!args.quiet) console.log(`\n저장: reports/backtest/results/${name}.md / .json`);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('[backtest] 실패:', e && e.message ? e.message : e);
    process.exit(1);
  }
}

module.exports = { parseArgs, loadBars, runOne, verdict, renderTable };

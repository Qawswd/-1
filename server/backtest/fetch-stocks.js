'use strict';

// fetch-stocks.js — 바이낸스에 무기한 선물로 상장된 미국 주식의 긴 일봉 기록을 Yahoo 에서 받는다(읽기 전용, 키 불필요).
// 바이낸스 주식 선물은 상장 6~8개월뿐이라 원래 주식의 10~20년 기록으로 규칙을 먼저 검증한다(2026-10-13).
// 저장: reports/backtest/data/stocks/<SYMBOL>-1d.csv (t,o,h,l,c,v — 배당·분할 반영 가격)
//   node server/backtest/fetch-stocks.js
//   node server/backtest/fetch-stocks.js TSLA NVDA

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data', 'stocks');
// 2026-09-28 조사에서 바이낸스 TRADIFI_PERPETUAL 로 실제 거래 중이던 종목(docs/00-CEO-PLAN.md)
const DEFAULT_SYMBOLS = ['TSLA', 'NVDA', 'META', 'MSTR', 'COIN'];
const UA = 'Mozilla/5.0 (compatible; trading-floor-backtest)';

// Yahoo chart 응답 → [{t,o,h,l,c,v}] — adjclose 가 있으면 그 비율로 시가·고가·저가까지 맞춘다(배당 반영).
function parseYahooDaily(d) {
  const r = d && d.chart && d.chart.result && d.chart.result[0];
  if (!r) return [];
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const adj = r.indicators && r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose;
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close ? q.close[i] : null;
    if (c == null || !(c > 0)) continue;
    const f = adj && adj[i] > 0 ? adj[i] / c : 1;
    const pick = (arr) => (arr && arr[i] != null && arr[i] > 0 ? arr[i] : c);
    out.push({ t: ts[i] * 1000, o: pick(q.open) * f, h: pick(q.high) * f, l: pick(q.low) * f, c: c * f, v: (q.volume && q.volume[i]) || 0 });
  }
  out.sort((a, b) => a.t - b.t);
  return out.filter((b, i) => i === 0 || b.t !== out[i - 1].t);
}

function toCsv(rows) {
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  return 't,o,h,l,c,v\n' + rows.map((b) => `${b.t},${r6(b.o)},${r6(b.h)},${r6(b.l)},${r6(b.c)},${b.v}`).join('\n') + '\n';
}

async function main() {
  const args = process.argv.slice(2).map((s) => s.toUpperCase());
  const symbols = args.length ? args : DEFAULT_SYMBOLS;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const sym of symbols) {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=max&interval=1d&events=div,splits`;
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = parseYahooDaily(await res.json());
      if (!rows.length) throw new Error('일봉 없음');
      fs.writeFileSync(path.join(OUT_DIR, `${sym}-1d.csv`), toCsv(rows));
      console.log(`${sym}: ${rows.length}일 (${new Date(rows[0].t).toISOString().slice(0, 10)} ~ ${new Date(rows[rows.length - 1].t).toISOString().slice(0, 10)})`);
    } catch (e) {
      console.log(`${sym}: 실패 — ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

if (require.main === module) main();

module.exports = { parseYahooDaily, toCsv, DEFAULT_SYMBOLS, OUT_DIR };

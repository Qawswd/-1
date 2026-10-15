'use strict';

// fetch-stocks.js — 바이낸스에 무기한 선물로 상장된 미국 주식의 긴 일봉 기록을 Yahoo 에서 받는다(읽기 전용, 키 불필요).
// 바이낸스 주식 선물은 상장 6~8개월뿐이라 원래 주식의 10~20년 기록으로 규칙을 먼저 검증한다(2026-10-13).
// 저장: reports/backtest/data/stocks/<SYMBOL>-1d.csv (t,o,h,l,c,v — 배당·분할 반영 가격)
//   node server/backtest/fetch-stocks.js
//   node server/backtest/fetch-stocks.js TSLA NVDA
//   node server/backtest/fetch-stocks.js --from 1950 ^GSPC ^IXIC SPY QQQ   # 지수(S&P 500·나스닥)와 지수 ETF

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

// range=max 로 물으면 Yahoo 가 일봉 대신 월봉을 준다(2026-10-14 서버 실행: TSLA 16년이 197개). 5년씩 나눠 묻고,
// 이어 붙인 결과가 정말 일봉인지(이웃 봉 간격 중앙값 ≤ 4일) 확인한다.
function looksDaily(rows) {
  if (!Array.isArray(rows) || rows.length < 30) return false;
  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push(rows[i].t - rows[i - 1].t);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] <= 4 * 86400000;
}

function mergeRows(chunks) {
  const all = [].concat(...chunks).sort((a, b) => a.t - b.t);
  return all.filter((b, i) => i === 0 || b.t !== all[i - 1].t);
}

// 파일 이름 — Yahoo 지수 기호(^GSPC)의 ^ 는 파일 이름에서 _ 로 바꾼다
function fileKey(sym) {
  return String(sym).toUpperCase().replace(/\^/g, '_');
}
const LABELS = Object.freeze({ _GSPC: 'S&P500지수', _IXIC: '나스닥지수', SPY: 'S&P500(SPY)', QQQ: '나스닥100(QQQ)', 'GC=F': '금(GC=F)' });
function labelOf(key) {
  return LABELS[key] || key;
}

function toCsv(rows) {
  const r6 = (x) => Math.round(x * 1e6) / 1e6;
  return 't,o,h,l,c,v\n' + rows.map((b) => `${b.t},${r6(b.o)},${r6(b.h)},${r6(b.l)},${r6(b.c)},${b.v}`).join('\n') + '\n';
}

// Yahoo 일봉을 fromYear 부터 5년씩 나눠 받아 붙인다 — 일봉이 아니면 던진다
async function fetchYahooDaily(sym, fromYear = 1995) {
  const chunks = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const FIVE_Y = 5 * 365 * 86400;
  for (let from = Math.floor(Date.UTC(fromYear, 0, 1) / 1000); from < nowSec; from += FIVE_Y) {
    const to = Math.min(nowSec, from + FIVE_Y);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${from}&period2=${to}&interval=1d&events=div,splits`;
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (res.ok) chunks.push(parseYahooDaily(await res.json())); // 상장 전 구간은 비거나 오류 — 건너뛴다
    await new Promise((r) => setTimeout(r, 300));
  }
  const rows = mergeRows(chunks);
  if (!rows.length) throw new Error('일봉 없음');
  if (!looksDaily(rows)) throw new Error(`일봉이 아닌 응답(${rows.length}개) — 저장하지 않음`);
  return rows;
}

async function main() {
  const argv = process.argv.slice(2);
  const fi = argv.indexOf('--from');
  const fromYear = fi >= 0 ? Math.max(1900, Number(argv[fi + 1]) || 1995) : 1995;
  const args = argv.filter((a, i) => a !== '--from' && i !== fi + 1).map((s) => s.toUpperCase());
  const symbols = args.length ? args : DEFAULT_SYMBOLS;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const sym of symbols) {
    try {
      const rows = await fetchYahooDaily(sym, fromYear);
      fs.writeFileSync(path.join(OUT_DIR, `${fileKey(sym)}-1d.csv`), toCsv(rows));
      console.log(`${sym}: ${rows.length}일 (${new Date(rows[0].t).toISOString().slice(0, 10)} ~ ${new Date(rows[rows.length - 1].t).toISOString().slice(0, 10)})`);
    } catch (e) {
      console.log(`${sym}: 실패 — ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

if (require.main === module) main();

module.exports = { parseYahooDaily, fetchYahooDaily, toCsv, looksDaily, mergeRows, fileKey, labelOf, DEFAULT_SYMBOLS, OUT_DIR };

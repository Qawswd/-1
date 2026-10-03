'use strict';

// fetch-data.js — 과거 검증용 시장 데이터 받기. 바이낸스 USDT-M 선물 **실거래 시장**의 공개
// 데이터(테스트넷 아님, API 키 불필요, 읽기 전용)를 받는다. 주문·계정과 무관하다.
//
// 받는 것: BTCUSDT·ETHUSDT의 15분봉, 일봉, 펀딩비 기록 (기본 2020-01-01부터 지금까지)
// 저장: reports/backtest/data/<SYMBOL>-<15m|1d>.csv, <SYMBOL>-funding.csv
//
// 사용법: node server/backtest/fetch-data.js                (기본: 2020-01-01부터)
//         node server/backtest/fetch-data.js 2022-01-01     (시작일 지정)
//
// 과거 데이터는 미래를 보장하지 않는다. 이 데이터로 하는 검증은 "나쁜 규칙을 걸러내는"
// 용도이지, 좋은 결과가 실거래 수익을 증명하지 않는다.

const fs = require('fs');
const path = require('path');

const BASE = 'https://fapi.binance.com'; // 실거래 시장 공개 데이터(테스트넷 주소를 쓰지 않는다)
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const INTERVALS = { '15m': 15 * 60 * 1000, '1d': 24 * 60 * 60 * 1000 };
const OUT_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 순수 함수(테스트 대상) ------------------------------------------------------

// 바이낸스 kline 배열 한 줄 → 우리 형식. [openTime, open, high, low, close, volume, closeTime, ...]
function parseKlineRow(row) {
  if (!Array.isArray(row) || row.length < 7) return null;
  const k = {
    t: Number(row[0]),
    o: Number(row[1]),
    h: Number(row[2]),
    l: Number(row[3]),
    c: Number(row[4]),
    v: Number(row[5]),
    ct: Number(row[6]),
  };
  return Object.values(k).every(Number.isFinite) ? k : null;
}

// 봉 목록 점검: 정렬, 중복, 빠진 구간(봉 간격보다 벌어진 곳)을 찾는다.
function checkContinuity(candles, stepMs) {
  const out = { rows: candles.length, duplicates: 0, unsorted: 0, gaps: [], first: null, last: null };
  if (!candles.length) return out;
  out.first = candles[0].t;
  out.last = candles[candles.length - 1].t;
  for (let i = 1; i < candles.length; i++) {
    const d = candles[i].t - candles[i - 1].t;
    if (d === 0) out.duplicates += 1;
    else if (d < 0) out.unsorted += 1;
    else if (d > stepMs) out.gaps.push({ from: candles[i - 1].t, to: candles[i].t, missing: Math.round(d / stepMs) - 1 });
  }
  return out;
}

function toCsv(candles) {
  return 't,o,h,l,c,v\n' + candles.map((k) => `${k.t},${k.o},${k.h},${k.l},${k.c},${k.v}`).join('\n') + '\n';
}

// --- 네트워크 -------------------------------------------------------------------

async function getJson(url, attempt = 0) {
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    if (attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      return getJson(url, attempt + 1);
    }
    throw new Error(`네트워크 오류: ${e.message}`);
  }
  if (res.status === 429 || res.status === 418 || res.status >= 500) {
    if (attempt < 5) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt;
      console.log(`  (요청 제한/서버 오류 ${res.status}, ${Math.round(wait / 1000)}초 후 재시도)`);
      await sleep(wait);
      return getJson(url, attempt + 1);
    }
  }
  if (res.status === 451 || res.status === 403) {
    throw new Error(`접근 차단(${res.status}) — 이 서버 위치에서 바이낸스 선물 공개 데이터가 막혀 있을 수 있습니다`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function fetchKlines(symbol, interval, startMs) {
  const step = INTERVALS[interval];
  const all = [];
  let start = startMs;
  const now = Date.now();
  while (start < now) {
    const url = `${BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&startTime=${start}&limit=1500`;
    const rows = await getJson(url);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) {
      const k = parseKlineRow(r);
      // 아직 닫히지 않은 마지막 봉은 제외한다(미래 정보가 섞이지 않게)
      if (k && k.ct < now) all.push(k);
    }
    const lastOpen = Number(rows[rows.length - 1][0]);
    const next = lastOpen + step;
    if (next <= start) break;
    start = next;
    process.stdout.write(`\r  ${symbol} ${interval}: ${all.length}개 (${new Date(lastOpen).toISOString().slice(0, 10)}까지)   `);
    // 요청 간격 0.5초 — 봉 1,500개 요청은 가중치 10이라 분당 약 1,200(한도 2,400의 절반)으로
    // 여유를 둔다. 0.25초면 한도에 딱 걸리는 속도였다.
    await sleep(500);
  }
  process.stdout.write('\n');
  return all;
}

async function fetchFunding(symbol, startMs) {
  const all = [];
  let start = startMs;
  const now = Date.now();
  while (start < now) {
    const url = `${BASE}/fapi/v1/fundingRate?symbol=${symbol}&startTime=${start}&limit=1000`;
    const rows = await getJson(url);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) {
      const t = Number(r.fundingTime);
      const rate = Number(r.fundingRate);
      if (Number.isFinite(t) && Number.isFinite(rate)) all.push({ t, rate });
    }
    const last = Number(rows[rows.length - 1].fundingTime);
    if (!(last + 1 > start)) break;
    start = last + 1;
    await sleep(500);
  }
  return all;
}

async function main() {
  const arg = process.argv[2];
  const startMs = Date.parse(arg ? `${arg}T00:00:00Z` : '2020-01-01T00:00:00Z');
  if (!Number.isFinite(startMs)) {
    console.log('시작일 형식이 잘못됐습니다. 예: 2020-01-01');
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`바이낸스 실거래 시장 공개 데이터 받기 — ${new Date(startMs).toISOString().slice(0, 10)}부터\n`);
  const report = [];
  for (const symbol of SYMBOLS) {
    for (const interval of Object.keys(INTERVALS)) {
      const candles = await fetchKlines(symbol, interval, startMs);
      fs.writeFileSync(path.join(OUT_DIR, `${symbol}-${interval}.csv`), toCsv(candles), 'utf8');
      const chk = checkContinuity(candles, INTERVALS[interval]);
      report.push({ file: `${symbol}-${interval}.csv`, ...chk });
    }
    const funding = await fetchFunding(symbol, startMs);
    fs.writeFileSync(
      path.join(OUT_DIR, `${symbol}-funding.csv`),
      't,rate\n' + funding.map((f) => `${f.t},${f.rate}`).join('\n') + '\n',
      'utf8'
    );
    report.push({ file: `${symbol}-funding.csv`, rows: funding.length });
    console.log(`  ${symbol} 펀딩비: ${funding.length}건`);
  }
  console.log('\n=== 점검 결과 ===');
  for (const r of report) {
    const range = r.first ? `${new Date(r.first).toISOString().slice(0, 10)} ~ ${new Date(r.last).toISOString().slice(0, 10)}` : '';
    const issues = r.gaps
      ? `중복 ${r.duplicates} · 역순 ${r.unsorted} · 빠진 구간 ${r.gaps.length}곳(${r.gaps.reduce((s, g) => s + g.missing, 0)}봉)`
      : '';
    console.log(`${r.file}: ${r.rows}행 ${range} ${issues}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'fetch-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n저장 위치: ${OUT_DIR}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\n실패:', e.message);
    process.exit(1);
  });
}

module.exports = { parseKlineRow, checkContinuity, toCsv, BASE, SYMBOLS, INTERVALS };

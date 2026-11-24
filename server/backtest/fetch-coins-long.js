'use strict';

// fetch-coins-long.js — BTC·ETH 현물 USD 일봉을 2015년부터 받는다(2026-11-01, 오너 '최근 10년치 모든 경우의 수').
// 바이낸스 기록은 현물 2017-08~ · 선물 2019-09~ 라 10년 시험(200일선까지 2016 초부터 필요)에 모자란다.
//   1순위 Coinbase Exchange 공개 API(키 없음 · 한 번에 300개 · [시각(초), 저가, 고가, 시가, 종가, 거래량] 최신 먼저)
//   2순위 Bitfinex 공개 API(키 없음 · [시각(ms), 시가, 종가, 고가, 저가, 거래량]) — Coinbase 가 안 되거나 짧으면
// 하루 경계는 UTC 00:00 = 한국 09:00(지금 신호와 같다). 아직 안 끝난 오늘 봉은 버린다.
// 저장: reports/backtest/data/long/<BTC|ETH>-USD-1d.csv (t,o,h,l,c,v)
//   node server/backtest/fetch-coins-long.js --check   # 첫 응답 모양만 본다(새 소스 확인 — CLAUDE.md)
//   node server/backtest/fetch-coins-long.js

const fs = require('fs');
const path = require('path');
const FS = require('./fetch-stocks');

const DAY = 86400000;
const OUT_DIR = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data', 'long');
const FROM = Date.parse('2015-01-01T00:00:00Z');
const UA = 'Mozilla/5.0 (compatible; trading-floor-backtest)';
const COINS = Object.freeze({ BTC: { coinbase: 'BTC-USD', bitfinex: 'tBTCUSD' }, ETH: { coinbase: 'ETH-USD', bitfinex: 'tETHUSD' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const num6 = (r) => Array.isArray(r) && r.length >= 6 && r.slice(0, 6).every((x) => Number.isFinite(Number(x)));

function parseCoinbase(arr) {
  if (!Array.isArray(arr)) throw new Error(`Coinbase 응답이 목록이 아님: ${JSON.stringify(arr).slice(0, 200)}`);
  return arr.filter(num6).map((r) => ({ t: Number(r[0]) * 1000, o: Number(r[3]), h: Number(r[2]), l: Number(r[1]), c: Number(r[4]), v: Number(r[5]) })).filter((b) => b.c > 0);
}

function parseBitfinex(arr) {
  if (!Array.isArray(arr)) throw new Error(`Bitfinex 응답이 목록이 아님: ${JSON.stringify(arr).slice(0, 200)}`);
  return arr.filter(num6).map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[3]), l: Number(r[4]), c: Number(r[2]), v: Number(r[5]) })).filter((b) => b.c > 0);
}

async function getJson(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

// Coinbase: 300일씩 나눠 묻는다
async function fetchCoinbase(product, { from = FROM, to = Date.now(), fetchImpl = fetch, pause = 200 } = {}) {
  const chunks = [];
  for (let s = from; s < to; s += 300 * DAY) {
    const e = Math.min(to, s + 299 * DAY);
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`;
    chunks.push(parseCoinbase(await getJson(url, fetchImpl)));
    if (pause) await sleep(pause);
  }
  return FS.mergeRows(chunks);
}

// Bitfinex: 한 번에 10,000개까지
async function fetchBitfinex(sym, { from = FROM, to = Date.now(), fetchImpl = fetch } = {}) {
  const url = `https://api-pub.bitfinex.com/v2/candles/trade:1D:${sym}/hist?limit=10000&sort=1&start=${from}&end=${to}`;
  return FS.mergeRows([parseBitfinex(await getJson(url, fetchImpl))]);
}

// 아직 안 끝난 봉(오늘) 빼기 · 하루 경계 확인
function closedOnly(rows, now = Date.now()) {
  return rows.filter((b) => b.t + DAY <= now);
}

function gaps(rows) {
  let n = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i].t - rows[i - 1].t > DAY * 1.5) n += Math.round((rows[i].t - rows[i - 1].t) / DAY) - 1;
  return n;
}

async function fetchCoin(name, { fetchImpl = fetch, log = console.log, now = Date.now() } = {}) {
  const c = COINS[name];
  const tries = [];
  try {
    tries.push({ src: 'Coinbase', rows: closedOnly(await fetchCoinbase(c.coinbase, { fetchImpl, to: now }), now) });
  } catch (e) {
    log(`  ${name} Coinbase 실패: ${e.message}`);
  }
  // Coinbase 가 없거나 2016-03 보다 늦게 시작하면(ETH 는 2016-05~) Bitfinex 도 받아 더 긴 쪽을 쓴다
  if (!tries.length || !tries[0].rows.length || tries[0].rows[0].t > Date.parse('2016-03-01')) {
    try {
      tries.push({ src: 'Bitfinex', rows: closedOnly(await fetchBitfinex(c.bitfinex, { fetchImpl, to: now }), now) });
    } catch (e) {
      log(`  ${name} Bitfinex 실패: ${e.message}`);
    }
  }
  const ok = tries.filter((x) => x.rows.length && FS.looksDaily(x.rows)).sort((a, b) => a.rows[0].t - b.rows[0].t);
  return ok[0] || null;
}

async function check({ fetchImpl = fetch, log = console.log } = {}) {
  const s = Date.parse('2016-05-15T00:00:00Z');
  const e = Date.parse('2016-06-01T00:00:00Z');
  for (const [label, url, parse] of [
    ['Coinbase ETH-USD', `https://api.exchange.coinbase.com/products/ETH-USD/candles?granularity=86400&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`, parseCoinbase],
    ['Bitfinex tETHUSD', `https://api-pub.bitfinex.com/v2/candles/trade:1D:tETHUSD/hist?limit=3&sort=1&start=${Date.parse('2016-03-01')}`, parseBitfinex],
  ]) {
    try {
      const raw = await getJson(url, fetchImpl);
      const rows = parse(raw);
      log(`${label}: 날것 ${JSON.stringify(Array.isArray(raw) ? raw.slice(0, 2) : raw).slice(0, 200)}`);
      log(`  → 읽은 봉 ${rows.length}개 · 첫 봉 ${rows.length ? `${new Date(Math.min(...rows.map((b) => b.t))).toISOString().slice(0, 10)} 종가 ${rows.find((b) => b.t === Math.min(...rows.map((x) => x.t))).c}` : '없음'}`);
    } catch (err) {
      log(`${label}: 실패 — ${err.message}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--check')) return check();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const name of Object.keys(COINS)) {
    const got = await fetchCoin(name);
    if (!got) {
      console.log(`${name}: 받지 못함 — 위 실패 이유를 대표이사에게`);
      continue;
    }
    const r = got.rows;
    fs.writeFileSync(path.join(OUT_DIR, `${name}-USD-1d.csv`), FS.toCsv(r));
    console.log(`${name}: ${got.src} · ${r.length}일 · ${new Date(r[0].t).toISOString().slice(0, 10)} ~ ${new Date(r[r.length - 1].t).toISOString().slice(0, 10)} · 빠진 날 ${gaps(r)} · 마지막 종가 ${r[r.length - 1].c}`);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { parseCoinbase, parseBitfinex, fetchCoinbase, fetchBitfinex, fetchCoin, closedOnly, gaps, COINS, OUT_DIR };

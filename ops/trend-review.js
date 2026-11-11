#!/usr/bin/env node
'use strict';

// 추세추종 데모 점검(읽기 전용, 주문 없음) — 2026-11-11 '4주 점검'용. reports/trend-state.json 의 history 를 한국 날짜로 묶어
// 날마다 순자산 · 평균선 위 개수(k) · 낸 주문 · 그날 몇 번 돌았는지를 한 줄씩, 빠진 날과 'k 가 바뀌었는데 주문이 없던 날'을 따로 적는다.
// 오류 문장은 history 에 없어서 서버 로그(journalctl)에서 '[trend] … 오류' 줄을 센다(못 읽으면 그렇다고만).
//   node ops/trend-review.js            # 처음 기록부터
//   node ops/trend-review.js --since 2026-10-14

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DAY = 86400000;
const STATE = path.join(__dirname, '..', 'reports', 'trend-state.json');
const kstDate = (t) => new Date(t + 9 * 3600000).toISOString().slice(0, 10);
const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const won = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '-');
const short = (sym) => String(sym).replace(/USDT$/, '');

// state → { lines, days, missing, mismatches }
function review(state, { now = Date.now(), since = null } = {}) {
  const hist = (Array.isArray(state && state.history) ? state.history : [])
    .map((h) => ({ ...h, t: Date.parse(h.at) }))
    .filter((h) => Number.isFinite(h.t) && (!since || kstDate(h.t) >= since))
    .sort((a, b) => a.t - b.t);
  const lines = [];
  if (!hist.length) return { lines: ['추세추종 기록(history) 없음 — 꺼져 있었거나 reports/trend-state.json 이 없다'], days: [], missing: [], mismatches: [] };
  const byDay = new Map();
  for (const h of hist) {
    const d = kstDate(h.t);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(h);
  }
  const first = kstDate(hist[0].t);
  const today = kstDate(now);
  const missing = [];
  for (let t = Date.parse(`${first}T00:00:00Z`); kstDate(t) <= today; t += DAY) {
    const d = new Date(t).toISOString().slice(0, 10);
    // 오늘은 09:05 전이면 아직 안 돈 게 정상
    if (!byDay.has(d) && !(d === today && new Date(now + 9 * 3600000).getUTCHours() * 60 + new Date(now + 9 * 3600000).getUTCMinutes() < 9 * 60 + 35)) missing.push(d);
  }
  const days = [];
  const mismatches = [];
  let prevK = null;
  for (const [d, runs] of byDay) {
    const last = runs[runs.length - 1];
    const k = last.k && typeof last.k === 'object' ? last.k : {};
    const actions = runs.flatMap((r) => (Array.isArray(r.actions) ? r.actions : []));
    const acted = new Set(actions.map((a) => a.split(':')[0]));
    if (prevK) {
      for (const sym of Object.keys(k)) {
        if (prevK[sym] != null && k[sym] !== prevK[sym] && !acted.has(sym)) mismatches.push(`${md(d)} ${short(sym)} 평균선 위 ${prevK[sym]} → ${k[sym]} 인데 주문 없음(최소 주문 미만이거나 이미 맞았을 수 있다 — trend-status 로 확인)`);
      }
    }
    prevK = k;
    days.push({ d, runs: runs.length, equity: last.equity, k, actions });
    lines.push(`${md(d)} 순자산 ${won(last.equity)} · ${Object.entries(k).map(([s, v]) => `${short(s)} ${v}/5`).join(' ') || '-'} · 주문 ${actions.length ? actions.map((a) => a.replace('USDT', '')).join(' ') : '없음'}${runs.length > 1 ? ` · ${runs.length}번 돌림(다시 시도 있었음)` : ''}`);
  }
  const eq = days.map((x) => x.equity).filter(Number.isFinite);
  const head = [
    `추세추종 데모 점검 — ${md(first)} ~ ${md(days[days.length - 1].d)} · 돈 날 ${days.length}일 · 빠진 날 ${missing.length}일${missing.length ? `(${missing.map(md).join(' · ')})` : ''}`,
    `순자산 ${won(eq[0])} → ${won(eq[eq.length - 1])} USDT · 고점 ${won(state.peak)} · 정지 ${state.halted ? `됨(${state.halted.at || ''})` : '안 됨'} · 마지막 실행 ${state.lastRun ? `${state.lastRun.dateKey || ''} ${state.lastRun.ok === false ? '오류' : '정상'}` : '-'}`,
    `주문 낸 날 ${days.filter((x) => x.actions.length).length}일 · 다시 시도한 날 ${days.filter((x) => x.runs > 1).length}일 · 평균선 바뀌었는데 주문 없던 날 ${mismatches.length}번`,
  ];
  return { lines: [...head, '', ...lines, ...(mismatches.length ? ['', ...mismatches] : [])], days, missing, mismatches };
}

// 서버 로그에서 '[trend] … 오류' 줄(없으면 null — 로그를 못 읽음)
function trendErrors(sinceDate, run = spawnSync) {
  const r = run('journalctl', ['-u', 'trading-floor', '--since', sinceDate, '--no-pager', '-o', 'cat'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (!r || r.status !== 0 || typeof r.stdout !== 'string') return null;
  return r.stdout.split('\n').filter((l) => l.includes('[trend]') && l.includes('오류'));
}

function main() {
  const argv = process.argv.slice(2);
  const si = argv.indexOf('--since');
  const since = si >= 0 ? argv[si + 1] : null;
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch (e) {
    console.log(`reports/trend-state.json 을 못 읽음: ${e.message}`);
    return;
  }
  const r = review(state, { since });
  for (const l of r.lines) console.log(l);
  const from = since || (r.days[0] && r.days[0].d);
  if (from) {
    const errs = trendErrors(from);
    if (errs == null) console.log('\n서버 로그(journalctl)를 못 읽음 — 오류 횟수는 텔레그램 알림으로 확인');
    else console.log(`\n서버 로그 [trend] 오류 줄 ${errs.length}개${errs.length ? `\n${errs.slice(-5).map((l) => `  ${l.slice(0, 200)}`).join('\n')}` : ''}`);
  }
}

if (require.main === module) main();

module.exports = { review, trendErrors, kstDate };

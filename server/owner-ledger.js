'use strict';

// owner-ledger.js — 대표님 가상 장부(2026-11-01, 오너 "가상 장부 만들어줘"): 시작한 날(기본 2026-11-11)부터
// '규칙대로 했다면 지금 몇 %'를 실제 일봉으로 매일 다시 계산한다. 돈도 주문도 없다 — 매일 09:05 신호 아래에 붙는다.
// 규칙은 docs/08 그대로(칸 20% · 종목마다 한 칸):
//   코인(BTC·ETH) 두 선 위 → 다음 날 시가에 사기 · 손절 −10% · 익절 +30% · 선 하나라도 아래 마감 → 다음 날 시가 정리
//   주식(대표님 3개) 두 선 위 → 미국 장 시작에 사기 · 200일선 아래 마감 → 정리 · 손절 −25% · 익절 없음
//   비교: 옛 주식 규칙(코인과 같은 −10% · +30% · 선 하나)이었다면 — 미래 가격으로 새 규칙과 겨룬다(docs/07 '주식 규칙 격자')
// 상태 파일이 없다: 시작한 날 이전 기록으로 200일선을 만들고, 그날부터의 하루 수익만 더한다. 빈손으로 시작한다 — 시작한 날 전에
// 산 것은 없고(그때 '유지만'이던 주식도 안 들고 있다), 시작한 날 이후 '사는 조건' 신호로 산 것만 센다(2026-11-06 오너 '이번에 시작한 거').
// 한계: 코인은 09:00 시가(대표님은 17:30 — 1년 약 2.5%p 차이) · 같은 날 손절·익절 둘 다면 손절로 · 비용 한쪽 0.07% · 세금·환율 없음.

const X = require('./backtest/exits');

const DAY = 86400000;
const BASE = Object.freeze({ mode: 'long', trail: 'none', signalExit: true, holdDays: 0 });
const LEDGER_RULES = Object.freeze({
  coin: Object.freeze({ ...BASE, stop: { k: 'pct', v: 10 }, tp: 3 }),
  stockNew: Object.freeze({ ...BASE, stop: { k: 'pct', v: 25 }, tp: 0, exitOn: 'slow' }),
  stockOld: Object.freeze({ ...BASE, stop: { k: 'pct', v: 10 }, tp: 3 }),
});

const okBars = (bars) => (Array.isArray(bars) ? bars.filter((b) => [b.t, b.o, b.h, b.l, b.c].every(Number.isFinite) && b.o > 0 && b.c > 0) : []);
const sgn = (x) => (x == null || !Number.isFinite(x) ? '-' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(1)}`);
const mmdd = (t) => {
  const d = new Date(t + 9 * 3600000);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`;
};

// 하루 수익들 → 시작한 날부터 곱한 % (칸 w)
function growth(lists, w, from) {
  let eq = 1;
  for (const d of X.combine(lists, w)) if (d.t >= from) eq *= 1 + d.ret;
  return (eq - 1) * 100;
}

// 종목 하나 — 시작한 날부터 빈손으로 규칙대로(사는 봉이 시작한 날 이후인 것만) 돌린 결과와 지금 상태
function runAsset(name, bars, opts, from) {
  const run = X.simulateExits(bars, { ...opts, longGate: (sigT, fillT) => fillT >= from });
  const closed = run.trades.filter((t) => t.entryT >= from);
  let pos = null;
  if (run.open && run.open.dir > 0) {
    const eb = bars.find((b) => b.t === run.open.entryT);
    const last = bars[bars.length - 1];
    pos = { entryT: run.open.entryT, entry: eb ? eb.o : null, pnlPct: eb ? (last.c / eb.o - 1) * 100 : null };
  }
  return { name, days: run.days, closed, pos };
}

// rows = owner-signal collect 결과({ name, stock, bars }) → 가상 장부 줄(HTML)
function ledgerLines(rows, { from, now = Date.now(), slotPct = 20 } = {}) {
  if (!Number.isFinite(from)) return [];
  const label = mmdd(from);
  if (now < from) return [`📒 <b>가상 장부</b>는 ${label}부터 — D-${Math.ceil((from - now) / DAY)}(돈 없이 '규칙대로 했다면'을 매일 적는다)`];
  const w = slotPct / 100;
  const newRuns = [];
  const oldRuns = [];
  const missing = [];
  for (const r of rows || []) {
    const bars = okBars(r.bars);
    if (bars.length < 201) {
      missing.push(r.name);
      continue;
    }
    if (r.stock) {
      newRuns.push(runAsset(r.name, bars, LEDGER_RULES.stockNew, from));
      oldRuns.push(runAsset(r.name, bars, LEDGER_RULES.stockOld, from));
    } else {
      const c = runAsset(r.name, bars, LEDGER_RULES.coin, from);
      newRuns.push(c);
      oldRuns.push(c);
    }
  }
  if (!newRuns.length) return [`📒 <b>가상 장부</b> — 데이터 없음(${missing.join(' · ') || '종목 없음'})`];
  const nowPct = growth(newRuns.map((x) => x.days), w, from);
  const oldPct = growth(oldRuns.map((x) => x.days), w, from);
  const closed = newRuns.flatMap((x) => x.closed);
  const wins = closed.filter((t) => t.pct > 0).length;
  const status = newRuns.map((x) => {
    if (!x.pos) return `${x.name} 쉼`;
    const since = `${mmdd(x.pos.entryT)} 삼 ${x.pos.entry != null ? fmtPrice(x.pos.entry) : '-'}`;
    return `${x.name} 들고 있음(${since} · ${sgn(x.pos.pnlPct)}%)`;
  });
  const lines = [
    `📒 <b>가상 장부</b> — ${label}부터 규칙대로 했다면(칸 ${slotPct}% · 돈·주문 없음)`,
    `지금 <b>${sgn(nowPct)}%</b> · 옛 주식 규칙(−10% · +30% · 선 하나)이었다면 ${sgn(oldPct)}% · 정리된 거래 ${closed.length}번(이김 ${wins} · 짐 ${closed.length - wins})`,
    status.join(' · '),
  ];
  if (missing.length) lines.push(`(데이터 부족: ${missing.join(' · ')})`);
  return lines;
}

function fmtPrice(x) {
  if (x >= 1000) return x.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return x >= 1 ? x.toFixed(2) : Number(x.toPrecision(4)).toString();
}

module.exports = { LEDGER_RULES, ledgerLines, runAsset, growth };

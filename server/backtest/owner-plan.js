'use strict';

// owner-plan.js — 오너 직접 매매 계획의 손절·익절 폭 고르기(2026-10-23, 오너 "20%로 하고 숏을 할거면 익절·손절폭을 새로 정해야할거같아").
// 고정: 일봉 SMA 50·200 신호등 · 한국 17:30 실행(일봉 마감 8.5시간 뒤, 손절·익절 주문은 그동안에도 걸려 있음) · 칸 20% 1배(롱·숏 같은 크기)
//       BTC·ETH 한 칸씩 · 숏은 하락 배열(50일선 < 200일선)일 때만 · 종가가 선 하나라도 반대로 마감하면 정리 · 비용 한쪽 0.07% · 실제 펀딩.
// 바꾸는 것(결과 보기 전에 정함): 롱 손절 5·8·10·12% × 롱 익절 2R·3R·없음 / 숏 안 함 또는 숏 손절 5·8·10% × 숏 익절 2R·3R·없음.
// 고르는 법: 계좌 최대 손실 12% 이하(대결 종료 −15% 에서 주식 칸 몫을 남김) 가운데 2020~23 칼마가 가장 높은 것. 2024~ 는 확인만.
//   node server/backtest/owner-plan.js

const fs = require('fs');
const path = require('path');
const T = require('./trend');
const P = require('./pullback');

const DATA = path.join(__dirname, '..', '..', 'reports', 'backtest', 'data');
const IS_END = Date.parse('2024-01-01T00:00:00Z');
const DELAY = 8.5 * 3600000;
const SLOT = 0.2;
const MAX_DD = 12;
const LONG_STOPS = [5, 8, 10, 12];
const SHORT_STOPS = [5, 8, 10];
const TPS = [2, 3, 0];

// 칸별 하루 수익을 칸 크기만큼 더한 계좌
function account(parts) {
  const by = new Map();
  for (const [lists, w] of parts) for (const l of lists) for (const d of l.days) by.set(d.t, (by.get(d.t) || 0) + w * d.ret);
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([t, ret]) => ({ t, ret }));
}

// 대결 규칙(owner-record: 시작 금액 대비 −15% 면 끝, 90일)으로 본 위험 — 매일 새로 시작했다고 치고 90일씩
function contestWindows(days, from, { len = 90, loss = 15 } = {}) {
  const d = days.filter((x) => x.t >= from);
  const eq = [1];
  for (const x of d) eq.push(eq[eq.length - 1] * (1 + x.ret));
  const ends = [];
  let hit = 0;
  for (let i = 0; i + len < eq.length; i++) {
    let low = Infinity;
    for (let k = i + 1; k <= i + len; k++) low = Math.min(low, eq[k] / eq[i]);
    if (low <= 1 - loss / 100) hit++;
    ends.push((eq[i + len] / eq[i] - 1) * 100);
  }
  if (!ends.length) return null;
  ends.sort((a, b) => a - b);
  const r1 = (x) => Math.round(x * 10) / 10;
  return { n: ends.length, hitPct: r1((hit / ends.length) * 100), worst: r1(ends[0]), median: r1(ends[Math.floor(ends.length / 2)]), negPct: r1((ends.filter((x) => x < 0).length / ends.length) * 100) };
}

function main() {
  const assets = ['BTC', 'ETH'].filter((s) => fs.existsSync(path.join(DATA, `${s}USDT-15m.csv`))).map(P.loadCoin);
  if (!assets.length) return console.log('데이터 없음');
  const start = Math.max(...assets.map((a) => a.daily[Math.min(a.daily.length - 1, 200)].t));
  const sim = (o) => assets.map((a) => P.simulatePullback(a.m15, a.daily, { entry: 'daily', stop: 'fixed', execDelay: DELAY, funding: a.funding, ...o }));
  const tpLabel = (x) => (x ? `${x}R` : '없음');
  const longs = [];
  for (const stopPct of LONG_STOPS) for (const tp of TPS) longs.push({ stopPct, tp, per: sim({ stopPct, tp }) });
  const shorts = [{ none: true, per: [] }];
  for (const stopPct of SHORT_STOPS) for (const tp of TPS) shorts.push({ stopPct, tp, per: sim({ stopPct, tp, shortOnly: true }) });
  const r2 = (x) => Math.round(x * 100) / 100;
  const rows = [];
  for (const L of longs) for (const S of shorts) {
    const days = account([[L.per, SLOT], [S.per, SLOT]]);
    const all = T.summarizeTrend(days, { from: start });
    const is = T.summarizeTrend(days, { from: start, to: IS_END - 1 });
    const oos = T.summarizeTrend(days, { from: IS_END });
    const sTr = S.per.flatMap((p) => p.trades.filter((t) => t.entryT >= start));
    rows.push({
      name: `롱 손절 ${L.stopPct}% 익절 ${tpLabel(L.tp)}(${L.tp ? `+${L.stopPct * L.tp}%` : '-'}) · ${S.none ? '숏 안 함' : `숏 손절 ${S.stopPct}% 익절 ${tpLabel(S.tp)}(${S.tp ? `−${S.stopPct * S.tp}%` : '-'})`}`,
      all, is, oos, cal: (s) => (s && s.maxDrawdownPct > 0 ? r2(s.cagrPct / s.maxDrawdownPct) : null),
      shortN: sTr.length, shortSum: r2(sTr.reduce((x, t) => x + t.pct, 0)),
    });
  }
  const line = (r) => `  ${r.name}\n     전체 ${r.all.cagrPct}% / −${r.all.maxDrawdownPct}% · 최악의 달 ${r.all.worstMonthPct}% | 2020~23 칼마 ${r.cal(r.is)} | 2024~ ${r.oos.cagrPct}% / −${r.oos.maxDrawdownPct}% (칼마 ${r.cal(r.oos)})${r.shortN ? ` | 숏 ${r.shortN}번 합계 ${r.shortSum}%` : ''}`;
  console.log(`오너 계획: 일봉 SMA 50·200 · 한국 17:30 실행 · 칸 ${SLOT * 100}% · BTC·ETH · ${new Date(start).toISOString().slice(0, 10)}부터 · 조합 ${rows.length}개`);
  const ok = rows.filter((r) => r.all.maxDrawdownPct <= MAX_DD).sort((a, b) => (r2(b.is.cagrPct / b.is.maxDrawdownPct)) - (r2(a.is.cagrPct / a.is.maxDrawdownPct)));
  console.log(`\n[1] 계좌 최대 손실 ${MAX_DD}% 이하 ${ok.length}개 중 2020~23 칼마 상위 10`);
  for (const r of ok.slice(0, 10)) console.log(line(r));
  console.log('\n[2] 숏을 붙였을 때 최대 손실이 가장 작은 10개(숏 있는 것만)');
  for (const r of rows.filter((x) => x.shortN).sort((a, b) => a.all.maxDrawdownPct - b.all.maxDrawdownPct).slice(0, 10)) console.log(line(r));
  console.log('\n[3] 지금 규칙(롱 손절 10% 익절 3R)에 숏 붙이기');
  for (const r of rows.filter((x) => x.name.startsWith('롱 손절 10% 익절 3R'))) console.log(line(r));
  // 4) 대결 90일 창 — 지금 롱 규칙에 숏 칸 크기·폭을 바꿔서
  console.log('\n[4] 대결 규칙으로 본 위험 — 아무 날이나 시작해 90일: −15% 찍고 끝난 비율 · 90일 뒤 수익 최악/중간 · 90일 뒤 마이너스 비율');
  const L10 = longs.find((x) => x.stopPct === 10 && x.tp === 3);
  const pick = (stopPct, tp) => shorts.find((x) => x.stopPct === stopPct && x.tp === tp);
  const plans = [
    ['롱 20% · 숏 안 함', [[L10.per, SLOT]]],
    ['롱 20% · 숏 5% (손절 10% 익절 3R)', [[L10.per, SLOT], [pick(10, 3).per, 0.05]]],
    ['롱 20% · 숏 10% (손절 10% 익절 3R)', [[L10.per, SLOT], [pick(10, 3).per, 0.1]]],
    ['롱 20% · 숏 20% (손절 10% 익절 3R)', [[L10.per, SLOT], [pick(10, 3).per, SLOT]]],
    ['롱 20% · 숏 20% (손절 5% 익절 2R)', [[L10.per, SLOT], [pick(5, 2).per, SLOT]]],
    ['롱 20% · 숏 20% (손절 5% 익절 3R)', [[L10.per, SLOT], [pick(5, 3).per, SLOT]]],
  ];
  for (const [name, parts] of plans) {
    const w = contestWindows(account(parts), start);
    if (w) console.log(`  ${name}: −15% 로 끝 ${w.hitPct}% · 90일 뒤 최악 ${w.worst}% · 중간 ${w.median}% · 마이너스 ${w.negPct}% (시작일 ${w.n}개)`);
  }
}

if (require.main === module) main();

module.exports = { account, contestWindows };

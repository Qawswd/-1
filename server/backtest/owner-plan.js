'use strict';

// owner-plan.js — 오너 직접 매매 계획의 손절·익절 폭 고르기(2026-10-23, 오너 "20%로 하고 숏을 할거면 익절·손절폭을 새로 정해야할거같아").
// 고정: 일봉 SMA 50·200 신호등 · 한국 17:30 실행(일봉 마감 8.5시간 뒤, 손절·익절 주문은 그동안에도 걸려 있음) · 칸 20% 1배(롱·숏 같은 크기)
//       BTC·ETH 한 칸씩 · 숏은 하락 배열(50일선 < 200일선)일 때만 · 종가가 선 하나라도 반대로 마감하면 정리 · 비용 한쪽 0.07% · 실제 펀딩.
// 바꾸는 것(결과 보기 전에 정함): 롱 손절 5·8·10·12% × 롱 익절 2R·3R·없음 / 숏 안 함 또는 숏 손절 5·8·10% × 숏 익절 2R·3R·없음.
// 고르는 법: 계좌 최대 손실 12% 이하(대결 종료 −15% 에서 주식 칸 몫을 남김) 가운데 2020~23 칼마가 가장 높은 것. 2024~ 는 확인만.
// [5] 숏 폭을 롱 때와 같은 방식으로(2026-10-23, 오너 "롱은 10%·30%, 숏은 새로 — 분석은 똑같이"): 롱은 손절 10%·익절 3R 고정.
//   숏 조건 하락 배열일 때만 / 두 선 아래면 × 손절 3·4·5·6·8·10% × 익절 1·1.5·2·3R·없음. 숏 칸만의 칼마(만들기/시험)와 이웃,
//   롱 20% + 숏 20% 계좌의 최대 손실·대결 90일 창. 고르는 법: 숏 칸 만들기(2020~23) 칼마 + 이웃이 고른지 → 시험은 확인만.
//   node server/backtest/owner-plan.js            # [1]~[4]
//   node server/backtest/owner-plan.js --short    # [5]
// [6] 숏 다시(2026-10-23, 오너 "숏은 다시 분석해서 최적의 방안") — [5] 의 숏 4%·8% 가 17:30 에서만 플러스인 '시각 운'이었다(09:00 연 −4.7%).
//   결과 보기 전에 정한 것: 숏 조건 S0 두 선 아래 / S1 + 하락 배열(50<200) / S2 S1 + 200일선이 20일 전보다 낮음 / S3 S1 + 20일 신저가 마감 / S4 S2+S3
//   × 손절 4·6·8·10·15% × 익절 2R·3R·없음 × 실행 시각 09:00·13:00·17:30·21:00(4개 다). 정리는 종가가 선 하나라도 위(또는 하락 배열 풀림).
//   통과: 네 시각 모두에서 2020~23 과 2024~ 둘 다 숏 칸 연수익 > 0 (8개 다 플러스). 통과한 것 중 네 시각 칼마 최솟값이 큰 순.
//   통과가 없으면 '숏 안 함'이 최적이다.
//   node server/backtest/owner-plan.js --robust-short    # [6]

const fs = require('fs');
const path = require('path');
const T = require('./trend');
const P = require('./pullback');
const { contestWindows } = require('./exits');

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

function shortGrid(assets, start, longPer) {
  const STOPS = [3, 4, 5, 6, 8, 10];
  const TPS5 = [1, 1.5, 2, 3, 0];
  const r2 = (x) => Math.round(x * 100) / 100;
  const cal = (days, from, to = Infinity) => {
    const s = T.summarizeTrend(days, { from, to });
    return s && s.maxDrawdownPct > 0 ? r2(s.cagrPct / s.maxDrawdownPct) : null;
  };
  for (const confirm of [true, false]) {
    console.log(`\n[5] 숏 칸만 — ${confirm ? '하락 배열(50일선 < 200일선)일 때만' : '두 선 아래면 바로'} · 칸 = 숏 칸 칼마 전체/만들기/시험 · 승률 · 거래 · 계좌(롱 20% + 숏 20%) 최대 손실 · 대결 90일 최악`);
    console.log(`손절\\익절 ${TPS5.map((t) => (t ? `${t}R` : '없음').padStart(36)).join('')}`);
    for (const stopPct of STOPS) {
      const cells = TPS5.map((tp) => {
        const per = assets.map((a) => P.simulatePullback(a.m15, a.daily, { entry: 'daily', stop: 'fixed', execDelay: DELAY, funding: a.funding, shortOnly: true, confirm, stopPct, tp }));
        const days = account([[per, 1 / assets.length]]);
        const tr = per.flatMap((p) => p.trades.filter((t) => t.entryT >= start));
        const win = tr.length ? Math.round((tr.filter((t) => t.pct > 0).length / tr.length) * 100) : '-';
        const acct = account([[longPer, SLOT], [per, SLOT]]);
        const dd = T.summarizeTrend(acct, { from: start });
        const w = contestWindows(acct, start);
        return `${cal(days, start)}/${cal(days, start, IS_END - 1)}/${cal(days, IS_END)} ${win}% ${tr.length} −${dd ? Math.round(dd.maxDrawdownPct) : '-'} ${w ? w.worst : '-'}`.padStart(36);
      });
      console.log(`${String(stopPct + '%').padStart(8)} ${cells.join('')}`);
    }
  }
}

function robustShort(assets, start) {
  const FAMILIES = [
    ['S0 두 선 아래', { confirm: false }],
    ['S1 + 하락 배열', { confirm: true }],
    ['S2 + 200일선 하락', { confirm: true, slopeDays: 20 }],
    ['S3 + 20일 신저가', { confirm: true, breakdownDays: 20 }],
    ['S4 + 둘 다', { confirm: true, slopeDays: 20, breakdownDays: 20 }],
  ];
  const STOPS = [4, 6, 8, 10, 15];
  const TPS3 = [2, 3, 0];
  const TIMES = [['09:00', 0], ['13:00', 4 * 3600000], ['17:30', 8.5 * 3600000], ['21:00', 12 * 3600000]];
  const r2 = (x) => Math.round(x * 100) / 100;
  const rows = [];
  for (const [fname, fo] of FAMILIES) for (const stopPct of STOPS) for (const tp of TPS3) {
    const per = TIMES.map(([, delay]) => {
      const sims = assets.map((a) => P.simulatePullback(a.m15, a.daily, { entry: 'daily', stop: 'fixed', execDelay: delay, funding: a.funding, shortOnly: true, stopPct, tp, ...fo }));
      const days = account([[sims, 1 / assets.length]]);
      const all = T.summarizeTrend(days, { from: start });
      const is = T.summarizeTrend(days, { from: start, to: IS_END - 1 });
      const oos = T.summarizeTrend(days, { from: IS_END });
      return { sims, all, is, oos, n: sims.reduce((x, p) => x + p.trades.filter((t) => t.entryT >= start).length, 0) };
    });
    const pass = per.every((x) => x.is && x.oos && x.is.cagrPct > 0 && x.oos.cagrPct > 0);
    const minCal = Math.min(...per.map((x) => (x.all && x.all.maxDrawdownPct > 0 ? x.all.cagrPct / x.all.maxDrawdownPct : -9)));
    rows.push({ name: `${fname} · 손절 ${stopPct}% · 익절 ${tp ? `${tp}R(−${stopPct * tp}%)` : '없음'}`, per, pass, minCal: r2(minCal), fo, stopPct, tp });
  }
  const cell = (x) => `${x.all ? x.all.cagrPct : '-'}/${x.is ? x.is.cagrPct : '-'}/${x.oos ? x.oos.cagrPct : '-'}`;
  console.log(`\n[6] 숏 다시 — ${rows.length}개 × 시각 4개 · 칸 = 숏 칸 연% 전체/2020~23/2024~ (09:00 | 13:00 | 17:30 | 21:00)`);
  const passed = rows.filter((r) => r.pass).sort((a, b) => b.minCal - a.minCal);
  console.log(`통과(8개 다 플러스): ${passed.length}개`);
  for (const r of passed.slice(0, 10)) console.log(`  ${r.name} · 최소 칼마 ${r.minCal} · ${r.per.map(cell).join(' | ')} · 거래 ${r.per[2].n}번`);
  console.log('\n가족별 가장 나은 것(통과 못 했어도) — 네 시각 칼마 최솟값 기준');
  for (const [fname] of FAMILIES) {
    const best = rows.filter((r) => r.name.startsWith(fname)).sort((a, b) => b.minCal - a.minCal)[0];
    console.log(`  ${best.name} · 최소 칼마 ${best.minCal} · ${best.per.map(cell).join(' | ')} · 플러스 ${best.per.reduce((x, p) => x + (p.is && p.is.cagrPct > 0) + (p.oos && p.oos.cagrPct > 0), 0)}/8`);
  }
  const plus = (k) => rows.filter((r) => r.per.reduce((x, p) => x + (p.is && p.is.cagrPct > 0) + (p.oos && p.oos.cagrPct > 0), 0) >= k).length;
  console.log(`\n플러스 개수 분포: 8/8 ${plus(8)} · 7 이상 ${plus(7)} · 6 이상 ${plus(6)} · 4 이상 ${plus(4)} (전체 ${rows.length})`);
  return passed;
}

function main() {
  const assets = ['BTC', 'ETH'].filter((s) => fs.existsSync(path.join(DATA, `${s}USDT-15m.csv`))).map(P.loadCoin);
  if (!assets.length) return console.log('데이터 없음');
  const start = Math.max(...assets.map((a) => a.daily[Math.min(a.daily.length - 1, 200)].t));
  const sim = (o) => assets.map((a) => P.simulatePullback(a.m15, a.daily, { entry: 'daily', stop: 'fixed', execDelay: DELAY, funding: a.funding, ...o }));
  const tpLabel = (x) => (x ? `${x}R` : '없음');
  if (process.argv.includes('--short')) return shortGrid(assets, start, sim({ stopPct: 10, tp: 3 }));
  if (process.argv.includes('--robust-short')) return robustShort(assets, start);
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

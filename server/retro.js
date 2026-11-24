'use strict';

// 과거 판정 회고 — 다음 분석의 ACE·PM 에게 "내 지난 판정이 어떻게 됐나"를 알려준다.
//
// 원칙(2026-10-01 수정): 결과는 손절·익절 도달 여부로만 말한다. 진행 중인 매매의 미세한 등락
// (예: −0.17%)을 "손실로 귀결"처럼 전하면 AI 가 잡음을 학습해 매매를 피하게 된다(실제 발생).
// 레벨 기록이 없는 옛 판정은 결과를 지어내지 않고 "판정 불가"로 둔다.

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 판정 이후 봉들에서 손절·익절 중 무엇이 먼저 닿았나. 같은 봉에서 둘 다면 손절(보수적).
// bars: [{t,h,l,c}] 시간순. 반환 { outcome: 'target'|'stop'|'open', at }
function firstHit(bars, side, stop, target) {
  for (const b of bars) {
    const h = num(b.h);
    const l = num(b.l);
    if (h == null || l == null) continue;
    const hitStop = side === 'LONG' ? l <= stop : h >= stop;
    const hitTarget = side === 'LONG' ? h >= target : l <= target;
    if (hitStop) return { outcome: 'stop', at: b.t };
    if (hitTarget) return { outcome: 'target', at: b.t };
  }
  return { outcome: 'open', at: null };
}

// 판정 시각 이후 봉 — 15분봉이 그 시각을 덮으면 15분봉, 아니면 판정 다음 일봉부터(보수적).
function barsAfter(ts, candles15m, daily) {
  const m15 = Array.isArray(candles15m) ? candles15m : [];
  if (m15.length && num(m15[0].t) != null && m15[0].t <= ts) {
    return m15.filter((b) => b && b.t >= ts - 15 * 60 * 1000 + 1);
  }
  const d = Array.isArray(daily) ? daily : [];
  return d.filter((b) => b && b.t > ts);
}

// 한 판정의 회고 문장.
function describePastDecision(d, { candles15m, daily, nowPrice, now = Date.now() } = {}) {
  const when = String(d.ts || '').slice(0, 16).replace('T', ' ');
  const action = String(d.action || '-').toUpperCase();
  const head = `${when} · ${action}` + (d.confidence != null ? `(확신도 ${d.confidence}%)` : '');
  const ts = Date.parse(d.ts);
  const days = Number.isFinite(ts) ? Math.max(0, Math.round((now - ts) / 86400000)) : null;

  if (action !== 'BUY' && action !== 'SELL') {
    return `${head} → 관망(매매 없음)`;
  }
  const side = action === 'BUY' ? 'LONG' : 'SHORT';
  const entry = num(d.entryNum);
  const stop = num(d.stopNum);
  const target = num(d.targetNum);
  const levelsOk =
    entry != null && stop != null && target != null &&
    (side === 'LONG' ? stop < entry && entry < target : target < entry && entry < stop);
  if (!Number.isFinite(ts) || !levelsOk) {
    return `${head} → 손절·익절 기록 없음 — 결과 판정 불가(가격 등락으로 성패를 추정하지 말 것)`;
  }
  const hit = firstHit(barsAfter(ts, candles15m, daily), side, stop, target);
  const pct = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;
  const move = (to) => ((side === 'LONG' ? to - entry : entry - to) / entry) * 100;
  if (hit.outcome === 'target') return `${head} → 익절 도달 (${pct(move(target))}) — 성공`;
  if (hit.outcome === 'stop') return `${head} → 손절 도달 (${pct(move(stop))}) — 실패`;
  const cur = num(nowPrice);
  const curTxt = cur == null ? '' : `, 현재 ${pct(move(cur))}`;
  return `${head} → 진행 중${days != null ? ` ${days}일째` : ''}${curTxt} — 손절·익절 모두 미도달, 아직 결과 아님`;
}

const RETRO_NOTE =
  '(회고 읽는 법: 성패는 손절·익절 도달로만 판단한다. "진행 중"의 등락은 결과가 아니므로 그것을 근거로 방향이나 확신도를 바꾸지 마라.)';

module.exports = { firstHit, barsAfter, describePastDecision, RETRO_NOTE };

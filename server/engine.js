'use strict';

// PIXEL TRADING FLOOR — 분석 엔진
// 티커 입력 → 시장 데이터 수집 → 애널리스트 4명 병렬 분석 → BULL/BEAR 토론 4턴
// → ACE 최종 판정 → 리포트 저장. 모든 단계를 'event' 이벤트로 방송하고
// history 배열에 누적해 새 SSE 구독자에게 replay 한다.

const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const { resolveSymbol, fetchMarket } = require('./market');
const { AGENTS, runAgent, checkClaudeAvailable } = require('./agents');

const ANALYST_IDS = ['taro', 'diana', 'nova', 'vibe', 'research'];
const DEBATE_ORDER = ['bull', 'bear']; // 1라운드(2턴)
// 리스크 위원회 — 순차. 뒤에 오는 심사자가 앞의 의견을 받아 반박한다.
// (논문의 Risk Management team: 공격적/보수적이 먼저 붙고 중립이 중재한다)
const RISK_ORDER = ['risky', 'safe', 'neutral'];

// 모드별 파이프라인 구성 — algo 단일 모드(스캘핑·공격 모드는 폐지).
// 논문(TradingAgents) 파이프라인: 애널리스트(기술·기본·뉴스·심리·외부리서치) →
// 토론(BULL/BEAR) → ACE 1차 판정 → 리스크 위원회 → PM 최종 승인.
const MODES = {
  algo: {
    analysts: ANALYST_IDS,
    debate: DEBATE_ORDER,
    scalp: [], // 스캘핑 데스크 폐지 — 항상 빈 배열(하위 로직이 plan.scalp.length를 안전하게 참조)
    risk: RISK_ORDER, // ACE 1차 판정 → 리스크 위원회 → PM 최종 승인
    pm: true,
  },
};
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

function pad2(n) {
  return String(n).padStart(2, '0');
}

// ---------------------------------------------------------------------------
// 리스크 게이트 보조
// riskmath.js / config.js / positions.js 는 v2에서 새로 붙는 모듈이라 아직 없을 수
// 있다. 없으면 조용히 기능만 꺼지고 v1.2 파이프라인이 그대로 돈다(하위호환).
// ---------------------------------------------------------------------------

// config.js가 없을 때 쓰는 리스크 기본값 (docs/v2-contracts.md의 DEFAULTS.risk와 동일)
const RISK_FALLBACK = Object.freeze({
  minRR: 1.5,
  accountRiskPct: 2.0,
  accountSize: 0,
  leverage: 1, // 무조건 1배 고정
  maintenanceMarginPct: 0.5,
});

// 아직 없을 수 있는 모듈을 조용히 불러온다. 실패는 null.
// 에이전트 결과가 실패(한도 소진·파싱 실패 등)인지 — agents.js의 runAgentReal은 실패 시
// bubble을 '분석 실패'로 시작하는 문자열로 돌려준다. 순수 함수라 테스트하기 쉽다.
function isFailedAgentResult(res) {
  return !res || (typeof res.bubble === 'string' && res.bubble.startsWith('분석 실패'));
}

function optionalModule(rel) {
  try {
    const m = require(rel);
    return m && typeof m === 'object' ? m : null;
  } catch (_) {
    return null; // 모듈이 아직 없거나 로드 실패 — 해당 기능만 끈다
  }
}

// 전체 설정과 risk 섹션을 함께 돌려준다. config.js가 없으면 기본값으로 채운다.
function loadRiskConfig() {
  const mod = optionalModule('./config');
  let full = null;
  try {
    if (mod && typeof mod.loadConfig === 'function') {
      const cfg = mod.loadConfig();
      if (cfg && typeof cfg === 'object') full = cfg;
    }
  } catch (e) {
    console.error('[risk] 설정 로드 실패 — 기본값을 씁니다:', e && e.message ? e.message : e);
    full = null;
  }
  const risk = { ...RISK_FALLBACK };
  const patch = full && full.risk && typeof full.risk === 'object' ? full.risk : null;
  if (patch) {
    for (const k of Object.keys(RISK_FALLBACK)) {
      if (Number.isFinite(patch[k])) risk[k] = patch[k];
    }
  }
  return { full: full || { risk }, risk };
}

// 사람이 읽는 가격 표기. 값이 없으면 null(호출부에서 "데이터 없음" 처리)
function fmtPrice(v) {
  if (!Number.isFinite(v)) return null;
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 4;
  const [int, frac] = v.toFixed(digits).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

function fmtPct(v) {
  if (!Number.isFinite(v)) return '데이터 없음';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

// riskmath.positionSize 결과를 한 줄 한국어로. 값이 없으면 빈 문자열.
function formatSizingLine(sizing) {
  if (!sizing || typeof sizing !== 'object') return '';
  const bits = [];
  if (Number.isFinite(sizing.notionalPctOfAccount)) {
    bits.push(`계좌 대비 명목 ${sizing.notionalPctOfAccount}%`);
  }
  if (Number.isFinite(sizing.marginPctOfAccount)) {
    bits.push(`증거금 비중 ${sizing.marginPctOfAccount}%`);
  }
  if (Number.isFinite(sizing.qty)) bits.push(`수량 ${fmtPrice(sizing.qty)}`);
  if (Number.isFinite(sizing.notional)) bits.push(`명목 ${fmtPrice(sizing.notional)}`);
  if (Number.isFinite(sizing.marginRequired)) bits.push(`증거금 ${fmtPrice(sizing.marginRequired)}`);
  if (Number.isFinite(sizing.riskAmount)) bits.push(`허용 손실 ${fmtPrice(sizing.riskAmount)}`);
  if (!bits.length && typeof sizing.sizingNote === 'string' && sizing.sizingNote) {
    return sizing.sizingNote;
  }
  return bits.join(' · ');
}

function actionToSide(action) {
  const a = String(action || '').toUpperCase().trim();
  if (a === 'BUY') return 'LONG';
  if (a === 'SELL') return 'SHORT';
  return null;
}

function biasToSide(bias) {
  const b = String(bias || '').toUpperCase().trim();
  return b === 'LONG' || b === 'SHORT' ? b : null;
}

// 관망(HOLD/PASS) 판정이라도 레벨 숫자만으로 방향을 유추해 손익비를 참고 계산한다.
// 숫자가 없거나 방향이 모순되면 null.
function inferSideFromLevels(rm, entry, stop, target) {
  if (!rm || typeof rm.parsePrice !== 'function') return null;
  try {
    const e = rm.parsePrice(entry == null ? '' : String(entry));
    const s = rm.parsePrice(stop == null ? '' : String(stop));
    const t = rm.parsePrice(target == null ? '' : String(target));
    if (!Number.isFinite(e) || !Number.isFinite(s) || !Number.isFinite(t)) return null;
    if (t > e && s < e) return 'LONG';
    if (t < e && s > e) return 'SHORT';
    return null;
  } catch (_) {
    return null;
  }
}

// AGENTS(배열 또는 객체) → id 로 메타를 찾을 수 있는 조회 함수
function buildAgentMeta() {
  const map = {};
  if (Array.isArray(AGENTS)) {
    for (const a of AGENTS) {
      if (a && a.id) map[a.id] = a;
    }
  } else if (AGENTS && typeof AGENTS === 'object') {
    for (const key of Object.keys(AGENTS)) {
      const a = AGENTS[key];
      if (a && typeof a === 'object') map[a.id || key] = a;
    }
  }
  return map;
}

const AGENT_META = buildAgentMeta();

function metaLabel(id) {
  const m = AGENT_META[id];
  const name = (m && (m.name || m.nameKo)) || id.toUpperCase();
  const role = (m && (m.role || m.roomKo)) || '';
  return role ? `${name} (${role})` : name;
}

class Engine extends EventEmitter {
  constructor() {
    super();
    // 다수의 SSE 구독자가 리스너를 붙이므로 상한 경고를 끈다.
    this.setMaxListeners(0);
    this.history = [];
    this.running = false;
    this.runningSymbol = null; // 지금 분석 중인 심볼 — 같은 심볼의 포지션 검토와 충돌 방지용
    // 한도 소진이 감지되면 리셋 시각(epoch ms)을 여기 기록한다. watcher.js가 새
    // 분석을 시작하기 전에 이 값을 확인해서, 리셋 시각이 지나지 않았으면 시도 자체를
    // 건너뛴다 — 헛된 재시도로 텔레그램만 울리는 것을 막는다.
    this.quotaExhaustedUntil = null;
  }

  // history 에 누적하면서 실시간 방송
  _emit(evt) {
    this.history.push(evt);
    this.emit('event', evt);
  }

  // 콘솔용 로그 한 줄. kind: 'sys' | 'news' | 'stage'
  _log(line, kind = 'sys') {
    if (!line) return;
    this._emit({ type: 'log', kind, line: String(line) });
  }

  // 과거 판정 회고(reflection) — decisions.json에서 같은 심볼 최근 3건을 읽고
  // 손절·익절 중 무엇이 먼저 닿았는지(retro.js)로 성패를 문장으로 만든다.
  // 어떤 이유로 실패해도 런을 죽이지 않는다(회고는 부가 기능).
  async _buildMemory(resolved, market) {
    try {
      const raw = await fsp.readFile(path.join(REPORTS_DIR, 'decisions.json'), 'utf8');
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return null;
      const display = String(resolved.display);
      const past = arr
        .filter((d) => d && String(d.symbol) === display && d.ts)
        .slice(-3);
      if (!past.length) return null;

      const candles = Array.isArray(market && market.candles) ? market.candles : [];
      const candles15m =
        market && market.intraday && Array.isArray(market.intraday.candles15m) ? market.intraday.candles15m : [];
      const nowPrice =
        (market && market.indicators && market.indicators.price) ||
        (candles.length ? candles[candles.length - 1].c : null);

      // 성패는 손절·익절 도달로만 말한다(retro.js). 진행 중 등락을 "손실"로 전하지 않는다.
      const retro = require('./retro');
      // 레벨이 없는 옛 판정은 후보 로그(candidate-log)의 계획 숫자로 채운다 — 같은 종목, 판정 시각 ±15분.
      let plans = [];
      try {
        const cl = optionalModule('./candidate-log');
        if (cl && typeof cl.readLog === 'function') {
          plans = (cl.readLog(Date.now() - 30 * 86400000) || []).filter((r) => r && r.type === 'plan');
        }
      } catch (_) {
        plans = [];
      }
      const withLevels = past.map((d) => {
        if (d.entryNum != null && d.stopNum != null && d.targetNum != null) return d;
        const t = Date.parse(d.ts);
        const sym = String(resolved.symbol || '').toUpperCase();
        const p = plans.find(
          (r) => String(r.symbol || '').toUpperCase() === sym && Number.isFinite(t) && Math.abs(r.ts - t) <= 15 * 60 * 1000
        );
        return p ? { ...d, entryNum: p.entryNum, stopNum: p.stopNum, targetNum: p.targetNum } : d;
      });
      const out = withLevels.map((d) => retro.describePastDecision(d, { candles15m, daily: candles, nowPrice }));
      if (out.length) out.push(retro.RETRO_NOTE);
      return out.length ? out : null;
    } catch (_) {
      return null;
    }
  }

  // 에이전트 1명의 결과에서 사용량(_usage)을 뽑아 이번 run() 전체 누적치에 더한다.
  // mock 모드거나 겉포장 파싱이 안 된 에이전트는 _usage 자체가 없다 — 그런 건
  // 조용히 건너뛴다(지어내지 않는다). run() 시작 시 누적치를 초기화하고, 끝날 때
  // cost-log.js로 기록한다 — API 전환 여부를 감이 아니라 실제 숫자로 판단하기 위한
  // 데이터 수집용이다.
  _accumulateUsage(res) {
    // 한도 소진 신호는 어느 단계(애널리스트·토론·리스크·ACE·PM)에서 나와도 기록한다 —
    // 1차 프로젝트는 애널리스트 단계에서만 봐서, 토론 단계에서 한도가 차면 게이트가
    // 안 걸렸다(docs/03-POSTMORTEM.md 원인 1). watcher는 이 값을 보고 리셋 시각까지
    // 새 자동분석을 시작하지 않는다.
    if (res && res.quotaExhaustedUntil && !this.quotaExhaustedUntil) {
      this.quotaExhaustedUntil = res.quotaExhaustedUntil;
      this._log(
        `⏸️ 한도 소진 감지 — ${new Date(this.quotaExhaustedUntil).toISOString()}(UTC)까지 새 자동분석을 시작하지 않습니다.`,
        'stage'
      );
    }
    if (!res || !res._usage) return;
    const u = res._usage;
    if (Number.isFinite(u.costUsd)) {
      this._runCostUsd = (this._runCostUsd || 0) + u.costUsd;
    }
    if (u.usage) {
      if (Number.isFinite(u.usage.inputTokens)) {
        this._runInputTokens = (this._runInputTokens || 0) + u.usage.inputTokens;
      }
      if (Number.isFinite(u.usage.outputTokens)) {
        this._runOutputTokens = (this._runOutputTokens || 0) + u.usage.outputTokens;
      }
    }
    this._runAgentCount = (this._runAgentCount || 0) + 1;
  }

  // GUARD·SAFE에게 넣어줄 청산 계산 컨텍스트.
  // riskmath.js가 없거나 기준가를 못 구하면 null(프롬프트에 아무것도 붙지 않는다).
  // plan을 주면 그 진입가 기준 청산가도 함께 계산한다(리스크 위원회용).
  _buildRiskInfo(market, plan) {
    const rm = optionalModule('./riskmath');
    if (!rm || typeof rm.liquidationPrice !== 'function') return null;
    const { risk } = loadRiskConfig();

    // 한국주식은 실제 체결이 일어나는 USDT 무기한을 기준가로 쓴다(CLAUDE.md 이중 가격 체계).
    const perpPrice =
      market && market.perp && market.perp.indicators ? market.perp.indicators.price : null;
    const usePerp = Number.isFinite(perpPrice);
    const spotPrice = market && market.indicators ? market.indicators.price : null;
    const price = usePerp ? perpPrice : Number.isFinite(spotPrice) ? spotPrice : null;
    if (!Number.isFinite(price)) return null;

    const args = { leverage: risk.leverage, maintenanceMarginPct: risk.maintenanceMarginPct };
    let longLiq = null;
    let shortLiq = null;
    try {
      const l = rm.liquidationPrice({ entry: price, side: 'LONG', ...args });
      const s = rm.liquidationPrice({ entry: price, side: 'SHORT', ...args });
      longLiq = Number.isFinite(l) ? l : null;
      shortLiq = Number.isFinite(s) ? s : null;
    } catch (e) {
      console.error('[risk] 청산가 계산 실패:', e && e.message ? e.message : e);
      return null;
    }
    if (longLiq == null && shortLiq == null) return null;

    const info = {
      price,
      source: usePerp ? '체결 차트(USDT 무기한)' : '정규장',
      leverage: risk.leverage,
      maintenanceMarginPct: risk.maintenanceMarginPct,
      longLiq,
      shortLiq,
      longBufferPct: longLiq != null ? ((longLiq - price) / price) * 100 : null,
      shortBufferPct: shortLiq != null ? ((shortLiq - price) / price) * 100 : null,
      lines: [],
    };
    info.lines.push(`기준가 ${fmtPrice(price)} — ${info.source}`);
    if (longLiq != null) {
      info.lines.push(
        `${risk.leverage}배 격리로 롱 진입 시 청산가 ${fmtPrice(longLiq)} (기준가 대비 ${fmtPct(info.longBufferPct)})`
      );
    }
    if (shortLiq != null) {
      info.lines.push(
        `${risk.leverage}배 격리로 숏 진입 시 청산가 ${fmtPrice(shortLiq)} (기준가 대비 ${fmtPct(info.shortBufferPct)})`
      );
    }
    info.lines.push(
      `유지증거금률 ${risk.maintenanceMarginPct}% 가정. 손절은 반드시 이 청산 버퍼 안쪽에 둬야 한다.`
    );

    // 트레이더 계획이 있으면 그 진입가 기준 청산까지 거리도 함께 준다(SAFE 등 리스크 위원회용)
    if (plan && typeof plan === 'object') {
      const side = actionToSide(plan.action) || biasToSide(plan.scalp && plan.scalp.bias);
      let entry = null;
      try {
        entry =
          typeof rm.parsePrice === 'function'
            ? rm.parsePrice(plan.entry == null ? '' : String(plan.entry))
            : null;
      } catch (_) {
        entry = null;
      }
      if (side && Number.isFinite(entry) && entry > 0) {
        let liq = null;
        try {
          const v = rm.liquidationPrice({ entry, side, ...args });
          liq = Number.isFinite(v) ? v : null;
        } catch (_) {
          liq = null;
        }
        if (liq != null) {
          info.planEntry = entry;
          info.planSide = side;
          info.planLiq = liq;
          info.planLiqDistPct = ((liq - entry) / entry) * 100;
          info.lines.push(
            `트레이더 계획(${side} · 진입 ${fmtPrice(entry)}) 기준 청산가 ${fmtPrice(liq)} ` +
              `(진입 대비 ${fmtPct(info.planLiqDistPct)})`
          );
        }
      }
    }
    return info;
  }

  // 리스크 게이트 — 최종 판정이 확정된 직후, 저장 전에 부른다.
  // riskmath.js가 없거나 evaluatePlan이 깨지면 null을 돌려주고 엔진은 게이트를 건너뛴다.
  // 평가 대상: 알고리즘 모드는 스윙 레벨(entry/stop/target), 스캘핑·공격 모드는 scalp 레벨.
  _runRiskGate(mode, decision, market) {
    const rm = optionalModule('./riskmath');
    if (!rm || typeof rm.evaluatePlan !== 'function') return null;
    const { risk } = loadRiskConfig();

    const scope = mode === 'algo' ? 'swing' : 'scalp';
    const src = scope === 'scalp' ? decision.scalp || {} : decision;
    const declaredSide =
      scope === 'scalp' ? biasToSide(src.bias) : actionToSide(decision.action);
    const side = declaredSide || inferSideFromLevels(rm, src.entry, src.stop, src.target);

    const gate = {
      scope,
      side,
      declared: !!declaredSide, // 실제 방향성 판정인지(관망이면 false)
      minRR: risk.minRR,
      rr: null,
      ok: true,
      downgrade: false,
      liq: null,
      stopBeyondLiq: false,
      reasons: [],
      downgradeReasons: [], // 그중 강등을 유발한 사유만 — rationale 접두어에 쓴다
      sizing: null,
    };

    if (!side) {
      gate.reasons.push(
        '방향성 판정이 아니고 레벨 숫자로도 방향을 유추할 수 없어 손익비를 계산하지 않았습니다.'
      );
      return gate;
    }

    // 레버리지는 '실제로 레버리지를 쓰는 축'에만 적용한다.
    // algo(스윙)는 무레버리지·KRX 정규장 판정이므로 20배 청산가를 들이대면
    // 손절이 -4.75%보다 넓은 정상적인 중장기 셋업이 전부 "청산 위험"으로 기각된다.
    // (CLAUDE.md의 이중 가격 체계 경고와 같은 함정이다)
    const gateLeverage = scope === 'scalp' ? risk.leverage : 1;
    gate.leverage = gateLeverage;

    let res = null;
    try {
      res = rm.evaluatePlan(
        {
          entry: src.entry,
          stop: src.stop,
          target: src.target,
          side,
          mode,
          scope,
          leverage: gateLeverage,
          symbol: market && market.symbol,
          display: market && market.display,
        },
        { ...risk, leverage: gateLeverage }
      );
    } catch (e) {
      console.error('[risk] evaluatePlan 실패 — 게이트를 건너뜁니다:', e && e.message ? e.message : e);
      return null;
    }
    if (!res || typeof res !== 'object') return null;

    gate.rr = Number.isFinite(res.rr) ? res.rr : null;
    gate.liq = Number.isFinite(res.liq) ? res.liq : null;
    gate.stopBeyondLiq = res.stopBeyondLiq === true;
    gate.downgrade = res.downgrade === true;
    gate.ok = res.ok === true ? true : res.ok === false ? false : !gate.downgrade;
    gate.sizing = res.sizing && typeof res.sizing === 'object' ? res.sizing : null;
    gate.reasons = Array.isArray(res.reasons)
      ? res.reasons.filter(Boolean).map((r) => String(r))
      : [];
    // riskmath가 강등 사유만 따로 주면 그것을 쓴다(사이징 안내 같은 정보성 문구가
    // rationale 접두어에 섞여 들어가지 않게 한다). 없으면 전체 사유로 폴백.
    gate.downgradeReasons = Array.isArray(res.downgradeReasons)
      ? res.downgradeReasons.filter(Boolean).map((r) => String(r))
      : [];
    if (!gate.downgradeReasons.length && gate.downgrade) gate.downgradeReasons = gate.reasons.slice();

    // 이미 관망인 판정은 강등할 것이 없다 — 손익비는 참고 수치로만 남긴다.
    if (!gate.declared) {
      gate.downgrade = false;
      gate.reasons.push('관망(HOLD/PASS) 판정이라 리스크 게이트는 참고용으로만 계산했습니다.');
    }
    return gate;
  }

  async run(symbolInput, opts = {}) {
    // 종목 고정 — 어떤 경로(감시·수동·예약·스캐너)로 들어와도 BTC·ETH가 아니면 분석을
    // 시작하지 않는다. 분석 중 상태로 바꾸기 전에 거부해서 다른 분석을 막지 않는다.
    const uni = optionalModule('./universe');
    if (uni && typeof uni.isInUniverse === 'function' && !uni.isInUniverse(symbolInput)) {
      const err = new Error(`BTC·ETH만 분석합니다(입력: ${symbolInput}).`);
      err.code = 400;
      throw err;
    }
    if (this.running) {
      const err = new Error('이미 분석이 진행 중입니다.');
      err.code = 409;
      throw err;
    }
    this.running = true;
    this.history = []; // run:start 시점에 히스토리 리셋
    // 이번 run()의 사용량 누적치 초기화 — _accumulateUsage()가 여기 더해가고,
    // finally에서 cost-log.js로 기록한 뒤 다음 run()을 위해 다시 비운다.
    this._runCostUsd = 0;
    this._runInputTokens = 0;
    this._runOutputTokens = 0;
    this._runAgentCount = 0;
    // ACE(수석 트레이더)가 실패했는지 — 실패하면 최종 판정 자체가 무의미하므로
    // decisions.json(회고·성적표 표본)에 기록하지 않는다(_save의 excludeFromRecord).
    this._runAceFailed = false;
    // 후보 기록(candidate-log)과 잇는 ID. 감시가 넘겨주면 그대로 쓰고, 대시보드 수동 분석
    // 이면 새로 만든다. 계획·실행 결과·비용이 모두 이 ID로 연결된다.
    const candMod = optionalModule('./candidate-log');
    this._runCandidateId =
      opts.candidateId || (candMod && typeof candMod.newCandidateId === 'function' ? candMod.newCandidateId() : null);
    this._runSource = opts.source || 'manual';

    const mock = !!opts.mock;
    const mode = MODES[opts.mode] ? opts.mode : 'algo';
    const plan = MODES[mode];
    let resolved = null;
    let market = null;
    const analystResults = []; // [{id, name, bubble, report}] — 렌더/저장용
    const analystReports = {}; // {taro,diana,nova,vibe: reportString} — agents.js 프롬프트 주입용
    const debateLog = [];
    const scalpResults = []; // [{id, name, bubble, report}] — 스캘핑 데스크 렌더/저장용
    const scalpReports = {}; // {blitz, guard: reportString} — agents.js 프롬프트 주입용
    const riskResults = []; // [{id, name, bubble, report}] — 리스크 위원회 렌더/저장용
    const riskReports = {}; // {risky, safe, neutral, comply, legal: reportString}
    let strategyReport = null; // STRATEGY(수석 전략가) 종합 리포트 — 토론·리스크·PM·ACE에 주입
    const closingResults = []; // [{id, name, bubble, report}] — CIO/AUDIT/OPS 렌더/저장용
    let memory = null; // 과거 판정 회고
    let pmResult = null; // 포트폴리오 매니저 결과
    let decision = null;

    try {
      resolved = resolveSymbol(symbolInput);
      this.runningSymbol = resolved.symbol;
      // 감시(watcher) 런은 감시기가 후보 행을 이미 남겼다. 수동·예약 런은 여기서 남긴다
      // (성적표에서 트리거 판정과 정기 판정을 나눠 보려면 source 가 있어야 한다).
      if ((this._runSource === 'manual' || this._runSource === 'schedule') && candMod && typeof candMod.recordCandidate === 'function') {
        candMod.recordCandidate({
          candidateId: this._runCandidateId,
          source: this._runSource,
          symbol: resolved.symbol,
          stage: 'analyzed',
          passed: true,
          reason: this._runSource === 'schedule' ? '정기 분석(예약)' : '대시보드 수동 분석',
        });
      }
      this._emit({
        type: 'run:start',
        symbol: resolved.symbol,
        display: resolved.display,
        mock,
        mode,
      });

      // 0) 실전 런이면 claude CLI 가용성부터 확인 — 없으면 즉시 중단하고 원인을 알린다
      //    (13명을 헛돌린 뒤 "파싱 실패"만 남는 상황을 막는다)
      if (!mock) {
        const chk = await checkClaudeAvailable();
        if (!chk.ok) {
          this._log('> claude 점검 실패', 'stage');
          throw new Error(
            'claude CLI를 사용할 수 없습니다. ' + chk.message +
            ' (데모 모드 ?demo=1 는 클로드 없이 동작합니다)'
          );
        }
        this._log(`> claude 확인됨 (${chk.message})`);
      }

      // 1) 시장 데이터
      this._log(`> Fetching ${resolved.display} data...`);
      market = await fetchMarket(resolved);
      const candles = (Array.isArray(market.candles) ? market.candles : [])
        .slice(-120)
        .map((c) => ({ t: c.t, c: c.c }));
      this._emit({
        type: 'market',
        priceLine: market.priceLine,
        candles,
        display: resolved.display,
        kind: resolved.kind,
      });

      // 콘솔 중계용 로그 — 수집 결과를 사람이 읽는 순서대로 흘린다
      this._log('> 실시간 시세 수신 완료');
      if (market.priceLine) this._log(`> ${market.priceLine}`);
      for (const l of (market.indicators && market.indicators.summaryLines) || []) {
        this._log(`> ${l}`);
      }
      if (market.perp && market.perp.priceLine) {
        this._log(`> [무기한] ${market.perp.priceLine}`);
      }
      for (const l of (market.intraday && market.intraday.summaryLines) || []) {
        this._log(`> ${l}`);
      }
      for (const h of ((market.news && market.news.headlines) || []).slice(0, 6)) {
        this._log(`${h.title}${h.age ? ` (${h.age})` : ''}`, 'news');
      }

      // 과거 판정 회고(있으면 ACE·PM 프롬프트에 주입)
      memory = await this._buildMemory(resolved, market);
      if (memory) {
        this._log('── 과거 판정 회고 ──', 'stage');
        for (const l of memory) this._log(`> ${l}`);
      }

      // 청산 계산 컨텍스트 — GUARD가 청산가를 지어내지 않도록 엔진이 계산해 넣어준다.
      // riskmath.js가 없으면 null이고 프롬프트는 기존 그대로다.
      const riskInfo = this._buildRiskInfo(market, null);

      // 2) 애널리스트 병렬 (Promise.allSettled) — 모드별 인원
      this._log('── 애널리스트 팀 분석 ──', 'stage');
      const tasks = plan.analysts.map(async (id) => {
        this._emit({ type: 'agent:start', id });
        try {
          const res = await runAgent(id, { market, mode }, { mock });
          this._accumulateUsage(res);
          this._emit({
            type: 'agent:done',
            id,
            bubble: res.bubble,
            report: res.report,
          });
          return { id, name: metaLabel(id), bubble: res.bubble, report: res.report, quotaExhaustedUntil: res.quotaExhaustedUntil };
        } catch (e) {
          const bubble = '분석 실패';
          const report = '(오류) ' + (e && e.message ? e.message : String(e));
          this._emit({ type: 'agent:done', id, bubble, report });
          return { id, name: metaLabel(id), bubble, report };
        }
      });
      const settled = await Promise.allSettled(tasks);
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value) {
          analystResults.push(s.value);
          analystReports[s.value.id] = s.value.report;
          // 한도 소진 신호를 발견하면 엔진에 기록해둔다 — watcher.js가 이걸 보고
          // 리셋 시각까지 새 분석을 아예 시작하지 않는다(오늘 실전에서 같은 한도가
          // 풀리기 전까지 여러 종목이 계속 헛되이 재시도하며 텔레그램만 울린 것을
          // 보고 추가했다). 이번 실행 안의 나머지 단계까지 막진 않는다 — 이미 시작한
          // 흐름을 중간에 구조적으로 바꾸는 건 실수 위험이 더 크다고 판단했다.
          if (s.value.quotaExhaustedUntil && !this.quotaExhaustedUntil) {
            this.quotaExhaustedUntil = s.value.quotaExhaustedUntil;
            this._log(
              `⏸️ 한도 소진 감지 — ${new Date(this.quotaExhaustedUntil).toISOString()}(UTC)까지 새 자동분석을 시작하지 않습니다.`,
              'stage'
            );
          }
        }
      }

      // 2.5) 수석 전략가 — 애널리스트 전원 리포트를 토론 전 하나의 논지로 종합 (algo 모드 전용)
      if (plan.strategy) {
        this._log('── 수석 전략가 종합 ──', 'stage');
        this._emit({ type: 'agent:start', id: 'strategy' });
        try {
          const stratRes = await runAgent('strategy', { market, analystReports, mode }, { mock });
          this._accumulateUsage(stratRes);
          this._emit({
            type: 'agent:done',
            id: 'strategy',
            bubble: stratRes.bubble,
            report: stratRes.report,
          });
          this._log(`[STRATEGY] ${stratRes.bubble}`);
          strategyReport = stratRes.report;
          analystResults.push({
            id: 'strategy',
            name: metaLabel('strategy'),
            bubble: stratRes.bubble,
            report: stratRes.report,
          });
        } catch (e) {
          const bubble = '종합 실패';
          const report = '(오류) ' + (e && e.message ? e.message : String(e));
          this._emit({ type: 'agent:done', id: 'strategy', bubble, report });
          analystResults.push({ id: 'strategy', name: metaLabel('strategy'), bubble, report });
        }
      }

      // 3) BULL/BEAR 토론 순차 (algo 모드: bull→bear→bull→bear→bull→bear, scalp 모드: 생략)
      if (plan.debate.length) this._log('── 리서치 토론 (BULL vs BEAR) ──', 'stage');
      for (let i = 0; i < plan.debate.length; i++) {
        const id = plan.debate[i];
        const turn = i + 1;
        this._emit({ type: 'agent:start', id, turn });
        const res = await runAgent(
          id,
          { market, analystReports, strategyReport, debateLog, mode },
          { mock }
        );
        this._accumulateUsage(res);
        this._emit({
          type: 'agent:done',
          id,
          turn,
          bubble: res.bubble,
          report: res.report,
        });
        debateLog.push({
          id,
          turn,
          name: metaLabel(id),
          bubble: res.bubble,
          report: res.report,
        });
      }

      // 3.5) 스캘핑 데스크 (scalp 모드 전용: blitz → guard 순차, guard는 blitz 리포트를 받음)
      // 실패 정책: 애널리스트와 동일하게 '분석 실패'로 계속 진행한다.
      if (plan.scalp.length) this._log('── 스캘핑 데스크 (20x) ──', 'stage');
      for (const id of plan.scalp) {
        this._emit({ type: 'agent:start', id });
        try {
          const res = await runAgent(
            id,
            { market, analystReports, debateLog, scalpReports, riskInfo, mode },
            { mock }
          );
          this._accumulateUsage(res);
          this._emit({
            type: 'agent:done',
            id,
            bubble: res.bubble,
            report: res.report,
          });
          scalpReports[id] = res.report;
          scalpResults.push({
            id,
            name: metaLabel(id),
            bubble: res.bubble,
            report: res.report,
          });
        } catch (e) {
          const bubble = '분석 실패';
          const report = '(오류) ' + (e && e.message ? e.message : String(e));
          this._emit({ type: 'agent:done', id, bubble, report });
          scalpReports[id] = report;
          scalpResults.push({ id, name: metaLabel(id), bubble, report });
        }
      }

      // 4) ACE 판정 (algo 모드에서는 1차 계획 — 뒤에 리스크 위원회·PM 심사가 붙는다)
      this._log(
        plan.pm ? '── 수석 트레이더 1차 판정 ──' : '── 최종 판정 ──',
        'stage'
      );
      this._emit({ type: 'agent:start', id: 'ace' });
      const dec = await runAgent(
        'ace',
        { market, analystReports, strategyReport, debateLog, scalpReports, memory, mode },
        { mock }
      );
      this._accumulateUsage(dec);
      this._runAceFailed = isFailedAgentResult(dec);
      this._emit({
        type: 'agent:done',
        id: 'ace',
        bubble: dec.bubble,
        report: dec.report,
      });

      // 4.5) 리스크 위원회 (algo 모드 전용) — ACE 1차 계획을 성향별로 심사하고 서로 반박
      const traderPlan = {
        action: dec.action,
        confidence: dec.confidence,
        entry: dec.entry,
        stop: dec.stop,
        target: dec.target,
        rationale: dec.rationale,
        scalp: dec.scalp,
      };
      // 리스크 위원회는 트레이더 계획의 진입가 기준 청산가까지 함께 본다.
      const riskInfoPlan = plan.risk.length ? this._buildRiskInfo(market, traderPlan) : null;
      if (plan.risk.length) this._log('── 리스크 위원회 심사 ──', 'stage');
      for (const id of plan.risk) {
        this._emit({ type: 'agent:start', id });
        try {
          const res = await runAgent(
            id,
            {
              market,
              analystReports,
              strategyReport,
              debateLog,
              traderPlan,
              riskReports,
              riskInfo: riskInfoPlan,
              mode,
            },
            { mock }
          );
          this._accumulateUsage(res);
          this._emit({ type: 'agent:done', id, bubble: res.bubble, report: res.report });
          riskReports[id] = res.report;
          riskResults.push({ id, name: metaLabel(id), bubble: res.bubble, report: res.report });
        } catch (e) {
          const bubble = '분석 실패';
          const report = '(오류) ' + (e && e.message ? e.message : String(e));
          this._emit({ type: 'agent:done', id, bubble, report });
          riskReports[id] = report;
          riskResults.push({ id, name: metaLabel(id), bubble, report });
        }
      }

      // 4.6) 포트폴리오 매니저 최종 승인 (algo 모드 전용)
      // PM이 실패하면 ACE 판정을 그대로 최종으로 쓰고 그 사실을 리포트에 남긴다.
      if (plan.pm) {
        this._log('── 포트폴리오 매니저 최종 승인 ──', 'stage');
        this._emit({ type: 'agent:start', id: 'pm' });
        try {
          const res = await runAgent(
            'pm',
            { market, analystReports, strategyReport, debateLog, traderPlan, riskReports, memory, mode },
            { mock }
          );
          this._accumulateUsage(res);
          this._emit({ type: 'agent:done', id: 'pm', bubble: res.bubble, report: res.report });
          pmResult = {
            name: metaLabel('pm'),
            bubble: res.bubble,
            report: res.report,
            verdict: String(res.verdict || 'APPROVE').toUpperCase(),
            action: res.action,
            confidence: res.confidence,
            entry: res.entry,
            stop: res.stop,
            target: res.target,
            sizing: res.sizing || '',
            rationale: res.rationale || '',
          };
        } catch (e) {
          const report = '(오류) ' + (e && e.message ? e.message : String(e));
          this._emit({ type: 'agent:done', id: 'pm', bubble: '승인 절차 실패', report });
          pmResult = { failed: true, name: metaLabel('pm'), bubble: '승인 절차 실패', report };
        }
      }

      // 4.7) 경영진 최종 검토 (CIO→AUDIT→OPS 순차, algo 모드 전용)
      // 여기서부터는 숫자(진입·손절·목표·비중)를 절대 바꾸지 않는다 — 서술형 코멘트만
      // 남기는 검토 단계다. 하나가 실패해도 나머지는 계속 진행한다(애널리스트와 동일 정책).
      if (plan.closing && plan.closing.length) {
        this._log('── 경영진 최종 검토 ──', 'stage');
        for (const id of plan.closing) {
          this._emit({ type: 'agent:start', id });
          try {
            const res = await runAgent(
              id,
              { market, analystReports, debateLog, traderPlan, riskReports, pmResult, mode },
              { mock }
            );
            this._accumulateUsage(res);
            this._emit({ type: 'agent:done', id, bubble: res.bubble, report: res.report });
            this._log(`[${metaLabel(id)}] ${res.bubble}`);
            closingResults.push({ id, name: metaLabel(id), bubble: res.bubble, report: res.report });
          } catch (e) {
            const bubble = '검토 실패';
            const report = '(오류) ' + (e && e.message ? e.message : String(e));
            this._emit({ type: 'agent:done', id, bubble, report });
            closingResults.push({ id, name: metaLabel(id), bubble, report });
          }
        }
      }

      // 공격 모드에서 모델이 그래도 PASS를 뱉으면, 방향을 강제한다는 모드의 계약이
      // 깨진다. 기술 지표(SMA20 대비 위치)로 우위 쪽을 골라 채워 넣는다.
      const forceBias = () => {
        const i = (market && market.perp && market.perp.indicators) ||
          (market && market.indicators) || {};
        if (i.price != null && i.sma20 != null) return i.price >= i.sma20 ? 'LONG' : 'SHORT';
        return (i.changePct24h || 0) >= 0 ? 'LONG' : 'SHORT';
      };
      const attack = mode === 'attack';
      // scalp 판정은 스캘핑 데스크가 실제로 돈 모드에서만 채택한다
      // (mock ACE가 항상 scalp를 돌려줘도 algo 모드에서는 버린다)
      const scalp =
        plan.scalp.length > 0 && dec.scalp && typeof dec.scalp === 'object'
          ? {
              bias: (() => {
                const b = (dec.scalp.bias || 'PASS').toUpperCase();
                if (attack && b !== 'LONG' && b !== 'SHORT') return forceBias();
                return b;
              })(),
              entry: dec.scalp.entry != null ? dec.scalp.entry : '-',
              stop: dec.scalp.stop != null ? dec.scalp.stop : '-',
              target: dec.scalp.target != null ? dec.scalp.target : '-',
              note: dec.scalp.note != null ? dec.scalp.note : '',
            }
          : null;
      decision = {
        action: (() => {
          const a = (dec.action || 'HOLD').toUpperCase();
          // 공격 모드는 HOLD를 허용하지 않는다 — scalp 편향과 같은 쪽으로 정렬한다.
          if (attack && a !== 'BUY' && a !== 'SELL') {
            const b = (scalp && scalp.bias) || forceBias();
            return b === 'LONG' ? 'BUY' : 'SELL';
          }
          return a;
        })(),
        confidence:
          typeof dec.confidence === 'number'
            ? dec.confidence
            : Number(dec.confidence) || 0,
        entry: dec.entry != null ? dec.entry : '-',
        stop: dec.stop != null ? dec.stop : '-',
        target: dec.target != null ? dec.target : '-',
        rationale: dec.rationale != null ? dec.rationale : dec.report || '',
        report: dec.report != null ? dec.report : '',
        bubble: dec.bubble,
        scalp,
      };

      // 4.7) PM 판정을 최종 결정에 반영
      //  - APPROVE : ACE 계획 그대로
      //  - AMEND   : PM이 준 값으로 교체(빈 값은 ACE 값 유지)
      //  - REJECT  : action을 HOLD로 강제하고 기각 사유를 근거로
      if (pmResult && !pmResult.failed) {
        const v = pmResult.verdict;
        decision.verdict = v;
        if (pmResult.sizing) decision.sizing = pmResult.sizing;
        if (v === 'AMEND') {
          const a = String(pmResult.action || '').toUpperCase();
          if (['BUY', 'SELL', 'HOLD'].includes(a)) decision.action = a;
          if (typeof pmResult.confidence === 'number') decision.confidence = pmResult.confidence;
          if (pmResult.entry) decision.entry = pmResult.entry;
          if (pmResult.stop) decision.stop = pmResult.stop;
          if (pmResult.target) decision.target = pmResult.target;
          if (pmResult.rationale) {
            decision.rationale = `[PM 수정승인] ${pmResult.rationale}`;
          }
        } else if (v === 'REJECT') {
          decision.action = 'HOLD';
          decision.rationale = `[PM 기각] ${pmResult.rationale || '리스크 위원회 의견을 반영해 실행을 기각했습니다.'}`;
        } else if (pmResult.rationale) {
          decision.rationale = `${decision.rationale} [PM 승인] ${pmResult.rationale}`;
        }
      } else if (pmResult && pmResult.failed) {
        decision.verdict = 'PM_FAILED';
      }

      // 4.8) 리스크 게이트 — 손익비·청산·비중을 계산해 판정을 검증한다.
      //  - 미달(downgrade)이면 스윙은 HOLD, 스캘핑은 PASS로 강등한다.
      //  - 단, 공격 모드는 "방향 강제"가 모드의 계약이므로 강등하지 않고 경고만 남긴다.
      //  - riskmath.js가 없으면 gate가 null이고 v1.2 그대로 진행한다.
      const gate = this._runRiskGate(mode, decision, market);
      let downgraded = false;
      if (gate) {
        if (gate.downgrade) {
          gate.reasons.push(
            attack
              ? '공격 모드는 방향 강제가 계약이므로 강등하지 않고 경고만 남깁니다.'
              : decision.scalp
              ? '판정을 강등합니다 — 스윙 HOLD · 스캘핑 PASS.'
              : '스윙 판정을 HOLD로 강등합니다.'
          );
        }

        this._emit({
          type: 'risk',
          // --- 계약 필수 필드 ---
          rr: gate.rr,
          ok: gate.ok,
          reasons: gate.reasons.slice(),
          sizing: gate.sizing,
          // --- 부가 필드 (렌더·리포트 편의용, 없어도 무해) ---
          downgradeReasons: gate.downgradeReasons.slice(),
          scope: gate.scope,
          side: gate.side,
          liq: gate.liq,
          stopBeyondLiq: gate.stopBeyondLiq,
          downgrade: gate.downgrade,
          minRR: gate.minRR,
          mode,
        });

        this._log('── 리스크 게이트 ──', 'stage');
        this._log(
          `> 평가 대상: ${gate.scope === 'scalp' ? '스캘핑 레벨(레버리지 계약)' : '스윙 레벨'}` +
            ` · 방향 ${gate.side || '없음'}`
        );
        this._log(
          `> 손익비 ${gate.rr != null ? gate.rr.toFixed(2) : '데이터 없음'}` +
            ` (최소 ${gate.minRR}) · 청산가 ${fmtPrice(gate.liq) || '데이터 없음'}` +
            (gate.stopBeyondLiq ? ' · ⚠ 손절보다 청산이 먼저 온다' : '')
        );
        for (const r of gate.reasons) this._log(`> ${r}`);

        if (gate.downgrade) {
          const reasonText = gate.downgradeReasons.length
            ? gate.downgradeReasons.join(' · ')
            : '리스크 기준 미달';
          const base = decision.rationale ? ` ${decision.rationale}` : '';
          if (attack) {
            decision.rationale = `[리스크 경고] ${reasonText}${base}`;
          } else {
            downgraded = true;
            // 스윙과 스캘핑을 함께 내린다. 한쪽만 강등하면 "action BUY + scalp PASS" 같은
            // 모순이 남고, positions.js는 bias가 PASS면 action으로 방향을 되찾기 때문에
            // 강등된 판정으로 포지션이 열려버린다.
            if (decision.scalp) decision.scalp.bias = 'PASS';
            decision.action = 'HOLD';
            decision.rationale = `[리스크 게이트] ${reasonText}${base}`;
          }
        }

        decision.risk = gate;
        decision.rr = gate.rr;
        decision.riskOk = gate.ok;
        decision.riskReasons = gate.reasons;
        decision.riskScope = gate.scope;
        decision.riskSide = gate.side;
        decision.liq = gate.liq;
        decision.riskSizing = gate.sizing;
        decision.riskDowngraded = downgraded;
        // PM이 준 비중 문구가 있으면 그것을 우선한다(v1.2 표시를 덮지 않는다).
        const sizingLine = formatSizingLine(gate.sizing);
        if (!decision.sizing && sizingLine) decision.sizing = sizingLine;
      }

      const decisionEvt = {
        type: 'decision',
        action: decision.action,
        confidence: decision.confidence,
        entry: decision.entry,
        stop: decision.stop,
        target: decision.target,
        rationale: decision.rationale,
        report: decision.report,
      };
      if (decision.scalp) decisionEvt.scalp = decision.scalp;
      if (decision.verdict) decisionEvt.verdict = decision.verdict;
      if (decision.sizing) decisionEvt.sizing = decision.sizing;
      if (gate) {
        decisionEvt.rr = decision.rr;
        decisionEvt.riskOk = decision.riskOk;
        decisionEvt.riskReasons = decision.riskReasons;
        decisionEvt.liq = decision.liq;
        if (decision.riskSizing) decisionEvt.riskSizing = decision.riskSizing;
      }
      this._emit(decisionEvt);
      // 후보 기록 — 최종 계획을 원문과 숫자 둘 다 남긴다(나중에 결과 판정에 쓴다).
      try {
        if (candMod && typeof candMod.recordPlan === 'function') {
          const rm = optionalModule('./riskmath');
          const pp = (v) => (rm && typeof rm.parsePrice === 'function' ? rm.parsePrice(v) : null);
          candMod.recordPlan({
            candidateId: this._runCandidateId,
            symbol: resolved.symbol,
            decision,
            numeric: { entry: pp(decision.entry), stop: pp(decision.stop), target: pp(decision.target) },
            aceFailed: this._runAceFailed,
          });
        }
      } catch (_) {
        /* 기록 실패는 분석 흐름을 막지 않는다 */
      }
      this._log(
        `>>> 최종 판정: ${decision.action} (${decision.confidence}%)` +
          (decision.verdict ? ` · PM ${decision.verdict}` : ''),
        'stage'
      );

      // 4.9) 가상 포지션 — 강등되지 않은 방향성 판정이면 장부에만 기록한다(실주문 없음).
      //      positions.js가 없으면 아무 일도 하지 않는다.
      //      공격 모드는 방향을 강등하지 않지만(모드의 계약), 리스크 게이트가 스스로
      //      불합격시킨 계획까지 장부에 쌓이면 성적표 통계가 오염된다. 그래서 게이트
      //      결과를 포지션에 표시해 stats가 표본에서 제외할 수 있게 한다.
      if (!downgraded) {
        const posMod = optionalModule('./positions');
        if (posMod && typeof posMod.openFromDecision === 'function') {
          try {
            const { full } = loadRiskConfig();
            const gateFailed = !!(gate && gate.downgrade);
            const opened = await posMod.openFromDecision(decision, market, full, {
              mode,
              gateFailed,
            });
            if (opened) {
              this._emit({ type: 'position', action: 'open', position: opened });
              this._log(
                `> 가상 포지션 오픈: ${opened.display || opened.symbol || ''} ${opened.side || ''}` +
                  ` @ ${fmtPrice(opened.entry) || opened.entry}`
              );
              // 실거래 실행 — 기본값 꺼짐. config.execution.enabled를 명시적으로 켠 경우에만,
              // 그리고 데모(mock) 런이 아닐 때만 나간다 — 가짜 판정으로 진짜 돈이 나가면 안 된다.
              if (!mock && full && full.execution && full.execution.enabled === true) {
                await this._executeOnExchange(opened, full.execution);
              }
            }
          } catch (e) {
            console.error('[positions] 가상 포지션 오픈 실패:', e && e.message ? e.message : e);
          }
        }
      }

      // 5) 저장
      const savedPath = await this._save(
        resolved,
        market,
        mock,
        mode,
        analystResults,
        debateLog,
        scalpResults,
        riskResults,
        pmResult,
        closingResults,
        memory,
        decision,
        false, // partial 아님
        this._runAceFailed // ACE 실패(한도 소진 등) — 리포트 파일은 남기되 판정 기록에서는 뺀다
      );
      if (this._runAceFailed) {
        this._log('> 수석 트레이더 분석이 실패해 이번 판정은 회고·성적표 기록에서 제외했습니다.', 'stage');
      }
      this._emit({ type: 'saved', path: savedPath });
    } catch (err) {
      this._emit({
        type: 'run:error',
        message: err && err.message ? err.message : String(err),
      });
      // 안전장치: 끝까지 못 갔어도 여기까지 모인 결과는 그냥 버리지 않는다.
      // 최종 판정(decision)이 없으면 ACE의 1차 판정(dec)이라도 대신 쓰고,
      // 그마저 없으면(애널리스트 단계에서 죽은 경우) "미완료"로 표시해 최소한
      // 여기까지 나온 리포트들만이라도 reports/에 남긴다.
      if (resolved && (analystResults.length || debateLog.length || riskResults.length)) {
        try {
          const partial = decision || {
            action: '(미완료)',
            confidence: 0,
            entry: '-',
            stop: '-',
            target: '-',
            rationale: `런이 중간에 중단됐습니다: ${err && err.message ? err.message : String(err)}`,
          };
          const savedPartialPath = await this._save(
            resolved,
            market,
            mock,
            mode,
            analystResults,
            debateLog,
            scalpResults,
            riskResults,
            pmResult,
            closingResults,
            memory,
            partial,
            true // partial
          );
          this._log(`> 중단됐지만 여기까지 결과를 저장했습니다: ${savedPartialPath}`, 'stage');
          this._emit({ type: 'saved', path: savedPartialPath, partial: true });
        } catch (_) {
          // 저장 자체가 실패하면 조용히 포기 — 이미 run:error로 사용자에게는 알렸다
        }
      }
    } finally {
      // 이번 run()의 실제 비용을 기록한다 — API 전환 판단용 데이터 수집. 에이전트가
      // 하나도 안 돌았으면(예: 시작 직후 예외) 기록할 게 없으니 건너뛴다. 기록 자체가
      // 실패해도(디스크 문제 등) 여기서 잡아서 무시한다 — run() 종료 처리를 절대
      // 막으면 안 된다.
      if (this._runAgentCount > 0) {
        try {
          const costLogMod = optionalModule('./cost-log');
          if (costLogMod && typeof costLogMod.recordCost === 'function') {
            costLogMod.recordCost({
              symbol: resolved ? resolved.symbol : null,
              mode,
              costUsd: this._runCostUsd > 0 ? this._runCostUsd : null,
              inputTokens: this._runInputTokens > 0 ? this._runInputTokens : null,
              outputTokens: this._runOutputTokens > 0 ? this._runOutputTokens : null,
              agentCount: this._runAgentCount,
              candidateId: this._runCandidateId,
            });
          }
        } catch (e) {
          // 조용히 무시.
        }
      }
      this._emit({ type: 'run:end' });
      this.running = false;
      this.runningSymbol = null;
    }
  }

  // 리포트(.md) + decisions.json 저장. 반환: 방송용 상대 경로
  // partial=true면 파일명에 -PARTIAL을 붙이고 decisions.json에는 기록하지 않는다
  // (중단된 런의 액션 없는 판정이 통계·회고에 섞여 들어가면 안 되기 때문).
  // 가상 포지션(pos)을 그대로 실제 거래소(테스트넷/실계좌)에 주문으로 낸다.
  // 이 메서드 안에서 무슨 일이 나도 절대 throw하지 않는다 — 실행 실패가 분석 런 전체를
  // 죽이면 안 되기 때문이다(가상 포지션 기록은 이미 끝난 뒤라 손해 볼 것도 없다).
  // 거래소 실행 관련 로그는 브라우저(SSE)뿐 아니라 콘솔(journalctl)에도 남긴다 — 실제
  // 돈이 걸린 부분이라, 그 순간 화면을 보고 있지 않았어도 나중에 반드시 확인할 수 있어야
  // 한다. isError면 console.error(systemd가 우선순위를 다르게 잡아 눈에 잘 띈다).
  _logExec(line, isError = false) {
    this._log(line, 'stage');
    const stamped = `[exec] ${line}`;
    if (isError) console.error(stamped);
    else console.log(stamped);
  }

  // 'execution' 이벤트를 SSE로 방송하고, 텔레그램이 켜져 있으면 같은 내용을 폰으로도
  // 보낸다. 완전 자동 운영 중엔 이게 유일한 "지금 뭐가 일어났는지"의 창구라서, 여기서
  // 실패해도(네트워크 등) 절대 실행 흐름 자체를 막지 않는다 — 알림은 부가 기능이다.
  async _notifyExecution(payload) {
    this._emit({ type: 'execution', ...payload });
    // 후보 기록 — 실거래 실행 결과(진입·차단·실패·미확인)를 같은 후보 ID로 남긴다.
    try {
      const candMod = optionalModule('./candidate-log');
      if (candMod && typeof candMod.recordExecution === 'function') {
        candMod.recordExecution({ candidateId: this._runCandidateId, symbol: this.runningSymbol, payload });
      }
    } catch (_) {
      /* 기록 실패는 무시 */
    }
    try {
      const notifyMod = optionalModule('./notify');
      if (notifyMod && typeof notifyMod.sendExecutionEvent === 'function') {
        const { full } = loadRiskConfig();
        if (full && full.telegram && full.telegram.enabled) {
          const res = await notifyMod.sendExecutionEvent(payload, full);
          if (res && res.ok === false) {
            console.error('[notify] 실행 이벤트 텔레그램 발송 실패:', res.error);
          }
        }
      }
    } catch (e) {
      console.error('[notify] 실행 이벤트 알림 처리 중 오류:', e && e.message ? e.message : e);
    }
  }

  async _executeOnExchange(pos, execCfg) {
    this._logExec('── 거래소 주문 실행 ──');
    let exchangeMod;
    try {
      exchangeMod = require('./exchange');
    } catch (e) {
      const msg = `거래소 모듈 로드 실패: ${e && e.message ? e.message : e}`;
      this._logExec(`> ${msg}`, true);
      await this._notifyExecution({ ok: false, error: msg });
      return;
    }

    let client;
    try {
      client = exchangeMod.createClient({
        apiKey: process.env.BINANCE_API_KEY,
        apiSecret: process.env.BINANCE_API_SECRET,
        baseUrl: process.env.BINANCE_FUTURES_BASE_URL,
      });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      this._logExec(`> ${msg}`, true);
      await this._notifyExecution({ ok: false, error: msg });
      return;
    }

    // 기대값 하한(철칙, 2026-09-30 개정) — 판정·가상 장부 기록은 그대로 두고 실주문만 막는다.
    // 성적표는 판정(plan) 기준이라 표본은 줄지 않는다.
    if (typeof exchangeMod.checkEdge === 'function') {
      const eg = exchangeMod.checkEdge(
        { confidence: pos.confidence, entry: pos.entry, stop: pos.stop, target: pos.target },
        execCfg && execCfg.minEvR
      );
      this._logExec(
        `> 기대값 점검: 확신도 ${eg.confidence ?? '-'}% · 손익비 ${eg.rr ?? '-'} · 기대값 ${eg.evR ?? '-'}R (기준 ${eg.minEvR}R)`
      );
      if (eg.blocked) {
        const msg = `${eg.reason} — 기대값 ${eg.evR ?? '-'}R < ${eg.minEvR}R 라 주문하지 않습니다(판정은 성적표에 기록).`;
        this._logExec(`> ${msg}`, true);
        await this._notifyExecution({ ok: false, error: msg, edgeGate: eg });
        return;
      }
    }

    if (!(Number(pos.stop) > 0)) {
      const msg = '손절가가 없는 계획이라 안전장치로 실주문을 내지 않았습니다.';
      this._logExec(`> ${msg}`, true);
      await this._notifyExecution({ ok: false, error: msg });
      return;
    }

    // pos.symbol은 market.js 내부 표기(예: 'BTC', 'SKHYNIX')다. 바이낸스 선물 API는
    // 'BTCUSDT'처럼 완전한 심볼명을 요구한다 — 여기서만 변환한다(positions.js의 다른
    // 소비자들(장부 표시 등)은 원래 표기를 그대로 써야 하므로 거기는 건드리지 않는다).
    // pos.execSymbol이 있으면 최우선으로 쓴다 — SK하이닉스처럼 "표시 심볼 그대로 붙인
    // USDT 심볼이 특정 지역에서 거래 금지"인 경우가 있어서다(SKHYNIXUSDT는 한국 계정에서
    // 거래 불가, 실제로는 미국 ADR 기반인 SKHYUSDT로 나가야 한다). null이면(예: 삼성전자
    // — ADR 자체가 없어 우회로가 없음) 일반 변환으로 넘어가지 않고 여기서 명확히 멈춘다.
    let exSymbol;
    if (pos.execSymbol === null) {
      const msg = `${pos.display || pos.symbol}은(는) 확인 결과 이 지역에서 실거래 지원이 안 되는 종목입니다(예: 미국 ADR 없음). 실주문을 내지 않습니다.`;
      this._logExec(`> ${msg}`, true);
      await this._notifyExecution({ ok: false, error: msg });
      return;
    } else if (pos.execSymbol) {
      exSymbol = pos.execSymbol;
    } else {
      exSymbol = exchangeMod.toBinanceFuturesSymbol(pos.symbol);
    }
    if (!exSymbol) {
      const msg = `심볼을 거래소 형식으로 변환할 수 없습니다: ${pos.symbol}`;
      this._logExec(`> ${msg}`, true);
      await this._notifyExecution({ ok: false, error: msg });
      return;
    }
    // 허용 종목 잠금 — BTC·ETH 외에는 어떤 경로로 들어와도 주문하지 않는다.
    if (typeof exchangeMod.isExecutionSymbolAllowed === 'function' &&
        !exchangeMod.isExecutionSymbolAllowed(exSymbol, (execCfg || {}).allowedSymbols)) {
      const msg = `${exSymbol}는 실거래 허용 종목이 아닙니다(허용: ${
        ((execCfg || {}).allowedSymbols || exchangeMod.DEFAULT_ALLOWED_EXEC_SYMBOLS || []).join(', ')
      }) — 주문하지 않았습니다`;
      this._logExec(`> ${msg}`, true);
      await this._notifyExecution({ ok: false, error: msg });
      return;
    }

    // 포지션 충돌 — 원웨이 모드에서는 반대(또는 같은) 방향 주문이 새 포지션을 만드는 게
    // 아니라 기존 포지션과 합쳐지거나 뒤집혀서, 그 전에 걸어둔 손절이 엉뚱한 포지션을
    // 보호하게 될 수 있다. 사람이 매번 개입할 수 없으니, 유지할지 전환할지를 AI가
    // 판단한다(agents.js의 12명 로스터와 별개인 가벼운 판단 1건).
    {
      let positionRisk;
      try {
        positionRisk = await client.getPosition(exSymbol);
      } catch (e) {
        this._logExec(`> 기존 포지션 조회 실패(막지 않고 진행): ${e.message}`, true);
        positionRisk = null;
      }
      const existing = positionRisk ? exchangeMod.summarizeOpenPosition(positionRisk) : null;
      if (existing) {
        this._logExec(
          `> 기존 포지션 발견: ${exSymbol} ${existing.side} ${existing.quantity} @ ${existing.entry} ` +
            `(현재 ${existing.unrealizedPct == null ? '?' : existing.unrealizedPct + '%'})`
        );
        const agentsMod = optionalModule('./agents');
        let verdict = { action: 'KEEP', reasoning: '조정 담당 모듈을 불러오지 못해 안전하게 유지합니다.' };
        if (agentsMod && typeof agentsMod.resolvePositionConflict === 'function') {
          try {
            verdict = await agentsMod.resolvePositionConflict(
              {
                symbol: exSymbol,
                display: pos.display || pos.symbol,
                existing,
                incoming: {
                  side: pos.side,
                  entry: pos.entry,
                  stop: pos.stop,
                  target: pos.target,
                  confidence: pos.confidence,
                  rationale: pos.rationale,
                },
              },
              { mock: false }
            );
          } catch (e) {
            verdict = { action: 'KEEP', reasoning: `조정 판단 중 오류가 나 안전하게 유지합니다: ${e.message}` };
          }
        }
        this._logExec(`> 충돌 조정 판단(${verdict.action}): ${verdict.reasoning || ''}`);
        if (String(verdict.action).toUpperCase() !== 'SWITCH') {
          await this._notifyExecution({
            ok: false,
            error: '기존 포지션 유지(AI 판단)',
            conflict: { existing, verdict },
          });
          return;
        }
        const closeResult = await exchangeMod.closeExistingPosition(
          { symbol: exSymbol, side: existing.side, quantity: existing.quantity },
          client
        );
        if (!closeResult.ok) {
          this._logExec(`> ${closeResult.error}`, true);
          await this._notifyExecution({ ok: false, error: closeResult.error, conflict: { existing, verdict } });
          return;
        }
        this._logExec(`> 기존 포지션 정리 완료 — 새 판정으로 전환합니다.`);
      }
    }

    // 하루 손실 한도 — 최근 24시간 실현손익(바이낸스 기록)이 한도를 넘었으면 신규 진입을
    // 막는다. 이미 열린 포지션은 안 건드린다(걸려있는 손절이 계속 보호한다).
    {
      const execCfgForLimit = execCfg || {};
      const maxLossUsd =
        Number(execCfgForLimit.accountSizeUsd) > 0 && Number(execCfgForLimit.dailyLossLimitPct) > 0
          ? (Number(execCfgForLimit.accountSizeUsd) * Number(execCfgForLimit.dailyLossLimitPct)) / 100
          : 0;
      const loss = await exchangeMod.checkDailyLossLimit({ maxLossUsd }, client);
      if (loss.checked) {
        this._logExec(`> 최근 24시간 실현손익: ${loss.realizedPnl} USDT (한도: -${maxLossUsd} USDT)`);
      } else if (loss.error) {
        this._logExec(`> 하루 손실 한도 조회 실패(막지 않고 진행): ${loss.error}`, true);
      }
      if (loss.blocked) {
        const msg = `하루 손실 한도 초과(${loss.realizedPnl} USDT ≤ -${maxLossUsd} USDT) — 오늘은 신규 진입을 멈춥니다. 기존 포지션은 그대로 보호됩니다.`;
        this._logExec(`> ${msg}`, true);
        await this._notifyExecution({ ok: false, error: msg, dailyLossLimit: loss });
        return;
      }
    }

    // 연속 손실 서킷 브레이커 — 하루 손실 한도(금액)와 다른 문제를 본다. 포지션이 작으면
    // 연속으로 여러 번 틀려도 금액 한도엔 안 걸릴 수 있는데, "연속으로 계속 틀린다"는
    // 건 지금 전략이 지금 시장과 안 맞는다는 신호일 가능성이 높다.
    {
      const cb = await exchangeMod.checkConsecutiveLossPause(
        {
          threshold: (execCfg || {}).consecutiveLossThreshold,
          cooldownHours: (execCfg || {}).consecutiveLossCooldownHours,
        },
        client
      );
      if (cb.checked) {
        this._logExec(`> 연속 손실: ${cb.consecutiveLosses}회 (기준: ${cb.threshold}회 · 쿨다운 ${cb.cooldownHours}시간)`);
      } else if (cb.error) {
        this._logExec(`> 연속 손실 조회 실패(막지 않고 진행): ${cb.error}`, true);
      }
      if (cb.paused) {
        const msg =
          `연속 ${cb.consecutiveLosses}회 손실로 일시정지 중입니다(쿨다운 ${cb.cooldownHours}시간) — ` +
          `신규 진입을 멈춥니다. 기존 포지션은 그대로 보호됩니다. 이기는 거래가 나오거나 ` +
          `쿨다운이 지나면 자동으로 풀립니다.`;
        this._logExec(`> ${msg}`, true);
        await this._notifyExecution({ ok: false, error: msg, consecutiveLossPause: cb });
        return;
      }
    }

    // 수량은 pos.qty(애널리스트·리스크위원회 토론용 accountRiskPct 기준)를 그대로 쓰지
    // 않는다 — 실제 주문은 execution.riskPct/maxPositionPct라는 완전히 별도의(더 보수적인)
    // 기준으로 다시 계산한다. 두 기준이 다른 건 의도된 설계다.
    const riskmathMod = optionalModule('./riskmath');
    const cfg = execCfg || {};
    const sized =
      riskmathMod && typeof riskmathMod.executionSize === 'function'
        ? riskmathMod.executionSize({
            accountSize: cfg.accountSizeUsd,
            riskPct: cfg.riskPct,
            maxPositionPct: cfg.maxPositionPct,
            maxNotionalUsd: cfg.maxNotionalUsd,
            entry: pos.entry,
            stop: pos.stop,
          })
        : { qty: null };

    if (!(sized.qty > 0)) {
      const msg =
        'execution.accountSizeUsd가 설정되지 않았거나 계산이 안 돼 실주문을 내지 않았습니다. ' +
        'config.json의 execution.accountSizeUsd를 확인하세요.';
      this._logExec(`> ${msg}`, true);
      await this._notifyExecution({ ok: false, error: msg });
      return;
    }

    // AI(ACE·PM)가 토론에서 쓴 "권고 비중"(analystRiskPct, 기본 2%)과 실제로 나갈
    // "집행 비중"(execution.riskPct, 기본 0.5%+상한)은 서로 다른 기준이다 — 숨기지 않고
    // 둘 다 그대로 로그·이벤트에 남긴다("AI 제안 → 리스크 관리가 축소 집행"이 보이도록).
    const recommended = { qty: pos.qty ?? null, notional: pos.notional ?? null };
    const executed = {
      qty: sized.qty,
      notional: sized.notional,
      cappedByMax: !!sized.cappedByMax,
      cappedByAbsolute: !!sized.cappedByAbsolute,
    };
    this._logExec(
      `> AI 권고 비중(토론용 2% 룰): 수량 ${recommended.qty ?? '—'} · 명목가 ${recommended.notional ?? '—'}`
    );
    this._logExec(
      `> 실제 집행 비중(execution.riskPct ${cfg.riskPct ?? '?'}% + 상한 ${cfg.maxPositionPct ?? '?'}%): ` +
        `수량 ${executed.qty} · 명목가 ${executed.notional}` +
        (executed.cappedByAbsolute
          ? ` — 절대 금액 상한($${cfg.maxNotionalUsd})에 걸려 축소됨`
          : executed.cappedByMax
          ? ' — 포지션 상한에 걸려 축소됨'
          : '')
    );

    // 전체 포트폴리오 노출도 — 종목별 상한(maxPositionPct)과는 별개다. 워치리스트 여러
    // 종목이 동시에 트리거되면 종목별로는 다 안전해도 계좌 전체로는 과도하게 몰릴 수
    // 있다. 지금 실제로 열려있는 모든 포지션의 명목가를 다시 조회해서, 이 신규 포지션을
    // 더했을 때 계좌 전체 한도를 넘는지 확인한다.
    {
      let currentPositions = [];
      try {
        const allPositionsRisk = await client.getPosition();
        currentPositions = exchangeMod.summarizeAllOpenPositions(allPositionsRisk);
      } catch (e) {
        this._logExec(`> 전체 포지션 조회 실패(막지 않고 진행): ${e && e.message ? e.message : e}`, true);
      }
      const exposure = exchangeMod.checkPortfolioExposure({
        accountSizeUsd: cfg.accountSizeUsd,
        maxPortfolioExposurePct: cfg.maxPortfolioExposurePct,
        currentPositions,
        newNotional: sized.notional,
      });
      if (exposure.checked) {
        this._logExec(
          `> 전체 포트폴리오 노출: 기존 ${exposure.currentTotal} + 신규 ${sized.notional} = ${exposure.projectedTotal} USDT (한도 ${exposure.maxAllowed} USDT)`
        );
      }
      if (exposure.blocked) {
        const msg =
          `전체 포트폴리오 노출 한도 초과(${exposure.projectedTotal} USDT > ${exposure.maxAllowed} USDT) — ` +
          `다른 종목에 이미 열린 포지션이 많아 이 신규 진입은 넣지 않습니다. 기존 포지션은 그대로 보호됩니다.`;
        this._logExec(`> ${msg}`, true);
        await this._notifyExecution({ ok: false, error: msg, portfolioExposure: exposure });
        return;
      }
    }

    // 심볼의 수량·가격 정밀도(step)에 맞춰 반올림 — 못 가져오면 원값 그대로 시도한다
    // (거래소가 자체적으로도 거부할 수 있어 완전히 막을 필요는 없다).
    let qty = Number(sized.qty);
    let stopPrice = Number(pos.stop);
    try {
      const filters = await client.getSymbolFilters(exSymbol);
      if (filters && filters.qtyStep) {
        const rounded = exchangeMod.floorToStep(qty, filters.qtyStep);
        if (rounded != null) qty = rounded;
      }
      if (filters && filters.priceStep) {
        const rounded = exchangeMod.floorToStep(stopPrice, filters.priceStep);
        if (rounded != null) stopPrice = rounded;
      }
    } catch (e) {
      this._logExec(`> 심볼 정밀도 조회 실패(무시하고 진행): ${e && e.message ? e.message : e}`, true);
    }

    if (!(qty > 0)) {
      const msg = '정밀도 반영 후 수량이 0 이하라 실주문을 내지 않았습니다.';
      this._logExec(`> ${msg}`, true);
      await this._notifyExecution({ ok: false, error: msg });
      return;
    }

    // 주문 직전 시세 확인(R10) — 분석에 1~3분 걸리는 동안 가격이 움직였을 수 있다. 현재
    // 마크 가격이 이미 손절선을 넘었거나, 계획 진입가에서 너무 멀어졌으면(수량은 계획가
    // 기준으로 계산됐다) 주문하지 않는다. 시세를 확인하지 못해도 보수적으로 보류한다 —
    // 이 게이트는 "신규 노출"만 막고 이미 열린 포지션 보호(손절·트레일링)와는 무관하다.
    if (typeof exchangeMod.checkEntryDrift === 'function') {
      let markPrice = null;
      try {
        const mp = typeof client.getMarkPrice === 'function' ? await client.getMarkPrice(exSymbol) : null;
        markPrice = mp ? mp.markPrice : null;
      } catch (e) {
        markPrice = null;
      }
      const drift = exchangeMod.checkEntryDrift({
        side: pos.side,
        planEntry: pos.entry,
        stop: stopPrice,
        markPrice,
        maxDriftR: cfg.maxEntryDriftR,
      });
      this._logExec(
        `> 주문 직전 시세 확인: 현재가 ${markPrice ?? '확인 불가'} · 계획 진입가 ${pos.entry} · 이탈 ${drift.driftR ?? '—'}R`
      );
      if (!drift.ok) {
        const msg = `주문 직전 시세 확인 실패 — ${drift.reason}`;
        this._logExec(`> ${msg}`, true);
        await this._notifyExecution({ ok: false, error: msg });
        return;
      }
    }

    this._logExec(`> 주문 전송 중: ${exSymbol} ${pos.side} 수량 ${qty} · 손절 트리거 ${stopPrice}`);

    let result;
    try {
      result = await exchangeMod.openPositionWithStop(
        { symbol: exSymbol, action: pos.side, quantity: qty, stopPrice },
        client
      );
    } catch (e) {
      result = { ok: false, error: `실행 중 예외: ${e && e.message ? e.message : e}` };
    }

    await this._notifyExecution({ recommended, executed, ...result });
    if (result.ok) {
      this._logExec(
        `> 실거래 진입 완료: ${exSymbol} ${pos.side} ${qty} · 손절 ${stopPrice} 걸림 (레버리지 1배)`
      );
    } else {
      this._logExec(`> 실거래 실행 실패: ${result.error}`, true);
      if (result.unknown) {
        // 진입 결과를 확인하지 못했다(R11) — 재전송하지 않았다. 손절 없는 포지션이 있을 수
        // 있으니, 가능한 한 빨리 무보호 포지션 점검을 돌린다(서버 재시작 점검과 같은 로직).
        this._logExec('> ⚠ 진입 결과 미확인 — 같은 주문은 재전송하지 않았습니다. 무보호 포지션 점검을 즉시 실행합니다.', true);
        try {
          const sa = optionalModule('./startup-audit');
          const posMod = optionalModule('./positions');
          const notifyMod = optionalModule('./notify');
          if (sa && typeof sa.auditAndFixUnprotectedPositions === 'function') {
            await sa.auditAndFixUnprotectedPositions({ exchangeMod, positionsMod: posMod, notifyMod, cfg: (loadRiskConfig() || {}).full || {} });
          }
        } catch (e) {
          this._logExec(`> 무보호 포지션 점검 실패: ${e && e.message ? e.message : e}`, true);
        }
      }
      if (result.stopFailed) {
        this._logExec(
          result.flattened
            ? '> 손절 제출이 실패해 즉시 청산했습니다(보호 없는 포지션을 남기지 않음).'
            : '> ⚠ 손절도 청산도 실패했습니다 — 거래소 앱에서 포지션을 직접 확인하세요.',
          true
        );
      }
    }
  }

  async _save(resolved, market, mock, mode, analystResults, debateLog, scalpResults, riskResults, pmResult, closingResults, memory, decision, partial = false, excludeFromRecord = false) {
    await fsp.mkdir(REPORTS_DIR, { recursive: true });

    const now = new Date();
    const dateStr = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(
      now.getDate()
    )}`;
    const hhmm = `${pad2(now.getHours())}${pad2(now.getMinutes())}`;
    const safeDisplay =
      String(resolved.display).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 40) ||
      'SYMBOL';
    const fname = `${dateStr}-${safeDisplay}-${hhmm}${partial ? '-PARTIAL' : ''}.md`;
    const fullPath = path.join(REPORTS_DIR, fname);

    const md = this._renderMarkdown(
      resolved,
      market,
      mock,
      mode,
      analystResults,
      debateLog,
      scalpResults,
      riskResults,
      pmResult,
      closingResults,
      memory,
      decision,
      now,
      partial
    );
    await fsp.writeFile(fullPath, md, 'utf8');

    // decisions.json append — 중단된(partial) 런은 액션 없는 판정이라 통계·회고 표본에서 뺀다
    // 수석 트레이더가 실패한 런(한도 소진 등)도 같은 이유로 뺀다 — 예전엔 이런 런이
    // "HOLD(0%)"로 기록돼서, 다음 분석의 과거 판정 회고에 가짜 판정으로 섞여 들어갔다
    // (2026-09-24 실전 로그에서 발견).
    if (partial || excludeFromRecord) return `reports/${fname}`;
    const decPath = path.join(REPORTS_DIR, 'decisions.json');
    let arr = [];
    try {
      const raw = await fsp.readFile(decPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) arr = parsed;
    } catch (_) {
      arr = [];
    }
    arr.push({
      ts: now.toISOString(),
      symbol: resolved.display,
      mode,
      action: decision.action,
      confidence: decision.confidence,
      verdict: decision.verdict || null,
      scalpBias:
        decision.scalp && decision.scalp.bias
          ? String(decision.scalp.bias).toUpperCase()
          : null,
      // 리스크 게이트 결과 — 게이트가 없거나 계산 불가면 null (0으로 위장하지 않는다)
      rr: Number.isFinite(decision.rr) ? decision.rr : null,
      riskOk: typeof decision.riskOk === 'boolean' ? decision.riskOk : null,
      // 회고(retro.js)가 손절·익절 도달로 성패를 판정하려면 숫자 레벨이 필요하다.
      ...(() => {
        const rm = optionalModule('./riskmath');
        const pp = (v) => (rm && typeof rm.parsePrice === 'function' ? rm.parsePrice(v) : null);
        return { entryNum: pp(decision.entry), stopNum: pp(decision.stop), targetNum: pp(decision.target) };
      })(),
    });
    await fsp.writeFile(decPath, JSON.stringify(arr, null, 2), 'utf8');

    return `reports/${fname}`;
  }

  _renderMarkdown(resolved, market, mock, mode, analystResults, debateLog, scalpResults, riskResults, pmResult, closingResults, memory, decision, now, partial = false) {
    const modeLabel =
      mode === 'attack'
        ? '⚔ 공격(탭비트 20x · 방향 강제)'
        : mode === 'scalp'
        ? '스캘핑(탭비트 20x 단타)'
        : '알고리즘(논문 파이프라인)';
    const lines = [];
    lines.push(`# PIXEL TRADING FLOOR 분석 리포트${partial ? ' (미완료 — 중단됨)' : ''}`);
    lines.push('');
    if (partial) {
      lines.push(
        '> ⚠ 이 런은 끝까지 완료되지 못하고 중단됐습니다. 아래는 중단 시점까지 나온 ' +
          '결과만 모은 것이며, 최종 판정으로 취급하면 안 됩니다. decisions.json 통계에도 ' +
          '포함되지 않습니다.'
      );
      lines.push('');
    }
    lines.push(`- 심볼: ${resolved.display} (${resolved.symbol}, ${resolved.kind})`);
    lines.push(`- 시각: ${now.toISOString()}`);
    lines.push(`- 모드: ${modeLabel} · ${mock ? '데모(시뮬레이션 목업)' : '실전(claude opus)'}`);
    if (market && market.priceLine) lines.push(`- 시세: ${market.priceLine}`);
    if (market && market.perp && market.perp.priceLine) {
      lines.push(`- 시세(체결 기준): ${market.perp.priceLine}`);
    }
    if (mode === 'attack') {
      lines.push(
        '- ⚠ 공격 모드: 관망(PASS/HOLD)을 금지하고 반드시 방향을 고르게 한 런이다. ' +
          '우위가 미약해도 한쪽이 선택되므로, 확신도와 무효화 레벨을 함께 보지 않으면 오독하기 쉽다.'
      );
    }
    lines.push('');
    if (market && market.board && Array.isArray(market.board.lines) && market.board.lines.length) {
      lines.push('## 멀티 거래소 전광판');
      lines.push('');
      for (const l of market.board.lines) lines.push(`- ${l}`);
      lines.push('');
    }

    lines.push('## 애널리스트 리포트');
    lines.push('');
    for (const r of analystResults) {
      lines.push(`### ${r.name}`);
      lines.push(`> ${r.bubble || ''}`);
      lines.push('');
      lines.push(r.report || '(리포트 없음)');
      lines.push('');
    }

    if (debateLog.length) {
      lines.push('## 리서치 토론 (BULL vs BEAR)');
      lines.push('');
    }
    for (const d of debateLog) {
      lines.push(`### 턴 ${d.turn} — ${d.name}`);
      lines.push(`> ${d.bubble || ''}`);
      lines.push('');
      lines.push(d.report || '(리포트 없음)');
      lines.push('');
    }

    if (Array.isArray(scalpResults) && scalpResults.length) {
      lines.push('## 스캘핑 데스크 (20x)');
      lines.push('');
      for (const r of scalpResults) {
        lines.push(`### ${r.name}`);
        lines.push(`> ${r.bubble || ''}`);
        lines.push('');
        lines.push(r.report || '(리포트 없음)');
        lines.push('');
      }
    }

    if (Array.isArray(riskResults) && riskResults.length) {
      lines.push('## 리스크 위원회');
      lines.push('');
      for (const r of riskResults) {
        lines.push(`### ${r.name}`);
        lines.push(`> ${r.bubble || ''}`);
        lines.push('');
        lines.push(r.report || '(리포트 없음)');
        lines.push('');
      }
    }

    if (pmResult) {
      lines.push('## 포트폴리오 매니저 승인');
      lines.push('');
      if (pmResult.failed) {
        lines.push('- 판정: **승인 절차 실패** — 수석 트레이더(ACE)의 판정을 그대로 최종으로 사용했습니다.');
        lines.push('');
        lines.push(pmResult.report || '');
        lines.push('');
      } else {
        lines.push(`- 판정: **${pmResult.verdict}**`);
        if (pmResult.sizing) lines.push(`- 권장 비중: ${pmResult.sizing}`);
        if (pmResult.rationale) lines.push(`- 근거: ${pmResult.rationale}`);
        lines.push('');
        lines.push(`> ${pmResult.bubble || ''}`);
        lines.push('');
        lines.push(pmResult.report || '(리포트 없음)');
        lines.push('');
      }
    }

    if (Array.isArray(closingResults) && closingResults.length) {
      lines.push('## 경영진 최종 검토 (CIO → 감사 → 집행)');
      lines.push('');
      lines.push(
        '숫자(진입·손절·목표·비중)는 PM 승인 단계에서 이미 확정됐습니다. 아래는 그 위에 ' +
          '얹힌 서술형 코멘트이며 판정 자체를 바꾸지 않습니다.'
      );
      lines.push('');
      for (const r of closingResults) {
        lines.push(`### ${r.name}`);
        lines.push(`> ${r.bubble || ''}`);
        lines.push('');
        lines.push(r.report || '(리포트 없음)');
        lines.push('');
      }
    }

    if (Array.isArray(memory) && memory.length) {
      lines.push('## 과거 판정 회고');
      lines.push('');
      for (const m of memory) lines.push(`- ${m}`);
      lines.push('');
    }

    if (decision.risk) {
      const g = decision.risk;
      lines.push('## 리스크 게이트');
      lines.push('');
      lines.push(
        `- 평가 대상: ${g.scope === 'scalp' ? '스캘핑 레벨(레버리지 계약)' : '스윙 레벨(정규장)'}` +
          ` · 방향 ${g.side || '없음'}`
      );
      lines.push(
        `- 손익비(R:R): ${g.rr != null ? g.rr.toFixed(2) : '데이터 없음'} (최소 기준 ${g.minRR})`
      );
      lines.push(
        `- 청산가: ${fmtPrice(g.liq) || '데이터 없음'}` +
          (g.stopBeyondLiq ? ' — ⚠ 손절이 청산가보다 멀다(청산이 먼저 온다)' : '')
      );
      lines.push(`- 권장 비중: ${formatSizingLine(g.sizing) || '데이터 없음'}`);
      lines.push(
        `- 통과 여부: ${g.ok ? '통과' : '미달'}` +
          (decision.riskDowngraded
            ? ' → 판정 강등'
            : g.downgrade
            ? ' → 공격 모드라 강등 없이 경고만'
            : '')
      );
      if (Array.isArray(g.reasons) && g.reasons.length) {
        lines.push('- 사유:');
        for (const r of g.reasons) lines.push(`  - ${r}`);
      }
      lines.push('');
    }

    lines.push(
      pmResult && !pmResult.failed ? '## 최종 판정 (ACE → PM 승인)' : '## 최종 판정 (ACE)'
    );
    lines.push('');
    lines.push(`- 액션: **${decision.action}**`);
    if (decision.verdict) lines.push(`- PM 판정: ${decision.verdict}`);
    if (decision.sizing) lines.push(`- 권장 비중: ${decision.sizing}`);
    lines.push(`- 확신도: ${decision.confidence}%`);
    lines.push(`- 진입: ${decision.entry}`);
    lines.push(`- 손절: ${decision.stop}`);
    lines.push(`- 목표: ${decision.target}`);
    lines.push(`- 근거: ${decision.rationale}`);
    lines.push('');
    if (decision.scalp) {
      const s = decision.scalp;
      lines.push('### 스캘핑 판정 (탭비트 20x)');
      lines.push(`- 편향: **${s.bias || '-'}**`);
      lines.push(`- 진입 트리거: ${s.entry || '-'}`);
      lines.push(`- 무효화(손절): ${s.stop || '-'}`);
      lines.push(`- 1차 목표: ${s.target || '-'}`);
      lines.push(`- 리스크: ${s.note || '-'}`);
      lines.push('');
    }
    if (decision.report) {
      lines.push(decision.report);
      lines.push('');
    }

    lines.push('---');
    lines.push(
      '본 리포트는 AI 시뮬레이션 결과이며 투자 조언이 아닙니다. 실제 주문은 이뤄지지 않습니다.'
    );
    lines.push('');
    return lines.join('\n');
  }
}

module.exports = { Engine, isFailedAgentResult };

'use strict';

// PIXEL TRADING FLOOR — 에이전트 모듈
// 역할별 프롬프트 빌더 + `claude -p --model opus` 스폰 + 데모(mock) 응답.
// 외부 npm 의존성 없음(Node 24 내장만). CommonJS.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// 에이전트 메타 (순서 고정: 애널리스트 4 → 리서치 2 → 스캘핑 2 → 수석 1)
// name: 영문 대문자 / nameKo: 한국어 표기 / role: 한국어 역할 배지 / roomKo: 방 이름
// ---------------------------------------------------------------------------
const AGENTS = [
  { id: 'taro', name: 'TARO', nameKo: '타로', role: '기술적 분석', roomKo: '애널리스트 룸' },
  { id: 'diana', name: 'DIANA', nameKo: '다이애나', role: '기본적 분석', roomKo: '애널리스트 룸' },
  { id: 'nova', name: 'NOVA', nameKo: '노바', role: '뉴스 분석', roomKo: '애널리스트 룸' },
  { id: 'vibe', name: 'VIBE', nameKo: '바이브', role: '센티먼트', roomKo: '애널리스트 룸' },
  // 유일하게 실제 웹 검색을 쓰는 데스크 — 논문·기사 등 외부 근거 자료 수집 전담
  { id: 'research', name: 'RESEARCH', nameKo: '리서치', role: '외부 자료 조사', roomKo: '애널리스트 룸' },
  { id: 'bull', name: 'BULL', nameKo: '불', role: '매수 논거', roomKo: '리서치 룸' },
  { id: 'bear', name: 'BEAR', nameKo: '베어', role: '매도 논거', roomKo: '리서치 룸' },
  // 논문(TradingAgents)의 Risk Management team — 성향이 다른 3인이 트레이더 계획을 놓고 논쟁한다
  { id: 'risky', name: 'RISKY', nameKo: '리스키', role: '공격적 리스크', roomKo: '리스크 위원회' },
  { id: 'neutral', name: 'NEUTRAL', nameKo: '뉴트럴', role: '중립적 리스크', roomKo: '리스크 위원회' },
  { id: 'safe', name: 'SAFE', nameKo: '세이프', role: '보수적 리스크', roomKo: '리스크 위원회' },
  { id: 'ace', name: 'ACE', nameKo: '에이스', role: '수석 트레이더', roomKo: '트레이딩 룸' },
  // 논문의 Portfolio Manager — 트레이더 계획을 승인/수정/기각하는 최종 관문
  { id: 'pm', name: 'PM', nameKo: '피엠', role: '포트폴리오 매니저', roomKo: '트레이딩 룸' },
];

const AGENT_BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

const SPAWN_TIMEOUT_MS = 180000; // 180초

// ---------------------------------------------------------------------------
// extractJson: 첫 '{' 부터 마지막 '}' 까지 잘라 JSON.parse. 실패 시 null.
// ---------------------------------------------------------------------------
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  const slice = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(slice);
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 프롬프트 빌더 헬퍼
// ---------------------------------------------------------------------------
function lines(arr, fallback = '데이터 없음') {
  if (!Array.isArray(arr) || arr.length === 0) return fallback;
  return arr.map((s) => String(s)).join('\n');
}

function formatRecentCandles(candles, n = 20) {
  if (!Array.isArray(candles) || candles.length === 0) return '데이터 없음';
  return candles
    .slice(-n)
    .map((c) => {
      const d = new Date(c.t);
      const day = Number.isNaN(d.getTime()) ? String(c.t) : d.toISOString().slice(0, 10);
      return `${day}  시가 ${c.o}  고가 ${c.h}  저가 ${c.l}  종가 ${c.c}  거래량 ${c.v}`;
    })
    .join('\n');
}

// 15분봉(인트라데이) — 날짜+시각(MM-DD HH:MM)까지 표기
function formatIntradayCandles(candles, n = 20) {
  if (!Array.isArray(candles) || candles.length === 0) return '데이터 없음';
  return candles
    .slice(-n)
    .map((c) => {
      const d = new Date(c.t);
      const tm = Number.isNaN(d.getTime())
        ? String(c.t)
        : d.toISOString().slice(5, 16).replace('T', ' ');
      return `${tm}  시가 ${c.o}  고가 ${c.h}  저가 ${c.l}  종가 ${c.c}  거래량 ${c.v}`;
    })
    .join('\n');
}

function formatHeadlines(headlines, withAge = true) {
  if (!Array.isArray(headlines) || headlines.length === 0) return '데이터 없음';
  return headlines
    .map((h, i) => {
      const age = withAge && h.age ? ` (${h.age})` : '';
      return `${i + 1}. ${h.title}${age}`;
    })
    .join('\n');
}

// 애널리스트 팀 전원(모드에 따라 2~11명)의 리포트를 나열한다.
// 값이 없는(그 모드에서 안 돈) 애널리스트는 아예 줄을 생략한다 — "(없음)"을 채운
// 자리보다는 실제로 참여한 사람만 보여주는 편이 모델이 혼동하지 않는다.
const ANALYST_LABEL_ORDER = [
  ['taro', 'TARO(기술적 분석)'],
  ['diana', 'DIANA(기본적 분석)'],
  ['nova', 'NOVA(뉴스 분석)'],
  ['vibe', 'VIBE(센티먼트)'],
  ['research', 'RESEARCH(외부 자료 조사)'],
];

function formatAnalystReports(reports) {
  const r = reports || {};
  const out = ANALYST_LABEL_ORDER.filter(([k]) => r[k]).map(([k, label]) => `${label}: ${r[k]}`);
  return out.length ? out.join('\n') : '(없음)';
}

// 수석 전략가(STRATEGY)의 종합 논지 — 토론·리스크·PM 프롬프트에 한 블록으로 주입.
function formatStrategy(text) {
  if (!text) return '';
  return `STRATEGY(수석 전략가 종합): ${text}`;
}

function formatScalpReports(reports) {
  const r = reports || {};
  return [
    `BLITZ(스캘퍼): ${r.blitz || '(없음)'}`,
    `GUARD(리스크 관리): ${r.guard || '(없음)'}`,
  ].join('\n');
}

// ACE의 1차 판정을 리스크 위원회·PM에게 넘길 때의 문자열화.
// 엔진이 객체를 주지만 문자열로 줘도 그대로 통과시킨다.
function formatTraderPlan(plan) {
  if (!plan) return '(없음)';
  if (typeof plan === 'string') return plan;
  const p = plan || {};
  const out = [
    `액션: ${p.action || '-'}`,
    `확신도: ${p.confidence != null ? p.confidence + '%' : '-'}`,
    `진입: ${p.entry || '-'}`,
    `손절: ${p.stop || '-'}`,
    `목표: ${p.target || '-'}`,
  ];
  if (p.rationale) out.push(`근거: ${p.rationale}`);
  if (p.scalp && typeof p.scalp === 'object') {
    out.push(
      `스캘핑(20x): ${p.scalp.bias || '-'} / 진입 ${p.scalp.entry || '-'} / ` +
        `손절 ${p.scalp.stop || '-'} / 목표 ${p.scalp.target || '-'}`
    );
  }
  return out.join('\n');
}

// 리스크 위원회 의견 모음. exceptId를 주면 그 심사자 본인 의견은 뺀다(아직 안 낸 상태).
function formatRiskReports(reports, exceptId) {
  const r = reports || {};
  const order = [
    ['risky', 'RISKY(공격적)'],
    ['safe', 'SAFE(보수적)'],
    ['neutral', 'NEUTRAL(중립)'],
  ];
  const out = order
    .filter(([k]) => k !== exceptId && r[k])
    .map(([k, label]) => `${label}: ${r[k]}`);
  return out.length ? out.join('\n') : '';
}

// 과거 판정 회고(reflection) — 엔진이 decisions.json에서 만들어 넣는다.
function formatMemory(memory) {
  if (!memory) return '';
  if (Array.isArray(memory)) {
    const arr = memory.filter(Boolean).map((s) => String(s));
    return arr.length ? arr.join('\n') : '';
  }
  return String(memory);
}

const MEMORY_RULE =
  '위는 같은 심볼에 대한 과거 판정과 그 이후 가격 흐름이다. 같은 실수를 반복하지 마라. ' +
  '과거와 판단이 달라졌다면 무엇이 달라졌는지 rationale에 한 줄로 밝혀라. ' +
  '과거 판정에 끌려 현재 데이터를 왜곡해서도 안 된다.';

// krstock이면 "이 데이터는 탭비트 <tapbitPair> 무기한선물 기준" 안내 한 줄을 생성(아니면 빈 문자열).
// 국내 정규장은 하루 중 대부분 닫혀있어, 실시간으로 체결이 일어나는 축은 이 무기한선물이다 —
// 레버리지와 무관하게 "지금 가격이 어디서 온 데이터인지"를 밝히는 용도로만 쓴다(레버리지는 1배 고정).
function tapbitLine(market) {
  const m = market || {};
  if (m.kind === 'krstock' && m.tapbitPair) {
    const nm = m.nameKo ? `${m.nameKo} ` : '';
    return (
      `※ 이 종목(${nm}${m.display || m.symbol || ''})은 국내주식이지만, 정규장이 닫혀있는 ` +
      `시간대엔 탭비트 ${m.tapbitPair} 무기한선물의 실시간 체결가를 참고 데이터로 쓴다 ` +
      `(레버리지는 이 프로젝트 전체가 1배 고정이다).`
    );
  }
  return '';
}

function formatDebateLog(debateLog) {
  if (!Array.isArray(debateLog) || debateLog.length === 0) return '(아직 발언 없음)';
  return debateLog
    .map((d) => {
      const meta = AGENT_BY_ID[d.id];
      const who = meta ? meta.name : String(d.id || '?');
      const bubble = d.bubble ? `[${d.bubble}] ` : '';
      return `${who}: ${bubble}${d.report || ''}`;
    })
    .join('\n');
}

// 스캘핑 데스크가 읽어야 할 차트를 고른다. KR 주식에는 탭비트와 동일한 계약의
// 24시간 USDT 무기한 데이터(market.perp)가 붙는데, KRX 정규장 원화 차트와는
// ATR·레인지가 크게 다르므로(정규장 폭락일엔 ATR이 몇 배로 부풀려진다) 20배
// 레버리지 판단은 반드시 실제 체결이 일어나는 이쪽을 봐야 한다.
function scalpSource(market) {
  const perp = market.perp;
  if (perp && perp.intraday && Array.isArray(perp.intraday.summaryLines)) {
    return {
      label: `체결 차트 — ${perp.source || 'USDT 무기한'}`,
      priceLine: perp.priceLine || '',
      indicatorLines: (perp.indicators || {}).summaryLines || [],
      intradayLines: perp.intraday.summaryLines,
      candles15m: perp.intraday.candles15m,
      fx: perp.krwPerUsd || null,
      isPerp: true,
    };
  }
  return {
    label: '체결 차트 — 정규장',
    priceLine: market.priceLine || '',
    indicatorLines: (market.indicators || {}).summaryLines || [],
    intradayLines: (market.intraday || {}).summaryLines || [],
    candles15m: (market.intraday || {}).candles15m,
    fx: null,
    isPerp: false,
  };
}

// 스캘핑 프롬프트 앞머리 — 어떤 차트를 보는지와 통화 기준을 못박는다.
function scalpChartBlock(market) {
  const src = scalpSource(market);
  const parts = [`[${src.label}]`];
  if (src.priceLine) parts.push(src.priceLine);
  if (src.isPerp) {
    parts.push(
      '이 계약이 실제 주문이 체결되는 차트다. 모든 진입·손절·목표는 이 USDT 가격으로 제시하라.' +
        (src.fx ? ` 원화 환산이 필요하면 환율 ${src.fx}을 쓰고 괄호로 병기하라.` : '')
    );
  }
  parts.push('');
  parts.push('[체결 차트 기술 지표]');
  parts.push(lines(src.indicatorLines));
  parts.push('');
  parts.push('[체결 차트 인트라데이 요약]');
  parts.push(lines(src.intradayLines));
  const board = market.board && Array.isArray(market.board.lines) ? market.board.lines : null;
  if (board) {
    parts.push('');
    parts.push('[멀티 거래소 전광판]');
    parts.push(lines(board));
  }
  return { parts, src };
}

// 브리핑 분량 공통 규칙 — 12명이 매번 이 길이로 쓰면 토큰(=비용·한도)이 크게
// 불어난다(실측: 8~14문장 지침일 때 분석 1회에 출력만 3만 토큰대, 비용 $3.5+ —
// 2026-09-24 실전 데이터로 확인). 판단에 필요한 4가지 요소(①~④)는 그대로 요구하되,
// 그걸 설명하는 글의 길이만 확 줄인다 — 분석의 깊이가 아니라 "말을 얼마나 길게
// 풀어쓰는가"만 줄이는 것이다. 글자수 상한을 문장 수보다 우선하는 제약으로 명시해서,
// 모델이 "짧은 문장 여러 개"로 우회해 실질적으로는 안 줄이는 것을 막는다.
const BRIEFING_RULE =
  '[브리핑 분량] report는 3~5문장, 총 150~250자로 극도로 압축해서 써라(글자수 상한이 ' +
  '문장 수보다 우선한다 — 문장을 쪼개서 분량을 우회하지 마라). 소제목 없이 한 단락으로, ' +
  '① 관찰한 수치를 구체적으로 인용 ② 그 수치의 해석 ③ 반대 시나리오와 리스크 ' +
  '④ 판단이 바뀌는 트리거(가격·레벨·이벤트)를 각각 한 문장 안팎으로만 담아라. 미사여구·' +
  '배경 설명·과거 판정과의 비교 서술은 생략하고 숫자와 결론 위주로 써라. ' +
  '제공된 데이터에 없는 수치는 절대 만들지 말고, 없으면 "데이터 없음"이라고 밝혀라. ' +
  'bubble은 말풍선에 여러 줄로 표시되므로 2~3문장(60~120자)으로 결론과 핵심 근거를 담아라.';

const BUBBLE_SPEC = '"bubble":"말풍선 2~3문장(한국어, 60~120자)"';
const REPORT_SPEC = '"report":"압축 브리핑(한국어, 3~5문장, 150~250자)"';

// 최소 리포트 규칙 — ACE·PM 전용. 이 두 역할의 report 텍스트는 뒷단계 어떤 에이전트도
// 입력으로 읽지 않는다(엔진이 리스크 위원회에 넘기는 traderPlan에는 action·entry·
// stop·target·rationale만 들어가고 report는 없다 — engine.js 확인). 그래서 report를
// 한 줄로 줄여도 판단의 질에는 영향이 없다. 실제 판단에 쓰이는 값(action·confidence·
// entry·stop·target)과 근거(rationale)는 그대로 요구한다 — 분석은 줄이지 않고, 아무도
// 안 읽는 서술만 줄이는 것이다.
//
// 1층 애널리스트·BULL/BEAR·리스크 위원회는 여기 해당하지 않는다 — 이들의 report는
// 뒷단계가 실제로 읽고 판단에 쓰므로 BRIEFING_RULE(150~250자)을 그대로 적용한다.
const MINIMAL_REPORT_RULE =
  '[리포트 분량] report는 한 줄(40자 이내)로 최종 결론만 적어라(예: "BUY 판정 — 조건부 진입"). ' +
  '판단 과정의 서술은 report가 아니라 rationale에 담는다. 단, 분석 자체를 생략하지 마라 — ' +
  '앞선 리포트·수치를 모두 검토한 뒤 action·confidence·entry·stop·target은 평소와 똑같이 ' +
  '구체적인 숫자로 정확히 채워야 한다. 제공된 데이터에 없는 수치는 절대 만들지 마라. ' +
  'bubble은 말풍선에 여러 줄로 표시되므로 2~3문장(60~120자)으로 결론과 핵심 근거를 담아라.';

const MINIMAL_REPORT_SPEC = '"report":"최종 결론 한 줄(한국어, 40자 이내)"';

// bubble/report만 요구하는 공통 JSON 출력 규칙
const OUTPUT_BASIC =
  '반드시 아래 형식의 JSON 하나만 출력하라. 코드블록 표시나 다른 설명 문장을 붙이지 마라:\n' +
  `{${BUBBLE_SPEC},${REPORT_SPEC}}`;

// pm 전용 — 트레이더 계획에 대한 최종 승인/수정/기각
const OUTPUT_PM =
  '반드시 아래 형식의 JSON 하나만 출력하라. 코드블록 표시나 다른 설명 문장을 붙이지 마라:\n' +
  `{${BUBBLE_SPEC},${MINIMAL_REPORT_SPEC},` +
  '"verdict":"APPROVE|AMEND|REJECT 중 하나","action":"BUY|SELL|HOLD 중 하나","confidence":0-100 사이 정수,' +
  '"entry":"진입가 또는 진입 조건","stop":"손절가","target":"목표가",' +
  '"sizing":"권장 포지션 비중 한 줄(한국어)",' +
  '"rationale":"승인/수정/기각 근거 1~2문장, 150자 이내 — 판단이 바뀌는 트리거(가격 레벨)를 반드시 포함(한국어)"}';

// ace 전용 확장 JSON 출력 규칙 — 스캘핑 데스크가 없는 런(알고리즘 모드)용
const OUTPUT_ACE_CORE =
  '반드시 아래 형식의 JSON 하나만 출력하라. 코드블록 표시나 다른 설명 문장을 붙이지 마라:\n' +
  `{${BUBBLE_SPEC},${MINIMAL_REPORT_SPEC},` +
  '"action":"BUY|SELL|HOLD 중 하나","confidence":0-100 사이 정수,' +
  '"entry":"진입가 또는 진입 조건","stop":"손절가","target":"목표가","rationale":"판정 근거 2-3문장, 150자 이내(한국어)"}';

// ace 전용 확장 JSON 출력 규칙 — 스캘핑 데스크 포함 런용
const OUTPUT_ACE =
  '반드시 아래 형식의 JSON 하나만 출력하라. 코드블록 표시나 다른 설명 문장을 붙이지 마라:\n' +
  `{${BUBBLE_SPEC},${MINIMAL_REPORT_SPEC},` +
  '"action":"BUY|SELL|HOLD 중 하나","confidence":0-100 사이 정수,' +
  '"entry":"진입가 또는 진입 조건","stop":"손절가","target":"목표가","rationale":"판정 근거 2-3문장, 150자 이내(한국어)",' +
  '"scalp":{"bias":"LONG|SHORT|PASS 중 하나","entry":"진입 트리거 가격/조건","stop":"무효화(손절) 레벨",' +
  '"target":"1차 청산 목표","note":"20배 리스크 한 줄(한국어)"}}';

// ace 전용 — 공격 모드(PASS 금지, 반드시 방향을 고른다)
const OUTPUT_ACE_ATTACK =
  '반드시 아래 형식의 JSON 하나만 출력하라. 코드블록 표시나 다른 설명 문장을 붙이지 마라:\n' +
  `{${BUBBLE_SPEC},${MINIMAL_REPORT_SPEC},` +
  '"action":"BUY|SELL 중 하나(HOLD 금지)","confidence":0-100 사이 정수,' +
  '"entry":"진입가 또는 진입 조건","stop":"손절가","target":"목표가","rationale":"판정 근거 2-3문장, 150자 이내(한국어)",' +
  '"scalp":{"bias":"LONG 또는 SHORT (PASS 절대 금지)","entry":"진입 트리거 가격/조건","stop":"무효화(손절) 레벨",' +
  '"target":"1차 청산 목표","note":"20배 리스크 한 줄(한국어)"}}';

// ---------------------------------------------------------------------------
// 레벨·손익비 규칙 (ACE·PM·BLITZ)
// "지지선 이탈" 같은 서술형 레벨은 riskmath가 숫자로 파싱하지 못해 손익비 계산이
// 통째로 죽는다. 그래서 숫자를 강제하고, 최소 손익비도 프롬프트 단계에서 못박는다.
// ---------------------------------------------------------------------------
const DEFAULT_MIN_RR = 1.5;

// config.js는 v2에서 새로 붙는 모듈이라 없을 수 있다 — 없으면 기본값 1.5를 쓴다.
function minRRValue() {
  try {
    const { loadConfig } = require('./config');
    const cfg = loadConfig();
    const v = cfg && cfg.risk ? cfg.risk.minRR : null;
    if (Number.isFinite(v) && v > 0) return v;
  } catch (_) {
    /* 설정 모듈 없음 — 기본값 사용 */
  }
  return DEFAULT_MIN_RR;
}

const NUMERIC_LEVEL_RULE =
  '[레벨 표기 규칙] 진입·손절·목표는 반드시 구체적 숫자를 포함해 제시하라' +
  '(예: "1,341,000 이탈 시 손절"). 숫자 없이 "지지선 이탈" 같은 서술만 쓰면 안 된다.';

// 최소 손익비 요구. 공격 모드는 관망을 출력할 수 없으므로 대안을 준다.
function minRRRule(attack) {
  const n = minRRValue();
  const head = `[손익비 기준] 목표까지의 거리는 손절까지 거리의 ${n}배 이상이어야 한다. `;
  return (
    head +
    (attack
      ? '그 조건을 만족하는 자리가 없으면 손절 위치와 목표를 다시 잡아 손익비를 맞춰라. ' +
        '그래도 맞출 수 없으면 확신도를 크게 낮추고 그 사실을 rationale에 밝혀라 ' +
        '(이번 런은 공격 모드라 관망을 출력할 수 없다).'
      : '그 조건을 만족하는 자리가 없으면 억지로 만들지 말고 관망(HOLD/PASS)을 택하라.')
  );
}

// 엔진이 riskmath로 계산해 넣어주는 청산 컨텍스트(context.riskInfo)를 프롬프트용
// 문자열로 만든다. 없으면 빈 문자열 — 프롬프트에 아무것도 붙지 않는다.
function formatRiskInfo(info) {
  if (!info) return '';
  if (typeof info === 'string') return info.trim();
  if (Array.isArray(info)) return lines(info, '');
  if (typeof info !== 'object') return '';
  if (Array.isArray(info.lines) && info.lines.length) {
    return info.lines.filter(Boolean).map((s) => String(s)).join('\n');
  }
  // lines가 없으면 숫자 필드에서 직접 만든다.
  const out = [];
  const lev = Number.isFinite(info.leverage) ? info.leverage : null;
  const pct = (v) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : null);
  if (Number.isFinite(info.price)) out.push(`기준가 ${info.price}${info.source ? ` — ${info.source}` : ''}`);
  if (Number.isFinite(info.longLiq)) {
    out.push(`${lev != null ? `${lev}배 ` : ''}롱 청산가 ${info.longLiq}${pct(info.longBufferPct) ? ` (${pct(info.longBufferPct)})` : ''}`);
  }
  if (Number.isFinite(info.shortLiq)) {
    out.push(`${lev != null ? `${lev}배 ` : ''}숏 청산가 ${info.shortLiq}${pct(info.shortBufferPct) ? ` (${pct(info.shortBufferPct)})` : ''}`);
  }
  if (Number.isFinite(info.planLiq)) {
    out.push(`계획 진입가 기준 청산가 ${info.planLiq}${pct(info.planLiqDistPct) ? ` (${pct(info.planLiqDistPct)})` : ''}`);
  }
  return out.join('\n');
}

// 공격 모드 공통 지시 — 방향은 강제하되 리스크 고지는 강제로 남긴다.
const ATTACK_RULE =
  '[공격 모드] 이번 런은 반드시 방향을 고르는 모드다. "관망"·"중립"·"판단 보류"는 금지이며 ' +
  'PASS/HOLD를 출력할 수 없다. 근거가 팽팽하면 조금이라도 우위인 쪽을 골라 확신도로 그 애매함을 표현하라 ' +
  '(우위가 미약하면 confidence를 낮게 준다). 단, 방향을 골랐다고 해서 리스크를 숨기지 마라 — ' +
  '무효화(손절) 레벨과 20배 청산 위험 경고는 반드시 그대로 제시한다.';

function header(meta) {
  if (meta.id === 'research') {
    return (
      `너는 픽셀 트레이딩 플로어의 ${meta.name}(${meta.role})이다. ` +
      '이 팀에서 유일하게 실제 웹 검색(WebSearch)을 쓸 수 있는 자리다.'
    );
  }
  return (
    `너는 픽셀 트레이딩 플로어의 ${meta.name}(${meta.role})이다. ` +
    '아래 제공된 데이터만 사용하고 도구·검색을 쓰지 마라.'
  );
}

// ---------------------------------------------------------------------------
// buildPrompt(id, context) — 역할별 데이터 주입
// context: { market, analystReports?, debateLog? }
// ---------------------------------------------------------------------------
function buildPrompt(id, context = {}) {
  const meta = AGENT_BY_ID[id];
  const market = context.market || {};
  const ind = market.indicators || {};
  const symLine = `대상: ${market.display || market.symbol || '심볼'} (${market.symbol || ''})\n${market.priceLine || '가격 정보 없음'}`;
  const attack = context.mode === 'attack';

  const parts = [header(meta), '', symLine, ''];

  if (id === 'taro') {
    // 스캘핑·공격 모드에서는 실제 체결이 일어나는 차트(USDT 무기한)를 주 재료로 쓰고,
    // 정규장 지표는 참고로만 붙인다.
    const scalping = context.mode === 'scalp' || attack;
    const src = scalping ? scalpSource(market) : null;
    if (src && src.isPerp) {
      parts.push(`[${src.label}]`);
      parts.push(src.priceLine);
      parts.push('');
      parts.push('[체결 차트 기술 지표]');
      parts.push(lines(src.indicatorLines));
      parts.push('');
      parts.push('[체결 차트 인트라데이 요약]');
      parts.push(lines(src.intradayLines));
      parts.push('');
      parts.push('[참고 — 정규장 지표]');
      parts.push(lines(ind.summaryLines));
      parts.push('');
      parts.push(
        '위 데이터를 근거로 추세·모멘텀·지지저항을 분석하라. ' +
          '레벨은 체결 차트 가격으로 제시하고, 정규장 지표는 참고로만 언급하라.'
      );
    } else {
      parts.push('[기술 지표 요약]');
      parts.push(lines(ind.summaryLines));
      parts.push('');
      parts.push('[최근 20일 캔들]');
      parts.push(formatRecentCandles(market.candles, 20));
      parts.push('');
      parts.push('위 기술적 데이터를 근거로 추세·모멘텀·지지저항을 분석하라.');
    }
  } else if (id === 'diana') {
    parts.push('[기본적 데이터]');
    parts.push(lines((market.fundamentals || {}).lines));
    parts.push('');
    parts.push('위 기본적 데이터를 근거로 밸류에이션과 펀더멘털을 분석하라.');
  } else if (id === 'nova') {
    parts.push('[최신 뉴스 헤드라인]');
    parts.push(formatHeadlines((market.news || {}).headlines, true));
    if (market.economicCalendar && Array.isArray(market.economicCalendar.lines)) {
      parts.push('');
      parts.push('[앞으로 예정된 주요 경제지표 발표 — 참고 자료]');
      parts.push(lines(market.economicCalendar.lines));
    }
    parts.push('');
    parts.push('위 뉴스 흐름이 가격에 미칠 영향을 분석하라.');
  } else if (id === 'vibe') {
    parts.push('[센티먼트 지표]');
    parts.push(lines((market.sentiment || {}).lines));
    parts.push('');
    parts.push('[뉴스 제목]');
    parts.push(formatHeadlines((market.news || {}).headlines, false));
    parts.push('');
    parts.push('위 심리·여론 데이터를 근거로 투자 심리를 분석하라.');
  } else if (id === 'research') {
    parts.push(
      `WebSearch 도구를 사용해 "${market.display || market.symbol}"과 관련된 ` +
        '최근 애널리스트 리포트·논문·주요 매체 기사를 2~4건 찾아라.'
    );
    parts.push('');
    parts.push(
      '[출력 규칙] 실제로 검색해 찾은 내용만 써라. 각 자료마다 매체/저자와 핵심 주장을 ' +
        '한두 문장으로 요약하고, report 끝에 "출처:"로 시작하는 줄에 찾은 자료의 ' +
        '제목과 URL을 나열하라. 검색이 실패했거나 관련 자료를 찾지 못했으면 지어내지 말고 ' +
        'bubble·report 모두에 "관련 외부 자료 없음"이라고 명시하라. 저작권 보호를 위해 ' +
        '원문을 그대로 옮기지 말고 반드시 네 표현으로 요약하라.'
    );
  } else if (id === 'bull' || id === 'bear') {
    const stance =
      id === 'bull'
        ? '너는 강세론자(BULL)다. 위 데이터로 매수 논거를 강하게 제시하라.'
        : '너는 약세론자(BEAR)다. 위 데이터로 매도 논거를 강하게 제시하라.';
    const rival = id === 'bull' ? '약세론자(BEAR)' : '강세론자(BULL)';
    parts.push('[애널리스트 리포트]');
    parts.push(formatAnalystReports(context.analystReports));
    const strat = formatStrategy(context.strategyReport);
    if (strat) {
      parts.push('');
      parts.push('[수석 전략가 종합]');
      parts.push(strat);
    }
    parts.push('');
    parts.push('[진행된 토론]');
    parts.push(formatDebateLog(context.debateLog));
    parts.push('');
    parts.push(stance);
    parts.push(
      `[진행된 토론]의 가장 최근 ${rival} 발언을 구체적으로 지목해 반박하라. ` +
        'bubble과 report 모두에 반박 논지를 담아라.'
    );
  } else if (id === 'risky' || id === 'neutral' || id === 'safe') {
    // 논문의 Risk Management team — 트레이더 계획을 성향별로 심사하고 서로 반박한다.
    const STANCE = {
      risky:
        '너는 공격적 리스크 심사자(RISKY)다. 기회를 놓치는 비용(기회비용)을 최우선으로 본다. ' +
        '이 계획이 지나치게 보수적이지 않은지, 비중을 키우거나 목표를 더 멀리 잡을 근거가 있는지 주장하라. ' +
        '다만 손실 한도를 무시하라는 뜻은 아니다 — 감당 가능한 최대 리스크를 명시하라.',
      safe:
        '너는 보수적 리스크 심사자(SAFE)다. 자본 보존과 꼬리위험(tail risk)을 최우선으로 본다. ' +
        '이 계획에서 최악의 시나리오가 무엇이고 그때 손실이 얼마인지 계산해 제시하고, ' +
        '비중 축소·손절 상향·진입 보류 중 무엇이 필요한지 분명히 주장하라.',
      neutral:
        '너는 중립적 리스크 심사자(NEUTRAL)다. 앞선 두 심사자의 주장을 각각 인용해 어디까지 타당하고 ' +
        '어디서 과장인지 가르고, 양쪽을 절충한 조건부 승인안(어떤 조건이면 진행, 어떤 조건이면 축소·기각)을 제시하라.',
    };
    parts.push('[애널리스트 리포트]');
    parts.push(formatAnalystReports(context.analystReports));
    const stratRisk = formatStrategy(context.strategyReport);
    if (stratRisk) {
      parts.push('');
      parts.push('[수석 전략가 종합]');
      parts.push(stratRisk);
    }
    parts.push('');
    if (context.debateLog && context.debateLog.length) {
      parts.push('[리서치 토론 로그]');
      parts.push(formatDebateLog(context.debateLog));
      parts.push('');
    }
    parts.push('[수석 트레이더의 1차 계획]');
    parts.push(formatTraderPlan(context.traderPlan));
    parts.push('');
    const priorRisk = formatRiskReports(context.riskReports, id);
    if (priorRisk) {
      parts.push('[앞선 리스크 심사 의견]');
      parts.push(priorRisk);
      parts.push('');
      parts.push('위 의견을 반드시 직접 인용해 동의 또는 반박하라.');
      parts.push('');
    }
    const tlr = tapbitLine(market);
    if (tlr) {
      parts.push(tlr);
      parts.push('');
    }
    // 엔진이 riskmath로 계산해 넣어준 청산가·청산까지 거리.
    // SAFE가 최악 시나리오를 숫자로 계산해야 하므로 위원회 전원에게 같은 값을 준다
    // (심사자마다 다른 숫자를 지어내면 토론 자체가 성립하지 않는다).
    const riskRisk = formatRiskInfo(context.riskInfo);
    if (riskRisk) {
      parts.push('[청산 계산 — 엔진이 riskmath로 계산한 값]');
      parts.push(riskRisk);
      parts.push('');
      parts.push('위 청산가와 청산까지 거리는 계산된 값이다. 그대로 인용하고 다시 지어내지 마라.');
      parts.push('');
    }
    parts.push(STANCE[id]);
    parts.push(
      '레버리지는 1배로 고정이다(청산 위험이 사실상 없는 구조). "몇 배 레버리지"를 언급하지 말고, ' +
        '대신 손절이 실제로 체결됐을 때의 손실 금액·비중(계좌 대비 %)을 구체적으로 짚어라.'
    );
  } else if (id === 'pm') {
    // 논문의 Portfolio Manager — 최종 관문.
    parts.push('[애널리스트 리포트]');
    parts.push(formatAnalystReports(context.analystReports));
    const stratPm = formatStrategy(context.strategyReport);
    if (stratPm) {
      parts.push('');
      parts.push('[수석 전략가 종합]');
      parts.push(stratPm);
    }
    parts.push('');
    if (context.debateLog && context.debateLog.length) {
      parts.push('[리서치 토론 로그]');
      parts.push(formatDebateLog(context.debateLog));
      parts.push('');
    }
    parts.push('[수석 트레이더의 1차 계획]');
    parts.push(formatTraderPlan(context.traderPlan));
    parts.push('');
    parts.push('[리스크 위원회 심사 의견]');
    parts.push(formatRiskReports(context.riskReports) || '(없음)');
    parts.push('');
    const mem = formatMemory(context.memory);
    if (mem) {
      parts.push('[과거 판정 회고]');
      parts.push(mem);
      parts.push('');
      parts.push(MEMORY_RULE);
      parts.push('');
    }
    const tlp = tapbitLine(market);
    if (tlp) {
      parts.push(tlp);
      parts.push('');
    }
    parts.push(
      '너는 포트폴리오 매니저(PM)다. 리스크 위원회 의견을 종합해 트레이더의 계획을 ' +
        '승인(APPROVE)·수정승인(AMEND)·기각(REJECT) 중 하나로 판정하는 최종 관문이다. ' +
        'AMEND라면 원래 계획의 무엇을 어떻게 바꿨는지(진입·손절·목표·비중) rationale에 분명히 밝혀라. ' +
        'REJECT라면 action을 HOLD로 두고 기각 사유를 밝혀라. ' +
        'sizing에는 계좌 대비 권장 비중을 한 줄로 제시하라(리스크 2% 룰 기준).'
    );
    parts.push(NUMERIC_LEVEL_RULE);
    parts.push(minRRRule(attack));
  } else if (id === 'ace') {
    const tl = tapbitLine(market);
    const mem = formatMemory(context.memory);
    if (mem) {
      parts.push('[과거 판정 회고]');
      parts.push(mem);
      parts.push('');
      parts.push(MEMORY_RULE);
      parts.push('');
    }
    // 스캘핑 데스크가 돌지 않은 런(알고리즘 모드)에서는 scalp 관련 주입·요구를 생략한다.
    const hasScalp = !!(
      context.scalpReports &&
      (context.scalpReports.blitz || context.scalpReports.guard)
    );
    parts.push('[애널리스트 리포트]');
    parts.push(formatAnalystReports(context.analystReports));
    const stratAce = formatStrategy(context.strategyReport);
    if (stratAce) {
      parts.push('');
      parts.push('[수석 전략가 종합]');
      parts.push(stratAce);
    }
    parts.push('');
    if (context.debateLog && context.debateLog.length) {
      parts.push('[전체 토론 로그]');
      parts.push(formatDebateLog(context.debateLog));
      parts.push('');
    }
    if (hasScalp) {
      parts.push('[스캘핑 데스크 리포트 (20x)]');
      parts.push(formatScalpReports(context.scalpReports));
      parts.push('');
    }
    if (tl) {
      parts.push(tl);
      parts.push('');
    }
    if (hasScalp) {
      const { parts: chart, src } = scalpChartBlock(market);
      parts.push(...chart);
      parts.push('');
      if (src.isPerp) {
        parts.push(
          'scalp 레벨은 위 체결 차트(USDT)의 가격으로 내고, action/entry/stop/target(스윙)은 ' +
            '정규장 원화 기준으로 낸다 — 두 축을 섞지 마라.'
        );
        parts.push('');
      }
    }
    if (attack) parts.push(ATTACK_RULE);
    parts.push(
      '너는 수석 트레이더(ACE)다. 위 모든 분석과 토론을 종합해 최종 매매 판정을 내려라. ' +
        (attack
          ? 'action은 반드시 BUY 또는 SELL 중 하나다(HOLD 금지). confidence는 0~100 정수이며, ' +
            '근거가 팽팽할수록 낮게 준다.'
          : 'action은 반드시 BUY, SELL, HOLD 중 하나여야 하고 confidence는 0~100 정수다.')
    );
    if (hasScalp) {
      parts.push(
        'action/confidence/entry/stop/target/rationale는 현물·스윙(중장기) 관점의 판정이다. ' +
          '이와 별도로 scalp 필드에는 탭비트 20배 무기한 선물 단타 관점의 판정을 담아라. ' +
          (attack
            ? 'scalp.bias는 LONG 또는 SHORT 중 하나다 — PASS는 출력할 수 없다. '
            : 'scalp.bias는 LONG, SHORT, PASS 중 하나이고, ') +
          'entry(진입 트리거)·stop(무효화 레벨)·' +
          'target(1차 청산 목표)은 스캘핑 데스크(BLITZ·GUARD) 리포트를 반영한 구체적 숫자로, ' +
          'note는 20배 리스크를 한 줄로 요약하라.'
      );
    }
    parts.push(NUMERIC_LEVEL_RULE);
    parts.push(minRRRule(attack));
    parts.push('');
    // ACE의 report는 뒷단계가 읽지 않는다(traderPlan에 안 들어감) — 최소 규칙 적용.
    parts.push(MINIMAL_REPORT_RULE);
    parts.push('');
    parts.push(hasScalp ? (attack ? OUTPUT_ACE_ATTACK : OUTPUT_ACE) : OUTPUT_ACE_CORE);
    return parts.join('\n');
  }

  parts.push('');
  // PM의 report는 최종 단계라 아무도 읽지 않는다 — 최소 규칙 적용. 그 외 역할(1층
  // 애널리스트·BULL/BEAR·리스크 위원회)은 report를 뒷단계가 실제로 읽으므로 기존 유지.
  parts.push(id === 'pm' ? MINIMAL_REPORT_RULE : BRIEFING_RULE);
  parts.push('');
  parts.push(id === 'pm' ? OUTPUT_PM : OUTPUT_BASIC);
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// claude 스폰
// ---------------------------------------------------------------------------
// claude를 어느 폴더에서 실행할지.
// 프로젝트 폴더에서 실행하면 "이 폴더의 파일을 신뢰합니까?" 게이트에 걸릴 수 있는데,
// -p(비대화형)에는 답할 사람이 없어 출력이 통째로 비어버린다.
// 에이전트는 프롬프트를 stdin으로만 받으므로 작업 폴더가 필요 없다 →
// 사용자가 처음 로그인하며 이미 승인했을 홈 디렉터리에서 실행한다.
const CLAUDE_CWD = require('node:os').homedir();

// claude 실행 파일 위치.
// 흔한 함정: Claude Code를 설치한 뒤 PATH가 갱신되기 전에 열려 있던 창(탐색기 포함)에서
// 서버를 켜면, 그 프로세스는 claude를 영영 못 찾는다. 터미널에서는 잘 되는데 앱만 안 되는
// 상태가 이것이다. 그래서 PATH에서 못 찾으면 표준 설치 경로들을 직접 뒤진다.
const CLAUDE_CANDIDATES = [
  path.join(CLAUDE_CWD, '.local', 'bin', 'claude.exe'), // 네이티브 설치
  path.join(CLAUDE_CWD, '.local', 'bin', 'claude'),
  path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'), // npm -g
  path.join(process.env.APPDATA || '', 'npm', 'claude'),
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'claude.exe'), // winget
];

// 에이전트 모델 — 환경변수 FLOOR_MODEL 로 교체 가능 (기본 opus)
const FLOOR_MODEL = (process.env.FLOOR_MODEL || 'opus').replace(/[^a-z0-9.-]/gi, '');

let claudeBin = null; // 확정된 실행 경로(따옴표 포함) 또는 'claude'

function quoted(p) {
  return /\s/.test(p) ? `"${p}"` : p;
}

// PATH의 claude가 동작하면 그대로, 아니면 후보 경로 중 실제로 존재하는 것을 쓴다.
function resolveClaudeBin() {
  if (claudeBin) return claudeBin;
  for (const c of CLAUDE_CANDIDATES) {
    if (!c) continue;
    try {
      if (fs.existsSync(c)) {
        claudeBin = quoted(c);
        return claudeBin;
      }
    } catch {
      /* 무시 */
    }
  }
  claudeBin = 'claude';
  return claudeBin;
}

function spawnClaude(prompt, extraArgs = '', timeoutMs = SPAWN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const cmd = `${resolveClaudeBin()} -p --model ${FLOOR_MODEL} --output-format json${extraArgs ? ` ${extraArgs}` : ''}`;
    const child = spawn(cmd, { shell: true, cwd: CLAUDE_CWD });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 무시 */
      }
      finish({ stdout, stderr, timedOut: true, code: null });
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err && err.message ? err.message : String(err)}`;
      finish({ stdout, stderr, code: null, error: err });
    });
    child.on('close', (code) => {
      finish({ stdout, stderr, code });
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      stderr += `\n[stdin error] ${err && err.message ? err.message : String(err)}`;
      finish({ stdout, stderr, code: null, error: err });
    }
  });
}

// 파싱 결과를 표준화: bubble/report 문자열 보장, 나머지 필드(action 등)는 그대로 통과
function normalizeResult(parsed) {
  const out = { ...parsed };
  out.bubble = typeof parsed.bubble === 'string' && parsed.bubble.trim() ? parsed.bubble.trim() : '분석 완료';
  out.report = typeof parsed.report === 'string' ? parsed.report : '';
  return out;
}

// 실전 런 직전 1회 점검 — claude CLI가 실제로 응답하는지 확인한다.
// 없거나 막혀 있으면 에이전트 13명을 헛돌리는 대신 즉시 원인을 알려준다.
let claudeCheck = null; // { ok, message, ts }
const CHECK_TTL_MS = 5 * 60 * 1000;

function checkClaudeAvailable() {
  const now = Date.now();
  if (claudeCheck && now - claudeCheck.ts < CHECK_TTL_MS && claudeCheck.ok) {
    return Promise.resolve(claudeCheck);
  }
  return new Promise((resolve) => {
    const child = spawn(`${resolveClaudeBin()} --version`, { shell: true, cwd: CLAUDE_CWD });
    let out = '';
    let err = '';
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      claudeCheck = { ...res, ts: Date.now() };
      resolve(claudeCheck);
    };
    const t = setTimeout(() => {
      try { child.kill(); } catch { /* 무시 */ }
      finish({ ok: false, message: 'claude 응답이 없습니다(15초 초과). 터미널에서 `claude --version`을 직접 실행해 확인하세요.' });
    }, 15000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', () => {
      finish({ ok: false, message: 'claude 명령을 실행할 수 없습니다. Claude Code가 설치돼 있고 PATH에 있는지 확인하세요.' });
    });
    child.on('close', (code) => {
      if (code === 0 && /\d+\.\d+/.test(out)) {
        finish({ ok: true, message: out.trim() });
      } else {
        finish({
          ok: false,
          message:
            'claude를 찾지 못했거나 실행에 실패했습니다(종료코드 ' + code + '). ' +
            `Claude Code 설치 후 서버를 새 터미널에서 다시 켜세요. (시도한 실행 경로: ${resolveClaudeBin()})` +
            (err.trim() ? ` [${err.trim().slice(0, 200)}]` : ''),
        });
      }
    });
  });
}

// 사용량 한도 메시지인가 — 이 실패는 재시도해도 똑같이 실패한다. 1차 프로젝트에서 한도
// 실패마다 1회씩 재시도해 헛돈 호출이 2배로 늘었다(docs/03-POSTMORTEM.md 원인 1).
function isSessionLimitOutput(text) {
  return /session limit|usage limit|rate limit/i.test(String(text || ''));
}

// 시간대 이름(IANA, 예: Asia/Seoul)의 특정 시각 UTC 오프셋(분). UTC/GMT 또는 모르는 이름이면 0.
function tzOffsetMinutes(tz, atMs) {
  if (!tz || /^(utc|gmt)$/i.test(tz.trim())) return 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz.trim(),
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(atMs));
    const get = (t) => Number(parts.find((p) => p.type === t).value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((asUtc - atMs) / 60000);
  } catch (_) {
    return 0; // 모르는 시간대 → UTC 로 간주 (지어내지 않는다)
  }
}

// "resets 6:30pm (UTC)" · "resets 12am (Asia/Seoul)" · "resets 11:30pm (UTC)" 에서 리셋 시각을
// epoch ms로 파싱한다. 분이 없으면 :00, 괄호 안은 UTC 또는 IANA 시간대 이름이다. 그 시간대
// 기준 '오늘'의 그 시각으로 읽고, 이미 지났으면(자정을 넘겨 리셋) 내일로 해석한다.
// 못 찾으면 null — 지어내지 않는다. (실측 문구: docs/03-POSTMORTEM.md)
function parseSessionLimitResetTime(text, now) {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i.exec(String(text || ''));
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3].toLowerCase();
  if (ampm === 'pm' && hour !== 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  const n = Number.isFinite(now) ? now : Date.now();
  const offsetMin = tzOffsetMinutes(m[4], n);
  const local = new Date(n + offsetMin * 60000); // 그 시간대의 '오늘' 날짜
  let reset =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute, 0) -
    offsetMin * 60000;
  if (reset <= n) reset += 24 * 60 * 60 * 1000;
  return reset;
}

// 실패 원인을 사람이 읽을 수 있는 한 줄로 추정한다.
// (화면에서 말풍선을 클릭하면 이 진단이 그대로 보인다)
function diagnose({ stdout, stderr, code, timedOut }) {
  const err = String(stderr || '');
  const out = String(stdout || '');
  const all = err + '\n' + out;
  if (timedOut) {
    return 'claude 응답이 180초를 넘겨 중단됐습니다. 네트워크가 느리거나 모델이 과부하일 수 있습니다.';
  }
  if (/not recognized|command not found|ENOENT|찾을 수 없습니다/i.test(all)) {
    return 'claude 명령을 찾지 못했습니다. Claude Code를 설치했는지, 설치 후 서버를 새 터미널에서 다시 켰는지 확인하세요.';
  }
  if (/login|log in|authenticat|Unauthorized|401|credit balance|api key/i.test(all)) {
    return 'claude 인증 문제로 보입니다. 터미널에서 `claude` 실행 후 로그인 상태(/status)를 확인하세요.';
  }
  if (/trust|신뢰|permission|권한/i.test(all)) {
    return '폴더 신뢰·권한 승인 단계에서 막힌 것으로 보입니다. 해당 폴더에서 `claude`를 한 번 직접 실행해 신뢰를 승인하세요.';
  }
  // "session limit"은 "rate limit/usage limit/quota/한도"와 문구 자체가 달라서
  // 기존 정규식에 안 걸렸다 — 실전에서 이것 때문에 한도 문제가 전부 "JSON 형식
  // 오류"라는 엉뚱한 진단으로 잘못 표시되고 있었다(2026-09-22 실전에서 발견).
  if (/rate limit|usage limit|session limit|quota|한도/i.test(all) || /"api_error_status"\s*:\s*429/.test(all)) {
    return '사용량 한도에 걸린 것으로 보입니다. 잠시 후 다시 시도하거나 /model 로 가벼운 모델을 선택하세요.';
  }
  if (!out.trim()) {
    return `claude가 아무 응답도 내지 않았습니다(종료코드 ${code == null ? '없음' : code}). 터미널에서 \`echo hi | claude -p\` 로 직접 확인해 보세요.`;
  }
  return 'claude는 응답했지만 JSON 형식이 아니었습니다. 아래 원문을 확인하세요.';
}

// RESEARCH만 실제 웹 검색을 쓴다 — 헤드리스(-p) 모드는 사전 승인 없인 도구를 쓸 수
// 없으므로 이 에이전트에만 --allowedTools를 붙인다. 검색은 시간이 더 걸릴 수 있어
// 타임아웃도 따로 넉넉하게 준다.
const RESEARCH_EXTRA_ARGS = '--allowedTools "WebSearch"';
const RESEARCH_TIMEOUT_MS = 240000; // 240초

// claude CLI를 --output-format json으로 부르면 실제 에이전트 응답이 바로 stdout에
// 오는 게 아니라, { result, total_cost_usd, usage: {input_tokens, output_tokens}, ... }
// 겉포장 안에 들어있다(.result가 실제 텍스트). 이 겉포장을 벗겨서 실제 텍스트와
// 사용량을 분리한다 — API 전환 여부를 결정하기 위해 "진짜 비용이 얼마인지" 데이터를
// 모으는 용도다(감으로 어림잡지 않기 위해).
//
// 겉포장 파싱이 실패하면(CLI 버전 차이, 우연히 텍스트 모드로 실행됨 등) 원본 stdout을
// 그대로 innerText로 돌려준다 — 그러면 extractJson()이 예전처럼 원본에서 직접 파싱을
// 시도하므로, 이 사용량 수집 기능이 실패해도 핵심 분석 파이프라인 자체는 안 끊긴다.
function parseClaudeCliOutput(stdout) {
  const text = String(stdout || '');
  let wrapper;
  try {
    wrapper = JSON.parse(text);
  } catch (e) {
    return { innerText: text, usage: null, costUsd: null, isWrapperFormat: false };
  }
  if (!wrapper || typeof wrapper.result !== 'string') {
    return { innerText: text, usage: null, costUsd: null, isWrapperFormat: false };
  }
  const u = wrapper.usage;
  const usage =
    u && typeof u === 'object'
      ? {
          // 입력은 캐시 여부에 따라 세 항목으로 쪼개져 온다 — input_tokens만 보면 실제
          // 입력량의 극히 일부만 잡힌다(실측: 12명 분석에 input_tokens 32개로 찍힘).
          // 세 항목을 합쳐야 실제로 읽힌 입력량이 된다. 비용(total_cost_usd)은 원래
          // 캐시 할인까지 반영된 정확한 값이라 이 수정과 무관하다.
          inputTokens: [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].some(Number.isFinite)
            ? [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens]
                .filter(Number.isFinite)
                .reduce((a, b) => a + b, 0)
            : null,
          outputTokens: Number.isFinite(u.output_tokens) ? u.output_tokens : null,
        }
      : null;
  const costUsd = Number.isFinite(wrapper.total_cost_usd) ? wrapper.total_cost_usd : null;
  // 한도·API 오류는 겉포장에 구조적으로 표시된다 — 실측(2026-09-26, Lightsail):
  //   {"is_error":true,"terminal_reason":"api_error","api_error_status":429,
  //    "result":"You've hit your session limit · resets 8pm (Asia/Seoul)", ...}  (종료코드 0!)
  // 문구가 바뀌어도 429 는 남으므로 둘 다 본다.
  const apiErrorStatus = Number.isFinite(Number(wrapper.api_error_status)) ? Number(wrapper.api_error_status) : null;
  return {
    innerText: wrapper.result,
    usage,
    costUsd,
    isWrapperFormat: true,
    isError: wrapper.is_error === true,
    apiErrorStatus,
  };
}

// 이 응답이 사용량 한도인가 — 겉포장의 429 또는 본문 문구. 재시도해도 소용없는 실패.
function isSessionLimitResponse(res, cliParsed) {
  if (cliParsed && cliParsed.isError && cliParsed.apiErrorStatus === 429) return true;
  return isSessionLimitOutput(String((res && res.stdout) || '') + String((res && res.stderr) || ''));
}

// 테스트에서 claude 스폰을 가짜로 바꾸는 훅. 인자 없이 부르면 원복.
let spawnImpl = null;
function _setSpawnImpl(fn) {
  spawnImpl = typeof fn === 'function' ? fn : null;
}

async function runAgentReal(id, prompt) {
  const extraArgs = id === 'research' ? RESEARCH_EXTRA_ARGS : '';
  const timeoutMs = id === 'research' ? RESEARCH_TIMEOUT_MS : SPAWN_TIMEOUT_MS;
  let last = { stdout: '', stderr: '', code: null, timedOut: false };
  // 최초 시도 + 실패 시 1회 재시도 = 최대 2회. 단, 사용량 한도면 재시도하지 않는다.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await (spawnImpl || spawnClaude)(prompt, extraArgs, timeoutMs);
    last = res;
    if (res.stderr && res.stderr.trim()) {
      console.error(`[agent:${id}] stderr: ${res.stderr.trim()}`);
    }
    const cliParsed = parseClaudeCliOutput(res.stdout);
    const parsed = extractJson(cliParsed.innerText);
    if (parsed) {
      const normalized = normalizeResult(parsed);
      // 사용량 정보를 결과에 실어 보낸다 — engine.js가 이걸 모아서 실행 하나당
      // 실제 비용을 집계할 수 있게 한다. 겉포장 파싱이 안 됐으면(예전 텍스트 모드로
      // 우연히 응답한 경우) null — 지어내지 않는다.
      normalized._usage = { costUsd: cliParsed.costUsd, usage: cliParsed.usage };
      return normalized;
    }
    console.error(
      `[agent:${id}] 파싱 실패 (시도 ${attempt + 1}/2, 종료코드 ${res.code}, stdout ${String(res.stdout || '').length}자)`
    );
    if (isSessionLimitResponse(res, cliParsed)) {
      console.error(`[agent:${id}] 사용량 한도(429) — 재시도하지 않습니다`);
      break;
    }
  }
  // 화면·리포트에서 바로 원인을 볼 수 있도록 진단 + 원문을 함께 남긴다
  const hint = diagnose(last);
  const detail = [
    `원인 추정: ${hint}`,
    '',
    `종료코드: ${last.code == null ? '(없음)' : last.code}${last.timedOut ? ' · 타임아웃' : ''}`,
    `stderr: ${String(last.stderr || '(없음)').trim().slice(0, 600)}`,
    `stdout: ${String(last.stdout || '(없음)').trim().slice(0, 600)}`,
  ].join('\n');
  // 한도 소진이면 리셋 시각을 같이 실어 보낸다 — engine.js가 이걸 보고 "이후 단계는
  // 생략(어차피 똑같이 실패한다)"와 "다음 트리거들은 그 시각까지 새로 시도하지 않는다"
  // 판단을 할 수 있게 한다. 못 찾으면 null(지어내지 않는다) — 그래도 실패 자체는
  // 안전하게 처리된다.
  const quotaExhaustedUntil = parseSessionLimitResetTime(String(last.stdout || '') + String(last.stderr || ''), Date.now());
  return { bubble: '분석 실패 — 말풍선을 클릭해 원인을 확인하세요', report: detail, quotaExhaustedUntil };
}

// ---------------------------------------------------------------------------
// mock 응답 (데모용 고정 한국어 문구, 심볼 치환)
//
// 데모라도 진입·손절·목표에 숫자가 없으면 리스크 게이트가 손익비를 계산하지 못해
// 화면 절반이 "데이터 없음"으로 비어버린다. 그래서 레벨은 실제로 수집된 현재가에서
// ±%로 만든다(데모 모드에서도 market 수집은 진짜로 돈다).
// 가격을 못 구하면 null을 돌려주고 기존 서술형 문구를 그대로 쓴다 — 숫자를 지어내지 않는다.
// ---------------------------------------------------------------------------

// 사람이 읽는 가격 표기: 1000 이상은 정수+콤마, 작을수록 소수 자리를 늘린다.
function fmtNum(v) {
  if (!Number.isFinite(v)) return null;
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 1 ? 2 : 4;
  const [int, frac] = v.toFixed(digits).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

// 기준가. preferPerp면 실제 체결이 일어나는 USDT 무기한을 먼저 본다.
function mockRefPrice(market, preferPerp) {
  const m = market || {};
  if (preferPerp) {
    const p = m.perp && m.perp.indicators ? m.perp.indicators.price : null;
    if (Number.isFinite(p)) return p;
  }
  const i = m.indicators || {};
  if (Number.isFinite(i.price)) return i.price;
  const c = Array.isArray(m.candles) && m.candles.length ? m.candles[m.candles.length - 1] : null;
  if (c && Number.isFinite(c.c)) return c.c;
  return null;
}

// 스윙(정규장) 레벨 — 손절 -2.5%, 목표 +5.0% → 손익비 2.0
function mockSwingLevels(market) {
  const p = mockRefPrice(market, false);
  if (!Number.isFinite(p) || p <= 0) return null;
  return {
    price: p,
    entry: fmtNum(p),
    stop: fmtNum(p * 0.975),
    tightStop: fmtNum(p * 0.982), // PM이 손절을 한 단계 앞당긴 자리 (손익비 2.78)
    target: fmtNum(p * 1.05),
  };
}

function mockResult(id, context = {}) {
  const market = (context && context.market) || {};
  const sym = market.display || market.symbol || '심볼';
  const SW = mockSwingLevels(market);
  const table = {
    taro: {
      bubble: `${sym} 20일선에서 지지 시험 중입니다. RSI는 중립, MACD는 축소 국면 — 거래량 붙는 쪽으로 방향이 갈립니다.`,
      report: `${sym}의 단기 추세는 20일 이동평균선 부근에서 지지받는 형태입니다. 종가가 20일선 위를 지키는 동안은 눌림목 구조로 읽히고, 50일선까지의 이격이 크지 않아 중기 추세도 훼손되지 않았습니다. RSI는 중립 구간이라 과매수·과매도 어느 쪽으로도 치우치지 않았고, MACD 히스토그램은 음전환 폭이 줄어드는 축소 국면입니다. 이는 하락 모멘텀이 약해지고는 있으나 아직 상방으로 전환됐다고 확정할 단계는 아니라는 뜻입니다. 최근 20일 고점이 1차 저항, 20일 저점이 1차 지지로 작동하고 있습니다. 반대 시나리오로는 거래량 없는 반등에 그쳐 20일선을 다시 하회하는 경우이며, 그때는 저점 재확인까지 열어둬야 합니다. 판단이 바뀌는 트리거는 명확합니다 — 거래량을 동반한 20일선 상향 회복이면 상방, 20일 저점 종가 이탈이면 하방으로 재설정합니다. 그 전까지는 방향을 확정하지 않고 레벨만 지켜보는 것이 합리적입니다.`,
    },
    diana: {
      bubble: `${sym} 밸류에이션 부담은 제한적입니다. 다만 내재가치 산정이 어려운 자산이라 싸다는 게 하방 보증은 아닙니다.`,
      report: `${sym}의 기본 체력은 양호한 편입니다. 시가총액 대비 거래대금 회전율이 건전한 수준이라 유동성 측면의 문제는 보이지 않습니다. 52주 고점 대비 조정폭을 감안하면 밸류에이션 부담은 과도하지 않은 구간으로 판단됩니다. 다만 이 자산군은 현금흐름 기반 내재가치 산정이 어려워, 밸류에이션 논거만으로 방향을 정하는 것은 위험합니다. 즉 "싸다"는 판단은 하방이 없다는 보증이 아니라 기대수익이 개선됐다는 뜻일 뿐입니다. 반대 시나리오는 거시 긴축이나 업종 수요 둔화가 확인되며 실적 전망 자체가 하향되는 경우이고, 그때는 현재 가격도 비싸질 수 있습니다. 판단이 바뀌는 트리거는 실적·수요 지표의 방향 전환과 자금 유출입 흐름입니다. 결론적으로 펀더멘털은 중립~우호적이나 단기 방향은 수급과 매크로가 좌우한다고 봅니다.`,
    },
    nova: {
      bubble: `${sym} 뉴스는 호악재 혼조입니다. 좋은 지표에도 주가가 안 따라오는 게 핵심 — 기대가 선반영됐다는 신호입니다.`,
      report: `${sym}를 둘러싼 최근 뉴스 흐름은 호재와 악재가 뚜렷하게 혼재합니다. 수급 측면의 우호적 재료가 하방을 방어하는 반면, 거시 금리와 규제 관련 헤드라인이 상방을 제한하는 구도입니다. 특징적인 점은 실적이나 지표가 좋게 나와도 주가가 그에 비례해 반응하지 않는다는 것이고, 이는 시장이 이미 기대를 선반영했거나 피크아웃을 경계하고 있다는 신호로 읽힙니다. 헤드라인 민감도가 높아진 국면이라 재료 하나에 일중 변동폭이 크게 벌어질 수 있습니다. 반대 시나리오는 악재가 소멸하면서 눌려 있던 수급이 한 번에 되돌려지는 경우입니다. 판단이 바뀌는 트리거는 금리·정책 이벤트 결과와 기관 자금 흐름의 방향 전환입니다. 이벤트 창 안에서는 포지션을 키우지 않는 것이 안전하다고 봅니다. 재료가 정리된 뒤 첫 방향을 확인하고 따라가는 편이 승률이 높습니다.`,
    },
    vibe: {
      bubble: `${sym} 심리가 한쪽으로 쏠렸습니다. 극단값은 반전 전조지만 타이밍은 주지 않으니 진입 근거는 가격에서 찾아야 합니다.`,
      report: `${sym}에 대한 시장 심리는 한쪽으로 기운 상태입니다. 공포탐욕지수와 헤드라인 톤을 함께 보면 투자자들이 가격 움직임보다 과하게 반응하고 있다는 인상이 강합니다. 심리 지표의 극단값은 반전의 전조가 되기도 하지만, 그 자체로는 타이밍을 주지 않는다는 점이 중요합니다. 즉 과열이라고 곧바로 반대 포지션을 잡는 것은 근거가 약합니다. 지금은 "가격은 버티는데 심리는 위축" 또는 "가격은 오르는데 심리는 과열"처럼 가격과 심리가 어긋나는 국면이며, 이런 구간에서는 변동성이 커지기 쉽습니다. 반대 시나리오는 심리가 극단에서 되돌아오며 가격이 그 방향으로 추세를 이어가는 경우입니다. 판단이 바뀌는 트리거는 심리 지표가 중립 구간으로 회귀하는지, 그리고 그때 가격이 어느 레벨을 지키고 있는지입니다. 심리는 확인 지표로만 쓰고 진입 근거는 가격 레벨에서 찾는 편이 안전합니다.`,
    },
    research: {
      bubble: `(데모) 실제 실행 시 이 자리에서 WebSearch로 찾은 논문·기사 요약과 출처가 표시됩니다.`,
      report: `이것은 데모(목업) 응답입니다. 실전 모드에서 RESEARCH 데스크는 claude CLI의 WebSearch 도구를 실제로 호출해 ${sym}와 관련된 최근 애널리스트 리포트, 뉴스 기사, 공개된 논문 등을 검색합니다. 찾은 자료가 있으면 매체·저자와 핵심 주장을 요약하고, report 끝에 "출처:" 목록으로 제목과 URL을 남깁니다. 검색해도 관련 자료를 찾지 못하면 지어내지 않고 "관련 외부 자료 없음"이라고 솔직히 밝히도록 프롬프트에 명시돼 있습니다. 데모 모드에서는 실제 네트워크 호출이 일어나지 않으므로 이 문단이 고정 안내문으로 대체된 것입니다. 실전 모드에서 이 데스크가 정상 작동하려면 claude CLI가 WebSearch 도구를 사용할 수 있는 계정으로 로그인돼 있어야 합니다.`,
    },
    bull: {
      bubble: `${sym} 눌림목 매수가 유효합니다. 기대수익 대비 리스크가 개선됐고 수급이 하방을 막고 있어 상방 우위로 봅니다.`,
      report: `${sym}는 주요 이동평균선에서 지지를 확인했고, 하방보다 상방 여력이 크다고 봅니다. 첫째, 조정폭이 이미 상당해 기대수익 대비 감수하는 리스크가 개선됐습니다. 둘째, 기관·수급 측면의 우호적 재료가 실시간으로 하방을 방어하고 있어 투매가 연장될 근거가 약합니다. 셋째, 지표상 과매도에 가까운 구간이라 반등 시 매물대가 얇아 상승 속도가 빠를 수 있습니다. 약세론자가 지적하는 과열·모멘텀 훼손은 추세장에서 흔한 되돌림 수준이며, 추세 전환의 증거로 보기엔 아직 부족합니다. 물론 지지선이 종가로 깨지면 제 논거는 무효이고, 그 경우 다음 지지까지 열어둬야 한다는 점은 인정합니다. 그래서 한 번에 전량 진입이 아니라 지지 확인 후 분할 매수로 대응할 것을 제안합니다. 판단 전환 트리거는 지지선 종가 이탈이며, 상방 확인 트리거는 거래량을 동반한 20일선 회복입니다.`,
    },
    bear: {
      bubble: `${sym} 조정폭이 크다는 건 하락 추세의 증거일 뿐입니다. 거래량 없는 지지는 언제든 깨지니 반등은 매도 기회입니다.`,
      report: `강세론의 "싸졌으니 기회"라는 논리를 정면으로 반박합니다. 조정폭이 크다는 사실은 하락 추세가 강하다는 증거이지 바닥의 보증이 아닙니다. 강세론자가 근거로 든 지지선은 거래량 뒷받침이 없으면 언제든 무너지며, 실제로 최근 거래량은 반등 에너지라기보다 방향성 부재에 가깝습니다. 지표상으로도 가격이 단기 이동평균 아래에 머물고 모멘텀 지표가 음의 영역에 있어, 추세는 여전히 아래를 향합니다. 수급 호재라는 재료도 매크로 역풍에 상쇄되는 구도이며, 큰손이 관망으로 돌아선 자리를 소규모 매수가 메운다고 보기엔 규모 차이가 큽니다. 얇은 거래량 장세는 상방만큼 하방으로도 쉽게 미끄러진다는 점이 핵심입니다. 제 논거가 무효가 되는 조건은 분명합니다 — 거래량을 실은 저항 돌파가 나오면 하락 추세는 끝난 것으로 인정합니다. 그 전까지 반등은 차익 실현과 분할 매도의 기회로 봅니다.`,
    },
    risky: {
      bubble: `${sym} 기회비용도 리스크다. 손절만 지키면 비중을 더 실을 근거는 충분하다고 본다.`,
      report: `트레이더 계획을 공격적 관점에서 심사합니다. 결론부터 말하면 이 계획은 지나치게 방어적입니다. 조정폭이 이미 상당해 기대수익 대비 리스크 비율이 개선된 구간인데, 관망으로 시간을 보내는 것 자체가 기회비용입니다. 진입 트리거를 지지 확인 이후로 늦추면 반등의 초입을 놓치고 결국 더 높은 가격에 따라 들어가게 됩니다. 무효화 레벨이 명확하게 정의돼 있다는 점이 중요합니다 — 손실 한도가 계산 가능하다면 비중을 키워도 감당 범위는 통제됩니다. 목표도 1차 저항에서 끊기보다 절반만 익절하고 나머지는 추세를 태우는 편이 기대값이 높습니다. 다만 감당 가능한 최대 리스크는 명시해야 합니다. 레버리지는 1배로 고정이라 청산 위험 자체는 없지만, 계좌 대비 손실 상한(원금 기준)은 여전히 정해두고 그 한도 안에서만 공격적으로 태우십시오. 이 경고를 지키는 전제에서 저는 계획보다 적극적인 실행을 지지합니다.`,
    },
    safe: {
      bubble: `${sym} 최악의 시나리오 손실이 계산 안 된 계획이다. 비중 축소가 먼저다.`,
      report: `보수적 관점에서 이 계획의 취약점을 짚습니다. 가장 큰 문제는 최악의 시나리오가 정량화되지 않았다는 점입니다. 무효화 레벨은 정해져 있지만, 갭이나 급락으로 그 레벨을 건너뛰고 체결될 가능성은 계산에 들어가 있지 않습니다. 공격적 심사자는 "손절이 있으니 비중을 키워도 된다"고 하지만, 손절은 유동성이 있을 때만 손절로 기능합니다. 얇은 거래량 국면에서는 슬리피지가 손실을 손절폭보다 키웁니다. 방향성 근거 자체도 확정적이지 않습니다 — 모멘텀 지표는 아직 아래를 향하고, 심리는 극단이지만 그것이 반전 타이밍을 주지는 않습니다. 따라서 저는 비중 축소, 손절 상향, 그리고 이벤트 창 회피를 요구합니다. 레버리지가 1배라 청산 위험은 없지만, 갭으로 손절가를 건너뛰면 원금 손실 자체는 계획보다 커질 수 있고 15분봉 변동성이 그 폭에 가깝다면 한 번의 스파이크로 끝날 수 있습니다. 진입을 아예 보류하고 방향이 확인된 뒤 따라가는 편이 자본 보존에 유리합니다. 최소한 명목 비중을 절반으로 줄이지 않는다면 이 계획에 동의할 수 없습니다.`,
    },
    neutral: {
      bubble: `${sym} 양쪽 다 일부만 맞다. 조건부 승인 — 트리거 확인 후 절반 비중이 답이다.`,
      report: `두 심사자의 주장을 나눠 평가하겠습니다. 공격적 심사자의 "기회비용도 리스크"라는 지적은 타당합니다. 무효화 레벨이 명확하면 손실이 통제 가능하다는 논리도 원칙적으로 맞습니다. 다만 "손절이 있으니 비중을 키워도 된다"는 결론은 과장입니다 — 손절은 유동성 전제 아래에서만 작동하고, 보수적 심사자가 지적한 갭·슬리피지 위험은 실제로 계산에 빠져 있었습니다. 반대로 보수적 심사자의 "진입 보류" 요구도 과도합니다. 트리거가 정의된 계획을 근거 없이 보류하면 어떤 셋업도 실행할 수 없게 됩니다. 절충안은 이렇습니다 — 진입은 하되 트리거 확인 전에는 들어가지 않고, 확인되면 계획 비중의 절반으로 시작해 추가는 목표 절반 달성 이후로 미룹니다. 손절은 무효화 레벨보다 한 단계 앞당겨 슬리피지 여유를 확보합니다. 레버리지는 이미 1배 고정이라 별도로 낮출 건 없지만, 그만큼 비중 자체를 계좌 대비 감당 가능한 선으로 관리하는 게 핵심입니다. 이벤트 창(정책·실적 발표) 안에서는 신규 진입을 금지합니다. 이 조건들이 지켜지면 조건부 승인, 하나라도 어기면 기각이 제 의견입니다.`,
    },
    pm: {
      bubble: `${sym} 수정 승인. 방향은 유지하되 비중과 손절을 조여서 통과시킨다.`,
      report: `포트폴리오 매니저로서 트레이더 계획과 리스크 위원회 의견을 종합해 최종 판정합니다. 판정은 수정 승인(AMEND)입니다. 방향과 논거 자체는 데이터에 부합하므로 기각할 이유가 없습니다. 다만 원안대로 실행하기에는 보수적 심사자가 지적한 두 가지 구멍이 실재합니다 — 갭 위험이 손절 가정에 반영되지 않았고, 진입 시점이 트리거 확인 전이었습니다. 그래서 세 가지를 수정했습니다. 첫째, 진입은 트리거가 확인된 이후로만 허용합니다. 둘째, 손절을 무효화 레벨보다 한 단계 앞당겨 슬리피지 여유를 확보합니다. 셋째, 명목 비중을 원안의 절반으로 낮추고 추가 진입은 1차 목표 절반 달성 이후로 미룹니다. 목표는 원안을 유지하되 절반 익절 원칙을 명시합니다. 공격적 심사자의 추세 확장 주장은 절반 익절 후 잔여 물량으로 충족되므로 별도 반영하지 않았습니다. 레버리지는 1배로 고정돼 있어 청산 위험은 없지만, 원안 비중 그대로면 손절 시 원금 손실이 감당 범위를 넘어서므로 비중 축소를 조건으로 붙입니다. 이 조건들이 지켜지는 한 실행을 승인합니다.`,
      verdict: 'AMEND',
      action: 'HOLD',
      confidence: 58,
      entry: SW
        ? `${SW.entry} 트리거 확인 후에만 진입 (확인 전 진입 금지)`
        : `${sym} 트리거 확인 후에만 진입 (확인 전 진입 금지)`,
      stop: SW
        ? `${SW.tightStop} 이탈 시 손절 (무효화 레벨보다 한 단계 앞당김)`
        : '무효화 레벨보다 한 단계 앞당긴 지점',
      target: SW
        ? `${SW.target} 유지, 절반 도달 시 분할 익절`
        : '원안 목표 유지, 절반 도달 시 분할 익절',
      sizing: '계좌 리스크 2% 룰 기준 명목 비중의 절반 (레버리지 1배 고정)',
      rationale: `방향 논거는 타당해 기각하지 않았으나, 갭 위험 미반영과 트리거 이전 진입이라는 두 결함을 수정했습니다. 진입 조건 강화·손절 상향·비중 절반을 조건으로 수정 승인합니다.`,
    },
    ace: {
      bubble: `${sym} 논거가 팽팽해 관망이 우위입니다. 20일선 회복이나 저점 이탈 중 하나가 확인되면 그 방향으로 대응합니다.`,
      report: `${sym}에 대한 애널리스트 네 명의 분석과 강약 토론을 종합하면 논거가 팽팽합니다. 기술적으로는 20일선 부근의 지지 시험 국면이고 모멘텀 지표는 하락 압력이 줄어드는 축소 단계입니다. 펀더멘털은 중립~우호적이지만 이 자산군은 내재가치로 방향을 정하기 어렵다는 한계가 있습니다. 뉴스는 수급 호재와 매크로 역풍이 상쇄되는 구도이고, 심리는 극단으로 기울어 변동성이 커지기 쉬운 상태입니다. 강세론의 "기대수익 대비 리스크가 개선됐다"는 지적과 약세론의 "거래량 없는 반등은 취약하다"는 지적이 모두 데이터에 부합합니다. 어느 쪽도 우위를 증명하지 못했으므로 지금 신규 베팅은 불리한 리스크·리워드입니다. 반대 시나리오는 거래량을 실은 저항 돌파가 나오며 추세가 전환되는 경우이고, 그때는 즉시 상방으로 재설정합니다. 판단이 바뀌는 트리거는 두 개뿐입니다 — 거래량 동반 20일선 회복이면 매수, 20일 저점 종가 이탈이면 매도로 전환합니다. 그 전까지는 관망하며 레벨만 지켜보는 것이 합리적입니다.`,
      action: 'HOLD',
      confidence: 62,
      entry: SW
        ? `${SW.entry} 상향 돌파 확인 시 분할 진입 (20일선 회복 기준)`
        : `${sym} 20일선 상향 돌파 확인 시 분할 진입`,
      stop: SW ? `${SW.stop} 이탈 시 손절 (최근 20일 저점)` : '최근 20일 저점 이탈 시 손절',
      target: SW ? `${SW.target} 1차 목표 (직전 고점 부근)` : '직전 고점 부근을 1차 목표로 설정',
      rationale: `강세와 약세 논거가 균형을 이뤄 우위가 뚜렷하지 않고, 심리 과열이 부담으로 작용하므로 방향이 확인되기 전까지는 관망이 합리적입니다.`,
    },
  };

  return { ...table[id] };
}

// ---------------------------------------------------------------------------
// runAgent(id, context, {mock})
// ---------------------------------------------------------------------------
async function runAgent(id, context = {}, opts = {}) {
  const { mock = false } = opts || {};
  const meta = AGENT_BY_ID[id];
  if (!meta) throw new Error(`알 수 없는 에이전트 id: ${id}`);

  if (mock) {
    const delay = 300 + Math.floor(Math.random() * 500); // 300~800ms
    await new Promise((r) => setTimeout(r, delay));
    return mockResult(id, context);
  }

  const prompt = buildPrompt(id, context);
  return runAgentReal(id, prompt);
}

// --------------------------------------------------------------------------
// 포지션 충돌 조정 — 12명 로스터와 별개의 경량 판단 1건. AGENTS에 안 넣는다
// (화면에 13번째 캐릭터가 생기지 않는다 — 실행 시점에만, 충돌이 실제로 있을 때만 돈다).
// --------------------------------------------------------------------------

function buildConflictPrompt({ symbol, display, existing, incoming }) {
  const sym = display || symbol;
  const heldMin = Number.isFinite(existing.heldMin) ? `${existing.heldMin}분` : '알 수 없음';
  const parts = [];
  parts.push(`너는 포지션 충돌 조정 담당자다. ${sym}에 이미 포지션이 열려있는데, 방금 새 분석이 끝났다.`);
  parts.push('');
  parts.push('[기존 포지션 — 지금 거래소에 실제로 열려있음]');
  parts.push(
    `방향 ${existing.side} · 진입가 ${existing.entry} · 현재가 ${existing.markPrice} · ` +
      `현재 손익 ${existing.unrealizedPct == null ? '알 수 없음' : existing.unrealizedPct + '%'} · ` +
      `진입 당시 확신도 ${existing.confidence == null ? '알 수 없음' : existing.confidence + '%'} · 보유 ${heldMin}`
  );
  parts.push('');
  parts.push('[방금 나온 새 판정]');
  parts.push(
    `방향 ${incoming.side} · 진입가 ${incoming.entry} · 손절 ${incoming.stop} · 목표 ${incoming.target} · ` +
      `확신도 ${incoming.confidence}%`
  );
  if (incoming.rationale) {
    parts.push(`근거: ${incoming.rationale}`);
  }
  parts.push('');
  parts.push(
    '기존 포지션을 유지(KEEP)할지, 청산하고 새 판정으로 전환(SWITCH)할지 정하라. 판단 기준: ' +
      '① 새 판정의 근거가 기존 포지션의 전제를 실제로 무효화하는가(방향이 반대로 뒤집혔다는 사실 ' +
      '자체만으론 부족하다 — 왜 뒤집혔는지가 설득력 있어야 한다), ② 확신도 차이가 청산 비용(수수료·' +
      '슬리피지)을 감수할 만큼 의미 있는가, ③ 기존 포지션이 이미 목표에 가깝거나 손실이 커서 지금 ' +
      '정리하는 게 유리한가. 애매하면 KEEP이 기본값이다 — 잦은 전환 자체가 비용이다.'
  );
  parts.push('');
  parts.push('출력은 JSON 하나만: {"action":"SWITCH 또는 KEEP","reasoning":"한국어 한 문단, 왜 그렇게 정했는지"}');
  return parts.join('\n');
}

function mockConflictResult({ existing, incoming }) {
  const sameDir = existing.side === incoming.side;
  if (sameDir) {
    return {
      action: 'KEEP',
      reasoning: `이미 같은 방향(${existing.side})으로 포지션이 열려있습니다. 새 판정이 같은 방향을 다시 확인해줄 뿐 기존 전제를 무효화하지 않으므로, 추가 진입 없이 기존 포지션을 그대로 유지합니다.`,
    };
  }
  return {
    action: 'KEEP',
    reasoning: `방향이 반대(기존 ${existing.side} → 신규 ${incoming.side})이긴 하지만, 확신도 차이가 크지 않고(${existing.confidence ?? '?'}% vs ${incoming.confidence}%) 청산 비용을 감수할 만큼 새 근거가 강하지 않습니다. 기존 손절이 이미 계획대로 보호하고 있으므로 지금은 유지합니다.`,
  };
}

async function resolvePositionConflict(context = {}, opts = {}) {
  const { mock = false } = opts || {};
  if (mock) {
    const delay = 300 + Math.floor(Math.random() * 500);
    await new Promise((r) => setTimeout(r, delay));
    return normalizeResult(mockConflictResult(context));
  }
  const prompt = buildConflictPrompt(context);
  return runAgentReal('conflict-resolver', prompt);
}

// --------------------------------------------------------------------------
// 포지션 청산 검토 — 충돌 조정과 마찬가지로 12명 로스터와 별개의 경량 판단 1건.
// 손절은 진입 시점에 거래소에 미리 걸어두지만, 목표가는 기록만 될 뿐 자동으로
// 실행되지 않는다(익절 주문을 미리 걸어두지 않는 설계다 — 목표가 도달 전에도
// 상황이 바뀌면 더 들고 갈 수도, 일찍 정리할 수도 있어야 해서다). 그래서 감시가
// 가격 움직임을 감지할 때마다(이미 있는 주기), 열려있는 포지션이 있으면 이
// 판단을 돌려 "유지할지, 지금 정리할지, 손절선을 진입가 위로 당겨 이익을
// 보호할지"를 그때그때 정한다.
// --------------------------------------------------------------------------

function buildPositionReviewPrompt({ symbol, display, existing, trigger, indicatorLines }) {
  const sym = display || symbol;
  const heldMin = Number.isFinite(existing.heldMin) ? `${existing.heldMin}분` : '알 수 없음';
  const parts = [];
  parts.push(`너는 포지션 청산 검토 담당자다. ${sym}에 포지션이 열려있는데, 방금 가격 움직임이 감지돼 검토가 트리거됐다.`);
  parts.push('');
  parts.push('[포지션 정보 — 지금 거래소에 실제로 열려있음]');
  parts.push(
    `방향 ${existing.side} · 진입가 ${existing.entry} · 현재가 ${existing.markPrice} · ` +
      `현재 손익 ${existing.unrealizedPct == null ? '알 수 없음' : existing.unrealizedPct + '%'} · ` +
      `원래 목표가 ${existing.originalTarget ?? '알 수 없음'} · 원래 손절가 ${existing.originalStop ?? '알 수 없음'} · ` +
      `보유 ${heldMin}`
  );
  if (existing.originalRationale) {
    parts.push('');
    parts.push('[원래 이 포지션에 들어간 근거 — 진입 당시 PM 판정]');
    parts.push(existing.originalRationale);
    parts.push(
      '지금 판단의 핵심은 이거다: 위 근거가 아직 유효한가, 아니면 지금 움직임이 그 전제를 무너뜨렸는가?'
    );
  }
  if (Array.isArray(indicatorLines) && indicatorLines.length) {
    parts.push('');
    parts.push('[현재 기술 지표]');
    parts.push(indicatorLines.join('\n'));
  }
  parts.push('');
  parts.push('[방금 감지된 움직임]');
  parts.push(trigger || '알 수 없음');
  parts.push('');
  parts.push(
    '지금 이 포지션을 유지(KEEP)할지, 청산해서 손익을 확정(EXIT)할지, 손절선을 현재가 쪽으로 ' +
      '당겨서 이익을 보호(TIGHTEN_STOP)할지 정하라. 판단 기준: ' +
      '① 원래 근거가 아직 유효한가 — 원래 판정이 명시한 "판단이 바뀌는 트리거"가 지금 실제로 ' +
      '발생했는지를 최우선으로 본다(단순히 가격이 움직였다는 사실만으론 부족하다). ' +
      '② 원래 목표가에 근접했거나 이미 넘었는가 — 넘었다면 추가 상승分을 기대하기보다 확정하는 ' +
      '쪽이 합리적일 때가 많다. ③ 지금 움직임이 추세 지속을 시사하는가, 반전 조짐인가(현재 기술 ' +
      '지표를 참고하라). ④ 이미 충분한 수익 구간이면 손절선을 진입가 방향으로 당겨 "손실 없는 ' +
      '거래"로 만드는 것도 합리적 선택이다(TIGHTEN_STOP을 고르면 newStopPrice에 구체적 가격을 ' +
      '반드시 제시하라 — 기존 손절보다 포지션에 유리한 방향이어야 한다). ⑤ 원래 근거가 아직 ' +
      '유효하고 특별한 반전 신호가 없다면 원래 계획대로 KEEP이 기본값이다 — 잦은 청산·조정 ' +
      '자체가 비용이다.'
  );
  parts.push('');
  parts.push(
    '출력은 JSON 하나만: {"action":"KEEP 또는 EXIT 또는 TIGHTEN_STOP","newStopPrice":숫자또는null,"reasoning":"한국어 한 문단"}'
  );
  return parts.join('\n');
}

function mockPositionReviewResult({ existing }) {
  return {
    action: 'KEEP',
    newStopPrice: null,
    reasoning: `현재 손익 ${existing.unrealizedPct ?? '?'}%로 원래 목표·손절 범위 안이라 계획대로 유지합니다.`,
  };
}

async function reviewPositionForExit(context = {}, opts = {}) {
  const { mock = false } = opts || {};
  if (mock) {
    const delay = 300 + Math.floor(Math.random() * 500);
    await new Promise((r) => setTimeout(r, delay));
    return normalizeResult(mockPositionReviewResult(context));
  }
  const prompt = buildPositionReviewPrompt(context);
  return runAgentReal('position-review', prompt);
}

module.exports = {
  AGENTS,
  extractJson,
  runAgent,
  buildPrompt,
  checkClaudeAvailable,
  resolveClaudeBin,
  resolvePositionConflict,
  buildConflictPrompt,
  reviewPositionForExit,
  buildPositionReviewPrompt,
  parseSessionLimitResetTime,
  isSessionLimitOutput,
  isSessionLimitResponse,
  diagnose,
  parseClaudeCliOutput,
  _setSpawnImpl,
};

'use strict';

// config.js — 사용자 설정 로드/저장 (프로젝트 루트의 config.json)
//
// 계약: module.exports = { loadConfig, saveConfig, DEFAULTS }
//
// 원칙
// - 외부 의존성 0. Node 내장 모듈만 쓴다.
// - loadConfig()는 절대 throw하지 않는다. 파일이 없거나 JSON이 깨졌어도 DEFAULTS로 돌아간다.
// - saveConfig()도 throw하지 않는다. HTTP 핸들러에서 동기 throw는 프로세스를 죽이기 때문에,
//   쓰기 실패는 console.error로만 남기고 병합된 객체를 그대로 돌려준다(이번 실행에만 적용).
// - 두 함수 모두 동기다. 서버 부팅·라우트 어디서든 await 없이 쓸 수 있다.
// - 반환값은 항상 새 객체(깊은 복사)다. 호출자가 마음대로 고쳐도 DEFAULTS나 다음 로드에
//   영향을 주지 않는다.
//
// 설정 파일 경로는 기본이 <프로젝트루트>/config.json 이고,
// 환경변수 TRADING_FLOOR_CONFIG 로 덮어쓸 수 있다(테스트·다중 프로필용).

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILE = path.join(__dirname, '..', 'config.json');

// 설정 파일 경로. 호출 시점마다 환경변수를 다시 본다.
function configPath() {
  const override = process.env.TRADING_FLOOR_CONFIG;
  if (typeof override === 'string' && override.trim()) return path.resolve(override.trim());
  return DEFAULT_CONFIG_FILE;
}

// 기본 설정을 매번 새로 만든다. 외부에서 DEFAULTS를 훼손해도 로드가 오염되지 않는다.
function makeDefaults() {
  return {
    // 운영 방침(2026-09-25): BTC·ETH만 감시·거래한다. 종목이 많을수록 트리거·토큰·관리 부담이
    // 커지고, 미국주식은 바이낸스에서 거래 자체가 불가능해 분석 한도만 소모했다.
    watchlist: ['BTC', 'ETH'],
    watcher: {
      enabled: false,
      intervalSec: 60,
      triggers: {
        movePct: 1.5,
        windowMin: 15,
        volumeMultiple: 2.5,
        // 거래량 배율이 기준을 넘어도, 직전 1분봉 거래대금(달러)이 이 이하면 "잡음"으로
        // 보고 걸러낸다 — 평소 거래가 거의 없는 시간대엔 배율만으론 몇 달러짜리 체결도
        // 수십 배로 보인다. 0이면 이 기준을 끈다.
        minVolumeNotional: 3000,
        fundingAbs: 0.05,
        premiumPct: 1.0,
      },
      autoAnalyze: false, // 트리거 시 자동으로 분석까지 돌릴지
      autoMode: 'algo', // 스캘핑/공격 모드 폐지 — algo만 유효
      // 운영 방침(2026-09-25): BTC·ETH만 거래하는 24시간 체제로 전환했다. "출퇴근제"
      // (미장 09:30~16:00 America/New_York 밖이면 신규 진입·익절 검토·트레일링 스탑을
      // 쉬는 것)는 미국주식 시절 규칙이라 기본을 껐다 — 코인은 밤사이·주말에도 움직이고,
      // 특히 트레일링 스탑을 장 시간에만 돌리면 그 시간 밖에서 되밀림에 지켜야 할 이익을
      // 놓친다(2026-09-24 실전에서 확인: 청산이 미장 마감 후 발생했는데 트레일링 스탑이
      // 쉬고 있었다). true로 되돌리면 언제든 예전 방식으로 복귀할 수 있다.
      marketHoursOnly: false,
      cooldownMin: 30, // 같은 심볼 재트리거 최소 간격(감시 알림·자동분석용)
      // 포지션 청산 검토(익절/손절선 조정) 전용 쿨다운 — 위 cooldownMin과 일부러 분리했다.
      // 익절 검토는 알림·자동분석보다 훨씬 자주 트리거될 필요가 없다(목표가·추세 전환은
      // 30분마다 바뀌는 게 아니다) — 30분 그대로 두면 포지션이 하루 종일 열려있을 때
      // 검토만으로 한도를 눈에 띄게 갉아먹는다. 진짜 급한 움직임은 어차피 별도 경로
      // (감시 알림→자동분석→충돌 조정)로 이미 커버된다.
      positionReviewCooldownHours: 3,
      // 트레일링 스탑 여유폭(ATR 배수) — AI 없이 매 틱마다 작동, 한도와 무관.
      // "+10% 수익 상태에서 한도 부족으로 AI 검토가 안 되는 사이 급락하면 원래
      // 손절(-2%)까지 다 밀린다"는 공백을 메운다. 손절선을 고점 대비 이 폭만큼
      // 아래로 계속 따라 올린다(내려가는 일은 없다).
      trailAtrMultiple: 2.5,
      // 가격 트리거(움직임 기준 충족)가 떠도, SMA20·MACD 같은 기본 차트 구조가 그
      // 방향을 뒷받침할 때만 자동분석을 시작한다. 롱/숏 완전 대칭 — 상승·하락 둘 다
      // 같은 기준으로 본다. false로 끄면 예전처럼 가격·거래량만으로 트리거한다.
      structureFilterEnabled: true,
      // 역추세 후보 — 가격이 최근 20일 구간의 극단(하락 후 하단 20%/상승 후 상단 20%)에
      // 있으면 반전 후보로 본다. 추세 추종 필터와 "둘 중 하나만 맞아도" 분석 후보가 되고,
      // 어느 쪽 신호였는지는 후보 기록(features.signals)에 남아 나중에 결과로 비교한다.
      // 20%는 워뇨띠 초기 매매 재분석이 설명용으로 고른 값 — 검증된 최적값이 아니다.
      reversalFilterEnabled: true,
      reversalBandPct: 20,
      // 12명 분석을 시작시키는 알림 종류 — 기본은 가격 움직임만. 거래량·펀딩비는 자주
      // 출렁여서 단독 근거로 약하다(알림은 그대로 오고, 분석 안에서 근거로는 계속 쓰인다).
      analysisTriggerKinds: ['move'],
      // 하루 자동분석 상한(뉴욕 거래일 기준) — API 종량제 전환 시 비용 관리용. 구독 방식
      // 에서는 5시간 한도를 한도 소진 게이트가 막으므로 기본 꺼짐(enabled:false). API로
      // 전환하면 enabled:true로 켠다. 용도별 칸: 개장 전 계획 2 / AI 진입가 도달 재확인 2 /
      // 가격 급변 2. 수동 분석과 1명짜리 호출(익절 검토·충돌 조정)은 세지 않는다.
      analysisBudget: { enabled: false, total: 6, planning: 2, level: 2, move: 2 },
      quietHours: [], // 예: [[0,7]] → 0~7시 알림 억제
    },
    telegram: { enabled: false, botToken: '', chatId: '' },
    // 하루 한 번(뉴욕 현지 시각 기준) 그날 실거래 손익을 텔레그램으로 요약해서 보낸다.
    // 기본은 미국 정규장 마감(16:00 America/New_York) 5분 뒤.
    dailySummary: { enabled: false, atHHMM: '16:05' },
    schedule: { enabled: false, jobs: [] }, // [{ at:'08:30', symbol:'SKHYNIX', mode:'algo', days:'weekday' }]
    // 실거래 실행 스위치 — 기본값은 반드시 꺼짐(false)이다. 이걸 true로 바꾸는 순간부터
    // (그리고 서버 환경변수에 BINANCE_API_KEY/SECRET/BASE_URL이 있으면) 판정이 실제
    // 거래소 주문으로 나간다. 테스트넷 검증 없이 켜지 말 것.
    // accountSizeUsd/riskPct/maxPositionPct는 위 risk.accountRiskPct(분석·토론용 2% 룰)와
    // 완전히 별개다 — 에이전트들의 토론 기준은 그대로 두고, 실제 주문 수량만 이 값으로
    // 따로 계산한다(riskmath.executionSize).
    execution: {
      enabled: false,
      accountSizeUsd: 0, // 0이면 계산 자체를 안 함(안전장치) — 반드시 설정해야 동작
      riskPct: 0.5, // 거래당 손실 허용 (계좌 대비 %) — 검증 단계라 보수적으로 낮게
      maxPositionPct: 20, // 포지션 상한 (계좌 대비 %, 명목가 기준) — 손절폭이 좁아도 이 이상은 안 나감
      // 절대 금액 상한(달러) — 위의 모든 비율(riskPct·maxPositionPct)과 완전히 독립된
      // 최후의 방어선이다. accountSizeUsd 설정이 잘못 들어가도(오타 등) 실제 진입
      // 금액이 이 달러를 절대 못 넘는다. 지금(테스트넷 $5000) 기준 여유 있게 잡아뒀다 —
      // 나중에 $300 실계좌로 전환할 때는 이 값도 훨씬 작게(예: 100~150) 같이 낮춰야
      // 의미가 있다. 0이면 이 기능 자체를 끈다.
      maxNotionalUsd: 2000,
      // 주문 직전 시세 확인(R10) — 현재가가 계획 진입가에서 "손절까지 거리(1R)"의 몇 배
      // 이상 벗어나면 주문하지 않는다. 수량은 계획가 기준으로 계산되므로 많이 벗어나면
      // 손실 한도와 손익비가 계획과 달라진다. 현재가가 이미 손절선을 넘었으면 항상 차단.
      maxEntryDriftR: 0.5,
      // 실거래 허용 종목(거래소 심볼) — 워치리스트와 별개의 마지막 잠금. 여기 없는 종목은
      // 어떤 경로(수동 분석 포함)로 판정이 나와도 주문하지 않는다.
      allowedSymbols: ['BTCUSDT', 'ETHUSDT'],
      // 종목 하나짜리 상한(maxPositionPct)과 별개다 — 여러 종목이 동시에 열리면 종목별로는
      // 다 안전해도 계좌 전체로는 과도하게 몰릴 수 있다. 지금 열려있는 모든 포지션의
      // 명목가 합계 + 새로 열려는 포지션이 이 비율을 넘으면 신규 진입을 막는다.
      maxPortfolioExposurePct: 60,
      // 최근 24시간 실현손익(바이낸스가 실제로 기록한 값)이 계좌의 이 %만큼 손실이면
      // 신규 진입을 멈춘다. 이미 열린 포지션은 안 건드린다(걸려있는 손절이 계속 보호).
      // 0이면 체크 자체를 하지 않는다.
      dailyLossLimitPct: 5,
      // 연속 손실 서킷 브레이커 — 하루 손실 한도(금액)와는 다른 문제를 본다. 포지션이
      // 작으면 연속으로 여러 번 틀려도 금액 한도엔 안 걸릴 수 있는데, "연속으로 계속
      // 틀린다"는 건 지금 전략이 지금 시장과 안 맞는다는 신호일 가능성이 높다. 이만큼
      // 연속으로 손실이면, 마지막 손실 시점부터 아래 쿨다운 시간 동안 신규 진입을
      // 멈춘다(이긴 거래가 나오면 연속 기록이 끊겨 자동으로 풀린다). 0이면 끈다.
      consecutiveLossThreshold: 3,
      consecutiveLossCooldownHours: 12,
    },
    risk: {
      minRR: 1.5, // 최소 손익비. 미달이면 판정을 HOLD/PASS로 강등
      accountRiskPct: 2.0, // 1회 거래 허용 손실 (계좌 대비 %)
      accountSize: 0, // 0이면 비중을 %로만 표기
      leverage: 1, // 무조건 1배 고정
      maintenanceMarginPct: 0.5, // 청산 계산용
    },
    ui: { sound: true, animations: true },
  };
}

// 참고용 기본값 스냅샷. 이 객체를 고쳐도 loadConfig 결과에는 영향이 없다.
const DEFAULTS = makeDefaults();

// --- 내부 헬퍼 -----------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function kindOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function deepClone(v) {
  if (Array.isArray(v)) return v.map(deepClone);
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
    return out;
  }
  return v;
}

// 프로토타입 오염 방지 (config.json은 HTTP POST로도 들어온다)
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// base(기본값 사본)에 patch를 깊게 덮어쓴다.
// - 객체끼리는 재귀 병합, 배열·원시값은 통째로 교체
// - 형식이 다른 값(예: watchlist에 문자열)은 무시하고 기본값을 유지
// - null은 "값 없음"으로 보고 기본값을 유지 (기본값에 없던 키만 null 허용)
function mergeInto(base, patch) {
  if (!isPlainObject(patch)) return base;
  for (const key of Object.keys(patch)) {
    if (BLOCKED_KEYS.has(key)) continue;
    const pv = patch[key];
    if (pv === undefined) continue;
    const bv = base[key];

    if (isPlainObject(bv) && isPlainObject(pv)) {
      mergeInto(bv, pv);
      continue;
    }
    if (pv === null) {
      if (bv === undefined) base[key] = null;
      continue;
    }
    if (bv !== undefined && bv !== null && kindOf(bv) !== kindOf(pv)) {
      console.error(
        `[config] '${key}' 값의 형식이 달라 무시했습니다 (기대: ${kindOf(bv)}, 입력: ${kindOf(pv)})`
      );
      continue;
    }
    base[key] = deepClone(pv);
  }
  return base;
}

// --- 공개 API ------------------------------------------------------------

// config.json을 읽어 DEFAULTS와 병합한 설정 객체를 돌려준다.
// 파일이 없으면 DEFAULTS, 일부 키만 있으면 나머지는 DEFAULTS로 채운다. 절대 throw하지 않는다.
// 설정을 읽은 뒤 워치리스트를 고정 종목(universe.js)으로 거른다 — config.json에 다른 종목이
// 남아 있어도 BTC·ETH만 감시한다. 설정 화면으로 종목을 추가해도 반영되지 않는다.
function loadConfig() {
  const cfg = loadConfigRaw();
  try {
    const uni = require('./universe');
    cfg.watchlist = uni.filterToUniverse(cfg.watchlist);
  } catch (_) {
    /* universe 모듈이 없으면 원래 값 유지 */
  }
  return cfg;
}

function loadConfigRaw() {
  const cfg = makeDefaults();
  const file = configPath();

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    // 파일 없음(ENOENT)은 정상 — 조용히 기본값을 쓴다.
    if (!err || err.code !== 'ENOENT') {
      console.error(`[config] 설정 파일을 읽지 못해 기본값을 씁니다: ${err && err.message}`);
    }
    return cfg;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`[config] config.json 파싱 실패 — 기본값을 씁니다: ${err.message}`);
    return cfg;
  }

  if (!isPlainObject(parsed)) {
    console.error('[config] config.json 최상위가 객체가 아니라 기본값을 씁니다');
    return cfg;
  }

  return mergeInto(cfg, parsed);
}

// patch를 현재 설정에 깊게 병합해 저장하고, 저장된 최신 설정 객체를 돌려준다.
// 쓰기에 실패해도 throw하지 않는다(반환된 객체는 이번 실행 메모리 기준으로만 유효).
function saveConfig(patch) {
  const merged = loadConfig();
  mergeInto(merged, isPlainObject(patch) ? patch : {});

  const file = configPath();
  const text = JSON.stringify(merged, null, 2) + '\n';
  const tmp = `${file}.tmp`;

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      // 원자적 저장: 임시 파일에 쓰고 교체 (중간에 죽어도 config.json이 깨지지 않는다)
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, file);
    } catch (renameErr) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 임시 파일 정리는 실패해도 무시 */
      }
      throw renameErr;
    }
  } catch (err) {
    console.error(`[config] 설정 저장 실패 — 이번 실행에만 적용됩니다: ${err && err.message}`);
  }

  return merged;
}

module.exports = { loadConfig, saveConfig, DEFAULTS };

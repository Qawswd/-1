'use strict';

// PIXEL TRADING FLOOR — 급변동 감시 (watcher)
//
// 계약(docs/v2-contracts.md):
//   class Watcher extends EventEmitter
//     constructor({ engine, config })
//     start() / stop() / status()
//   트리거 시 emit('alert', alertObj)
//
// 설계 원칙
//   - **가벼운 시세만 조회한다.** fetchMarket()은 뉴스·펀더멘털까지 긁어서 비싸다.
//     여기서는 market.js가 쓰는 것과 동일한 엔드포인트를 최소 개수만 직접 부른다.
//       코인    : Binance 현물 24hr ticker + 1분봉 klines (+ 무기한 펀딩)
//       한국주식: Binance USDⓈ-M 무기한(fapi) 24hr ticker + 1분봉 klines + premiumIndex
//                 — CLAUDE.md 규칙대로 체결이 일어나는 무기한 축을 본다
//       해외주식: Yahoo chart 1분봉 1콜
//   - 어떤 실패도 삼키고 다음 주기로 넘어간다. **감시 루프는 절대 죽지 않는다.**
//   - 조용시간에는 알림을 기록·방송만 하고 텔레그램·자동분석은 하지 않는다.
//   - 자동분석은 engine.running 이면 그냥 건너뛴다(큐잉 금지 — 시장은 이미 변했다).

const EventEmitter = require('events');
const { resolveSymbol, KR_STOCKS } = require('./market');
const { isUsMarketHours } = require('./market-hours');

const MAX_ALERTS = 50; // 메모리에 보관하는 최근 알림 수
const MIN_INTERVAL_SEC = 10; // 너무 잦은 폴링 방지
const HTTP_TIMEOUT_MS = 8000;
const KLINE_MIN_BARS = 31; // 거래량 기준선을 만들 최소 봉 수
const KLINE_MAX_BARS = 200;
const VOL_BASE_MIN = 10; // 거래량 비교에 필요한 최소 기준봉 수
const FX_TTL_MS = 10 * 60 * 1000; // 환율 캐시 (괴리 계산용)
const KRX_TTL_MS = 5 * 60 * 1000; // KRX 종가 캐시
const FAIL_RETRY_MS = 60 * 1000; // 야후가 죽었을 때 재시도 억제 간격
const AUTO_GAP_DEFAULT_MIN = 5; // 자동분석 최소 간격(전역) — 할당량 보호

const BINANCE_SPOT = 'https://api.binance.com/api/v3';
const BINANCE_FAPI = 'https://fapi.binance.com/fapi/v1';
const YAHOO_CHART = 'https://query1.finance.yahoo.com/v8/finance/chart';
const ER_API = 'https://open.er-api.com/v6/latest/USD';

// market.js 와 동일한 UA — Yahoo 가 기본 UA 를 자주 막는다.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const YAHOO_HEADERS = { 'User-Agent': UA, Accept: 'application/json' };

// --- 작은 유틸 ----------------------------------------------------------

function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function clampNum(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function fmtNum(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  if (abs >= 1000) return Math.round(v).toLocaleString('en-US');
  if (abs >= 1) return v.toFixed(2);
  if (abs >= 0.01) return v.toFixed(4);
  if (abs === 0) return '0';
  return v.toPrecision(4);
}

function pctStr(n, dp = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '-';
  return `${v >= 0 ? '+' : ''}${v.toFixed(dp)}%`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function mean(arr) {
  const v = arr.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  return v.reduce((s, x) => s + x, 0) / v.length;
}

// 기준값 대비 몇 배인지로 심각도를 매긴다(모든 kind 공통 규칙).
function severityOf(value, threshold) {
  const t = Math.abs(Number(threshold));
  const v = Math.abs(Number(value));
  if (!Number.isFinite(t) || t === 0 || !Number.isFinite(v)) return 'info';
  const r = v / t;
  if (r >= 2) return 'critical';
  if (r >= 1.4) return 'warn';
  return 'info';
}

// quietHours: [[0,7]] → 0시~7시 억제. [[22,6]] 처럼 자정을 넘는 구간도 지원.
function inQuietHours(quietHours, now) {
  if (!Array.isArray(quietHours) || !quietHours.length) return false;
  const h = (now || new Date()).getHours();
  for (const range of quietHours) {
    if (!Array.isArray(range) || range.length < 2) continue;
    const a = Number(range[0]);
    const b = Number(range[1]);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
    if (a < b) {
      if (h >= a && h < b) return true;
    } else if (h >= a || h < b) {
      return true; // 자정 넘김
    }
  }
  return false;
}

// config 는 세 형태를 모두 받는다:
//   1) 설정 객체 그대로   { watchlist:[...], watcher:{...} }
//   2) 최신 설정을 돌려주는 함수  () => cfg   ← 실행 중 설정 변경이 바로 반영된다
//   3) config.js 모듈     { loadConfig, saveConfig, DEFAULTS }
function makeConfigReader(src) {
  return function read() {
    try {
      let c = src;
      if (typeof c === 'function') c = c();
      if (c && typeof c.loadConfig === 'function' && !c.watcher && !c.watchlist) {
        c = c.loadConfig();
      }
      if (c && typeof c === 'object') return c;
    } catch (_) {}
    return {};
  };
}

// 감시에 필요한 설정만 정규화해서 뽑는다(없으면 계약서 DEFAULTS 값).
function readWatchCfg(cfg) {
  const w = (cfg && cfg.watcher) || {};
  const t = w.triggers || {};
  const mode = String(w.autoMode || 'algo').toLowerCase();
  return {
    enabled: w.enabled === true, // 명시적 false 만 끔으로 본다
    intervalSec: clampNum(w.intervalSec, MIN_INTERVAL_SEC, 3600, 60),
    movePct: clampNum(t.movePct, 0.01, 100, 1.5),
    windowMin: Math.round(clampNum(t.windowMin, 1, 120, 15)),
    volumeMultiple: clampNum(t.volumeMultiple, 1.1, 100, 2.5),
    // 거래량 "배율"만 보면 평소 거래가 거의 없는 시간대(주말의 주식 연계 상품 등)에서
    // 분모(평균)가 거의 0이라 별 의미 없는 체결 한두 건에도 배율이 수십 배로 튄다.
    // 최소 거래대금(직전 1분봉 기준, 달러)을 같이 요구해서 "숫자만 큰" 잡음을 거른다.
    // 0이면 이 기준 자체를 끈다(배율만으로 판단하던 예전 동작).
    minVolumeNotional: clampNum(t.minVolumeNotional, 0, 10_000_000, 3000),
    fundingAbs: clampNum(t.fundingAbs, 0.0001, 10, 0.05),
    premiumPct: clampNum(t.premiumPct, 0.01, 100, 1.0),
    autoAnalyze: !!w.autoAnalyze,
    autoMode: mode === 'algo' ? mode : 'algo', // 스캘핑/공격 모드 폐지 — algo만 유효
    marketHoursOnly: w.marketHoursOnly === true, // 기본 false(24시간 체제) — true로 명시해야 미장 시간대로 되돌아간다
    cooldownMin: clampNum(w.cooldownMin, 0, 1440, 30),
    // 포지션 청산 검토 전용 쿨다운(시간 단위) — 감시 알림·자동분석의 cooldownMin과 분리.
    positionReviewCooldownHours: clampNum(w.positionReviewCooldownHours, 0, 168, 3),
    // 트레일링 스탑의 여유폭 — ATR의 몇 배 아래(LONG)/위(SHORT)에 손절을 둘지.
    // 작을수록 타이트하게 따라가고(정상적인 되돌림에도 쫓겨나기 쉬움), 클수록 여유
    // 있게 따라간다(더 큰 반전이 와야 정리됨). 2.5배가 무난한 기본값이다.
    trailAtrMultiple: clampNum(w.trailAtrMultiple, 0.5, 10, 2.5),
    // 가격 트리거(kind:'move')에 SMA20·MACD 같은 기본 차트 구조가 뒷받침하는지
    // 확인하는 필터. 기본 켜짐 — false로 명시해야 끄고 예전(가격·거래량만 보던)
    // 동작으로 돌아간다.
    structureFilterEnabled: w.structureFilterEnabled !== false,
    // 역추세 후보(최근 20일 구간 극단 근처) — 추세 추종과 나란히 후보로 둔다. 기본 켜짐.
    reversalFilterEnabled: w.reversalFilterEnabled !== false,
    // 구간 극단 기준(%). 20은 워뇨띠 기록 분석이 설명용으로 고른 값이지 검증된 최적값이
    // 아니다 — 결과 판정 데이터로 조정한다. 5~45 사이로 제한(50이면 구간 전체가 되어 의미 없음).
    reversalBandPct: clampNum(w.reversalBandPct, 5, 45, 20),
    // 12명 분석을 시작시킬 수 있는 알림 종류. 기본은 가격 움직임(move)만 — 거래량·펀딩비·
    // 괴리율은 자주 출렁여서 단독으로는 분석 근거가 약하다. 이 신호들은 텔레그램 알림으로만
    // 남고, 분석 안에서는 TARO 등이 여전히 거래량 데이터를 근거로 본다.
    analysisTriggerKinds: Array.isArray(w.analysisTriggerKinds) && w.analysisTriggerKinds.length
      ? w.analysisTriggerKinds.map(String)
      : ['move'],
    // 하루 자동분석 상한(뉴욕 거래일 기준, 용도별 칸) — analysis-budget.js 참고.
    // API 종량제로 전환했을 때의 비용 관리용이다. 구독 방식에서는 비용이 아니라 5시간
    // 한도가 제약이고, 그건 한도 소진 게이트(engine.quotaExhaustedUntil)가 막는다 —
    // 그래서 기본은 꺼짐. 설정에서 enabled:true로 명시했을 때만 적용한다.
    analysisBudget: {
      total: 6,
      planning: 2,
      level: 2,
      move: 2,
      ...(w.analysisBudget || {}),
      enabled: !!(w.analysisBudget && w.analysisBudget.enabled === true),
    },
    autoGapMin: clampNum(w.autoAnalyzeGapMin, 0, 1440, AUTO_GAP_DEFAULT_MIN),
    quietHours: Array.isArray(w.quietHours) ? w.quietHours : [],
    watchlist: Array.isArray(cfg && cfg.watchlist)
      ? cfg.watchlist.filter((s) => typeof s === 'string' && s.trim())
      : [],
  };
}

let alertSeq = 0;
function nextId() {
  alertSeq = (alertSeq + 1) % 1e6;
  return `w${Date.now().toString(36)}${alertSeq.toString(36)}`;
}

// --- Watcher ------------------------------------------------------------

class Watcher extends EventEmitter {
  // opts: { engine, config, notify, fetchImpl, exchangeMod, positionsMod, agentsMod }
  //   notify      — 생략 시 ./notify 사용. null 을 주면 텔레그램 발송을 끈다.
  //   fetchImpl   — 테스트용 fetch 주입.
  //   exchangeMod/positionsMod/agentsMod — 포지션 청산 검토(익절/손절선 조정)에 쓴다.
  //   생략 시 각각 ./exchange, ./positions, ./agents 를 안전하게(실패해도 null) 불러온다.
  constructor(opts = {}) {
    super();
    this.setMaxListeners(0);
    this.engine = opts.engine || null;
    this._config = makeConfigReader(opts.config);
    this._notify =
      opts.notify === null
        ? null
        : opts.notify || (() => {
            try {
              return require('./notify');
            } catch (_) {
              return null;
            }
          })();
    this._fetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : (...a) => fetch(...a);

    // "감시 루프는 절대 죽지 않는다" 원칙 — 이 세 모듈은 전부 try/catch로 불러온다.
    // 하나라도 없거나 깨져도 감시·알림·자동분석은 그대로 돌고, 포지션 청산 검토만 조용히 꺼진다.
    const safeRequire = (name) => {
      try {
        return require(name);
      } catch (_) {
        return null;
      }
    };
    this._exchange = opts.exchangeMod !== undefined ? opts.exchangeMod : safeRequire('./exchange');
    this._market = opts.marketMod !== undefined ? opts.marketMod : safeRequire('./market');
    this._indicators = opts.indicatorsMod !== undefined ? opts.indicatorsMod : safeRequire('./indicators');
    this._triggerLog = opts.triggerLogMod !== undefined ? opts.triggerLogMod : safeRequire('./trigger-log');
    this._budget = opts.budgetMod !== undefined ? opts.budgetMod : safeRequire('./analysis-budget');
    this._candidateLog = opts.candidateLogMod !== undefined ? opts.candidateLogMod : safeRequire('./candidate-log');
    this._positions = opts.positionsMod !== undefined ? opts.positionsMod : safeRequire('./positions');
    this._agents = opts.agentsMod !== undefined ? opts.agentsMod : safeRequire('./agents');

    this._started = false;
    this._timer = null;
    this._ticking = false;
    this._warnedDisabled = false;
    // stop() 이 불리면 증가한다. 진행 중이던 주기가 남은 심볼을 계속 긁지 않게 하는 용도.
    this._gen = 0;

    this.alerts = []; // 최근 알림 (최신이 앞)
    this._cooldown = new Map(); // `${symbol}|${kind}` -> ts
    this._reviewCooldown = new Map(); // `${symbol}` -> ts (포지션 청산 검토 전용 쿨다운)
    this._reviewInFlight = new Set(); // 지금 AI 검토(익절/손절 판단) 진행 중인 exSymbol — 트레일링 스탑과의 교통정리용
    this._last = new Map(); // symbol -> 마지막 조회 스냅샷
    this._fxCache = { ts: 0, rate: null, source: null };
    this._fxRetryAt = 0;
    this._krxCache = new Map(); // yahoo 심볼 -> { ts, price }
    this._krxRetryAt = new Map();

    this.lastTickAt = null;
    this.lastError = null;
    this.tickCount = 0;
    this.alertCount = 0;
    this.lastAutoAnalyzeAt = null;
    this.lastAutoAnalyze = null;
    this.lastPositionReview = null;
    this.lastTrailStop = null;
  }

  // --- 수명주기 ---------------------------------------------------------

  start() {
    if (this._started) return this.status();
    this._started = true;
    this._warnedDisabled = false;
    this._arm(1000); // 서버 부팅 직후 몰리지 않게 1초 뒤 첫 조회
    return this.status();
  }

  stop() {
    this._started = false;
    this._gen += 1; // 진행 중인 주기를 중단시킨다
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    return this.status();
  }

  // 타이머는 unref — 감시가 살아 있다는 이유로 프로세스가 안 죽는 일이 없게 한다
  // (프로세스 수명은 HTTP 서버가 잡는다).
  _arm(delayMs) {
    if (!this._started) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      this._timer = null;
      this._tick()
        .catch((e) => {
          this.lastError = e && e.message ? e.message : String(e);
        })
        .finally(() => {
          const w = readWatchCfg(this._config());
          this._arm(w.intervalSec * 1000);
        });
    }, Math.max(50, Number(delayMs) || 1000));
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  // --- 주기 실행 --------------------------------------------------------

  async _tick() {
    if (this._ticking) return; // 이전 주기가 안 끝났으면 이번 주기는 건너뛴다
    this._ticking = true;
    try {
      const cfg = this._config();
      const w = readWatchCfg(cfg);

      if (!w.enabled) {
        if (!this._warnedDisabled) {
          this._warnedDisabled = true;
          console.error(
            '[watcher] 루프는 켰지만 config.watcher.enabled=false 라 시세 조회를 건너뜁니다.'
          );
        }
        return;
      }
      this._warnedDisabled = false;

      const now = new Date();
      const quiet = inQuietHours(w.quietHours, now);

      const gen = this._gen;
      for (const raw of w.watchlist) {
        if (this._gen !== gen) break; // 도중에 stop() 이 불렸다
        try {
          await this._checkSymbol(raw, cfg, w, quiet);
        } catch (e) {
          // 심볼 하나가 죽어도 나머지는 계속 본다.
          const msg = e && e.message ? e.message : String(e);
          this.lastError = `${raw}: ${msg}`;
          const prev = this._last.get(String(raw).toUpperCase()) || {};
          this._last.set(String(raw).toUpperCase(), {
            ...prev,
            symbol: String(raw).toUpperCase(),
            checkedAt: Date.now(),
            error: msg,
          });
        }
      }
      this.tickCount += 1;
      this.lastTickAt = Date.now();

      // 트레일링 스탑 — AI 판단이 아니라 순수 계산이라 한도와 완전히 무관하게 매 틱마다
      // 돈다. 익절 검토(AI)가 한도 부족으로 못 돌아도, 이건 계속 작동해서 손절선을
      // "본전 이하로는 절대 안 내려가게" 따라 올린다.
      try {
        await this._maybeTrailStops(cfg, w);
      } catch (e) {
        console.error('[watcher] 트레일링 스탑 오류:', e && e.message ? e.message : e);
      }
    } finally {
      this._ticking = false;
    }
  }

  async _checkSymbol(raw, cfg, w, quiet) {
    const resolved = resolveSymbol(raw);
    const name = resolved.nameKo || resolved.display || resolved.symbol;
    const limit = Math.min(KLINE_MAX_BARS, Math.max(w.windowMin + 1, KLINE_MIN_BARS));

    let probe;
    if (resolved.kind === 'crypto') probe = await this._probeCrypto(resolved, limit);
    else if (resolved.kind === 'krstock') probe = await this._probeKrPerp(resolved, limit);
    else probe = await this._probeStock(resolved, limit);

    // 괴리(premium)는 KRX 현물 + 환율이 더 필요해서 별도 주기로 돈다.
    let premiumPct = null;
    if (resolved.kind === 'krstock' && probe.price != null) {
      premiumPct = await this._maybePremium(resolved, probe.price);
    }

    const snapshot = {
      symbol: resolved.symbol,
      display: name,
      kind: resolved.kind,
      price: probe.price,
      priceText: probe.price != null ? `${probe.cs}${fmtNum(probe.price)}` : null,
      changePct24h: probe.changePct,
      fundingPct: probe.fundingPct,
      premiumPct,
      source: probe.source,
      checkedAt: Date.now(),
      error: null,
    };
    this._last.set(resolved.symbol, snapshot);

    const candidates = this._evaluate(resolved, name, probe, premiumPct, w);
    for (const c of candidates) {
      this._raise(c, cfg, w, quiet);
    }
  }

  // --- 트리거 판정 ------------------------------------------------------

  _evaluate(resolved, name, probe, premiumPct, w) {
    const out = [];
    const cs = probe.cs || '$';
    const priceText = probe.price != null ? `${cs}${fmtNum(probe.price)}` : null;
    const base = {
      symbol: resolved.symbol,
      display: name,
      price: probe.price,
      priceText,
    };

    // 1) 이동 — windowMin 분 전 종가 대비 현재가
    const closes = probe.closes || [];
    if (closes.length > w.windowMin) {
      const ref = closes[closes.length - 1 - w.windowMin];
      const cur = probe.price != null ? probe.price : closes[closes.length - 1];
      if (Number.isFinite(ref) && ref !== 0 && Number.isFinite(cur)) {
        const movePct = ((cur - ref) / ref) * 100;
        if (Math.abs(movePct) >= w.movePct) {
          out.push({
            ...base,
            kind: 'move',
            severity: severityOf(movePct, w.movePct),
            value: Number(movePct.toFixed(4)),
            threshold: w.movePct,
            message:
              `${name} ${w.windowMin}분 ${pctStr(movePct)} (기준 ${w.movePct}%)` +
              (priceText ? ` · 현재 ${priceText}` : ''),
          });
        }
      }
    }

    // 2) 거래량 — 직전 '완성된' 1분봉 vs 그 이전 봉 평균
    //    (마지막 봉은 진행 중이라 항상 작게 잡히므로 제외한다)
    const vols = probe.vols || [];
    if (vols.length >= VOL_BASE_MIN + 2) {
      const lastVol = vols[vols.length - 2];
      const baseVols = vols.slice(0, vols.length - 2);
      const avg = mean(baseVols.slice(-30));
      if (Number.isFinite(lastVol) && avg && avg > 0) {
        const mult = lastVol / avg;
        // 절대 거래대금(직전 1분봉 거래량 × 현재가)이 최소 기준 이상일 때만 "진짜
        // 유의미한 거래량"으로 본다 — 배율이 아무리 커도 실제 체결 금액이 몇 달러
        // 수준이면 잡음이다(minVolumeNotional:0이면 이 조건 자체를 건너뛴다).
        const notional = Number.isFinite(probe.price) ? lastVol * probe.price : null;
        const notionalOk = !(w.minVolumeNotional > 0) || (notional != null && notional >= w.minVolumeNotional);
        if (mult >= w.volumeMultiple && notionalOk) {
          out.push({
            ...base,
            kind: 'volume',
            severity: severityOf(mult, w.volumeMultiple),
            value: Number(mult.toFixed(2)),
            threshold: w.volumeMultiple,
            message:
              `${name} 1분 거래량 ${mult.toFixed(1)}배 (기준 ${w.volumeMultiple}배)` +
              (notional != null ? ` · 거래대금 ${cs}${fmtNum(notional)}` : '') +
              (priceText ? ` · 현재 ${priceText}` : ''),
          });
        }
      }
    }

    // 3) 펀딩비 — 무기한 선물이 있는 심볼만 값이 들어온다
    if (probe.fundingPct != null && Math.abs(probe.fundingPct) >= w.fundingAbs) {
      out.push({
        ...base,
        kind: 'funding',
        severity: severityOf(probe.fundingPct, w.fundingAbs),
        value: Number(probe.fundingPct.toFixed(6)),
        threshold: w.fundingAbs,
        message:
          `${name} 펀딩비 ${pctStr(probe.fundingPct, 4)} (기준 ${w.fundingAbs}%) · ` +
          `${probe.fundingPct >= 0 ? '롱이 숏에게 지불' : '숏이 롱에게 지불'}`,
      });
    }

    // 4) 괴리 — 무기한 원화환산 vs KRX 현물
    if (premiumPct != null && Math.abs(premiumPct) >= w.premiumPct) {
      out.push({
        ...base,
        kind: 'premium',
        severity: severityOf(premiumPct, w.premiumPct),
        value: Number(premiumPct.toFixed(4)),
        threshold: w.premiumPct,
        message:
          `${name} 선물↔KRX 괴리 ${pctStr(premiumPct)} (기준 ${w.premiumPct}%)` +
          (priceText ? ` · 무기한 ${priceText}` : ''),
      });
    }

    return out;
  }

  // 쿨다운 통과 → 기록·방송·(조용시간이 아니면) 텔레그램·자동분석
  _raise(candidate, cfg, w, quiet) {
    const key = `${candidate.symbol}|${candidate.kind}`;
    const now = Date.now();
    const last = this._cooldown.get(key) || 0;
    if (now - last < w.cooldownMin * 60000) return; // 같은 심볼·같은 종류는 쿨다운 중
    this._cooldown.set(key, now);

    const alert = {
      id: nextId(),
      ts: now,
      symbol: candidate.symbol,
      display: candidate.display,
      kind: candidate.kind,
      severity: candidate.severity,
      message: candidate.message,
      value: candidate.value,
      threshold: candidate.threshold,
      price: candidate.price,
      // 계약 외 부가 필드 — 화면·텔레그램 표기 편의용
      priceText: candidate.priceText,
      quiet: !!quiet,
    };

    this.alerts.unshift(alert);
    if (this.alerts.length > MAX_ALERTS) this.alerts.length = MAX_ALERTS;
    this.alertCount += 1;

    // 방송은 조용시간에도 한다(기록·화면은 살아 있어야 한다).
    try {
      this.emit('alert', alert);
    } catch (e) {
      console.error('[watcher] alert 리스너 오류:', e && e.message ? e.message : e);
    }

    if (quiet) return; // 조용시간: 텔레그램·자동분석 금지

    this._sendAlert(alert, cfg);
    this._maybeAutoAnalyze(alert, cfg, w).catch((e) => {
      console.error('[watcher] 자동분석 게이트 오류:', e && e.message ? e.message : e);
    });
    this._maybeReviewPosition(alert, cfg, w).catch((e) => {
      console.error('[watcher] 포지션 검토 오류:', e && e.message ? e.message : e);
    });
  }

  _sendAlert(alert, cfg) {
    if (!this._notify || typeof this._notify.sendAlert !== 'function') return;
    try {
      const p = this._notify.sendAlert(alert, cfg);
      if (p && typeof p.catch === 'function') {
        p.catch((e) => console.error('[watcher] 알림 발송 실패:', e && e.message ? e.message : e));
      }
    } catch (e) {
      console.error('[watcher] 알림 발송 오류:', e && e.message ? e.message : e);
    }
  }

  // --- 자동 분석 --------------------------------------------------------

  async _maybeAutoAnalyze(alert, cfg, w) {
    // 모든 신호에 후보 ID를 붙여, 관문 통과·탈락 → 분석 계획 → 실행 결과를 한 줄로 잇는다.
    if (this._candidateLog && typeof this._candidateLog.newCandidateId === 'function' && !alert.candidateId) {
      alert.candidateId = this._candidateLog.newCandidateId();
    }
    let features = null; // 구조 필터에서 시장 데이터를 가져오면 이후 기록에도 싣는다
    if (!w.autoAnalyze) {
      this._noteCandidate(alert, 'auto_off', false, '자동분석 꺼짐', null);
      return;
    }
    if (!this.engine || typeof this.engine.run !== 'function') return;

    // "출퇴근제" — 미장 시간대(09:30~16:00 America/New_York) 밖이면 신규 자동분석을
    // 시작하지 않는다. 이미 열려있는 포지션은 이 게이트와 무관하게(거래소에 걸린 손절이)
    // 계속 보호한다 — 여기서 막는 건 "새로 진입 판단을 시작하는 것"뿐이다.
    if (w.marketHoursOnly && !isUsMarketHours()) {
      this.lastAutoAnalyze = {
        ts: Date.now(),
        symbol: alert.symbol,
        result: '건너뜀(미장 시간대 아님)',
      };
      this._noteCandidate(alert, 'market_hours', false, '미장 시간대 아님', null);
      return;
    }

    // 진행 중이면 그냥 버린다 — 큐잉하지 않는다(시장은 이미 변했다).
    if (this.engine.running) {
      this.lastAutoAnalyze = {
        ts: Date.now(),
        symbol: alert.symbol,
        result: '건너뜀(분석 진행 중)',
      };
      this._noteCandidate(alert, 'running', false, '다른 분석 진행 중', null);
      return;
    }

    // 알림 종류 필터 — 거래량·펀딩비 등 단독 신호로는 12명 분석을 시작하지 않는다(기본은
    // 가격 움직임만). 종류가 없는 알림(구버전·테스트)은 기존처럼 통과시킨다.
    const allowedKinds = Array.isArray(w.analysisTriggerKinds) ? w.analysisTriggerKinds : ['move'];
    if (alert.kind && !allowedKinds.includes(alert.kind)) {
      this.lastAutoAnalyze = {
        ts: Date.now(),
        symbol: alert.symbol,
        result: `건너뜀(${alert.kind} 단독 신호는 분석을 시작하지 않음 — 알림만 전송)`,
      };
      this._noteCandidate(alert, 'kind', false, `${alert.kind} 단독 신호`, null);
      return;
    }

    // 차트 구조 필터 — 가격 트리거(kind:'move')일 때만 적용한다. "가격이 움직였다"는
    // 사실 하나만으로 12명을 다 돌리지 않고, 분석할 가치가 있는 자리인지 먼저 계산으로
    // 거른다. 서로 다른 두 철학을 나란히 후보로 둔다 — 어느 쪽이 정답인지 미리 정하지
    // 않는다(둘 다 통과해도, 하나만 통과해도, 나중에 결과 판정으로 어느 쪽이 실제로
    // 나은지 비교한다):
    //   추세 추종 — SMA20·MACD가 그 방향을 뒷받침하는지(structureAgreesWithDirection)
    //   역추세   — 최근 구간의 극단(하락 후 하단/상승 후 상단) 근처인지
    //             (reversalAgreesWithDirection). 워뇨띠 초기 매매 기록의 시장 데이터
    //             재분석(2026-09-25, 독립 재현 검증 완료)에서 구간 하단 20%/상단 20%
    //             진입 305건이 승률 78.0%·+6.72 BTC, 중간 40~60% 진입 140건은 승률이
    //             더 높은 76.4%인데도 -1.96 BTC 손실이었다 — 승률만으론 못 보는 차이다.
    //             다만 그 20%·60분 기준은 설명용으로 고른 값이지 검증된 최적값이
    //             아니라는 게 그 분석 자체의 경고다. 그대로 베끼지 않고 후보 생성 필터
    //             하나로만 쓰고, 실제 채택 여부는 결과 판정으로 정한다.
    // 둘 다 꺼져 있거나 지표 조회가 실패하면 보수적으로 거른다 — "모르면 뒷받침된다고
    // 못 본다"는 같은 원칙을 여기도 적용한다. 롱/숏 양쪽에 완전히 대칭으로 적용된다.
    // 거래량·펀딩·괴리 트리거는 방향 해석이 다르므로 건드리지 않는다.
    //
    // 한도 체크보다 먼저 두는 이유 — 한도 소진 중에도 "구조까지 통과했으면 진짜
    // 실행됐을 트리거"를 빠짐없이 기록해야 한다(바로 아래에서 기록한다). 순서가
    // 반대면 한도 소진 기간의 트리거 빈도를 전혀 못 재게 된다.
    if (alert.kind === 'move' && w.structureFilterEnabled !== false) {
      const direction = Number(alert.value) >= 0 ? 'up' : 'down';
      let trendAgrees = false;
      let reversalAgrees = false;
      if (
        this._market &&
        typeof this._market.fetchMarket === 'function' &&
        this._indicators &&
        typeof this._indicators.structureAgreesWithDirection === 'function'
      ) {
        try {
          const resolved = resolveSymbol(alert.symbol);
          const marketData = await this._market.fetchMarket(resolved);
          const ind = marketData && marketData.indicators;
          trendAgrees = this._indicators.structureAgreesWithDirection(direction, ind);
          if (w.reversalFilterEnabled !== false && typeof this._indicators.reversalAgreesWithDirection === 'function') {
            reversalAgrees = this._indicators.reversalAgreesWithDirection(direction, ind, { bandPct: w.reversalBandPct });
          }
          if (this._candidateLog && typeof this._candidateLog.indicatorSnapshot === 'function') {
            features = this._candidateLog.indicatorSnapshot(ind);
            if (features) features.rangePosition = this._indicators.rangePosition ? this._indicators.rangePosition(ind && ind.price, ind && ind.low20, ind && ind.high20) : null;
          }
        } catch (e) {
          trendAgrees = false;
          reversalAgrees = false;
        }
      } else {
        trendAgrees = true; // 필요한 모듈이 없으면(테스트 등) 기존 동작을 그대로 유지한다
      }
      const agrees = trendAgrees || reversalAgrees;
      const signals = [trendAgrees && 'trend', reversalAgrees && 'reversal'].filter(Boolean);
      if (features) features.signals = signals;
      if (!agrees) {
        this.lastAutoAnalyze = {
          ts: Date.now(),
          symbol: alert.symbol,
          result: '건너뜀(차트 구조 불일치 — 추세·역추세 어느 쪽도 이 방향을 뒷받침하지 않음)',
        };
        this._noteCandidate(alert, 'structure', false, '추세·역추세 어느 쪽도 방향을 뒷받침하지 않음', features);
        return;
      }
    }

    // 한도와 완전히 무관하게 "여기까지 왔으면 진짜 실행됐을 트리거"를 기록한다 —
    // API 전환 시 실제 비용을 감이 아니라 데이터로 계산하기 위한 용도다. 기록
    // 실패는 절대 감시 흐름을 막지 않는다(trigger-log.js 안에서 이미 보장한다).
    if (this._triggerLog && typeof this._triggerLog.recordTrigger === 'function') {
      this._triggerLog.recordTrigger({ symbol: alert.symbol, kind: alert.kind });
    }

    // 한도 소진이 감지된 상태면(engine.js가 최근 실행에서 발견해 기록해둔다) 리셋
    // 시각까지 새 분석을 아예 시작하지 않는다 — 실전에서 이걸 안 걸어뒀더니 한 시간
    // 남짓 사이에 서로 다른 종목으로 7번이나 똑같이 실패하며 텔레그램만 울린 걸
    // 보고 추가했다. 진짜 급한 신호(critical 알림)라도 한도 자체가 없으면 분석이
    // 안 되는 건 마찬가지라 예외를 두지 않는다.
    if (this.engine.quotaExhaustedUntil && Date.now() < this.engine.quotaExhaustedUntil) {
      const resetAt = new Date(this.engine.quotaExhaustedUntil).toISOString();
      this.lastAutoAnalyze = {
        ts: Date.now(),
        symbol: alert.symbol,
        result: `건너뜀(한도 소진 — ${resetAt} UTC까지 재시도 안 함)`,
      };
      this._noteCandidate(alert, 'quota', false, `한도 소진(${resetAt} UTC까지)`, features);
      return;
    }

    // 전역 최소 간격 — claude 호출은 비싸다. 여러 심볼이 동시에 터져도 연쇄 실행을 막는다.
    const gapMs = w.autoGapMin * 60000;
    if (gapMs > 0 && this.lastAutoAnalyzeAt && Date.now() - this.lastAutoAnalyzeAt < gapMs) {
      this.lastAutoAnalyze = {
        ts: Date.now(),
        symbol: alert.symbol,
        result: `건너뜀(자동분석 최소 간격 ${w.autoGapMin}분)`,
      };
      this._noteCandidate(alert, 'gap', false, `최소 간격 ${w.autoGapMin}분`, features);
      return;
    }

    // 하루 분석 상한(급변 칸) — 실제로 분석을 시작하는 순간에만 1회 차감한다. 앞의 게이트
    // (장 시간·진행 중·한도 소진·최소 간격)에서 걸러진 건 차감하지 않는다. 설정이 없으면
    // (테스트 등) 상한을 적용하지 않는다 — 운영에서는 readWatchCfg가 항상 기본값을 채운다.
    if (w.analysisBudget && w.analysisBudget.enabled !== false && this._budget && typeof this._budget.consume === 'function') {
      const b = this._budget.consume('move', w.analysisBudget);
      if (!b.ok) {
        this.lastAutoAnalyze = {
          ts: Date.now(),
          symbol: alert.symbol,
          result: `건너뜀(${b.reason})`,
        };
        this._noteCandidate(alert, 'budget', false, b.reason, features);
        return;
      }
    }

    this.lastAutoAnalyzeAt = Date.now();
    this.lastAutoAnalyze = {
      ts: Date.now(),
      symbol: alert.symbol,
      mode: w.autoMode,
      result: '실행',
    };
    this._noteCandidate(alert, 'analyzed', true, null, features);
    // 감시 루프를 붙잡지 않도록 분리 실행한다.
    this._runAndNotify(alert, w.autoMode, cfg).catch((e) => {
      console.error('[watcher] 자동분석 오류:', e && e.message ? e.message : e);
    });
  }

  // engine.run 을 돌리면서 SSE 이벤트를 가로채 판정을 모으고, 끝나면 텔레그램으로 보낸다.
  // 후보 기록 — 실패해도 감시 흐름을 막지 않는다(candidate-log가 예외를 삼키지만 한 번 더 감싼다).
  _noteCandidate(alert, stage, passed, reason, features) {
    if (!this._candidateLog || typeof this._candidateLog.recordCandidate !== 'function') return;
    try {
      this._candidateLog.recordCandidate({
        candidateId: alert.candidateId,
        source: 'watcher',
        symbol: alert.symbol,
        kind: alert.kind,
        value: alert.value,
        severity: alert.severity,
        price: alert.price,
        stage,
        passed,
        reason,
        features,
      });
    } catch (_) {
      /* 기록 실패는 무시 */
    }
  }

  async _runAndNotify(alert, mode, cfg) {
    const engine = this.engine;
    const cap = { decision: null, market: null, saved: null, error: null, display: alert.symbol };
    const onEvt = (evt) => {
      if (!evt || !evt.type) return;
      if (evt.type === 'run:start') cap.display = evt.display || cap.display;
      else if (evt.type === 'market') cap.market = evt;
      else if (evt.type === 'decision') cap.decision = evt;
      else if (evt.type === 'saved') cap.saved = evt.path;
      else if (evt.type === 'run:error') cap.error = evt.message;
    };
    let busy = false;
    engine.on('event', onEvt);
    try {
      await engine.run(alert.symbol, { mode, candidateId: alert.candidateId, source: 'watcher' });
    } catch (e) {
      // engine 은 동시 실행을 409 로 거절한다. 이건 '실패'가 아니라 경합이므로
      // 텔레그램으로 알리지 않는다(그냥 이번 알림은 버린다).
      busy = e && e.code === 409;
      cap.error = e && e.message ? e.message : String(e);
    } finally {
      engine.removeListener('event', onEvt);
    }

    this.lastAutoAnalyze = {
      ts: Date.now(),
      symbol: alert.symbol,
      mode,
      result: cap.decision
        ? `판정 ${cap.decision.action}`
        : busy
        ? '건너뜀(분석 진행 중)'
        : cap.error
        ? '실패'
        : '판정 없음',
      message: busy ? null : cap.error || null,
    };

    if (!this._notify || busy) return;
    try {
      if (cap.decision) {
        const decision = {
          ...cap.decision,
          symbol: cap.display,
          mode,
          reportPath: cap.saved,
        };
        const market = cap.market
          ? { ...cap.market, display: cap.display }
          : { display: cap.display };
        await this._notify.sendDecision(decision, market, cfg);
      } else if (cap.error && typeof this._notify.sendMessage === 'function') {
        await this._notify.sendMessage(
          `⚠️ <b>자동분석 실패</b> · ${esc(alert.display || alert.symbol)}\n` +
            `${esc(cap.error)}\n\n— AI 시뮬레이션, 투자 조언 아님`,
          cfg
        );
      }
    } catch (e) {
      console.error('[watcher] 자동분석 알림 실패:', e && e.message ? e.message : e);
    }
  }

  // --- 포지션 청산 검토(익절/손절선 조정) ---------------------------------
  //
  // 손절은 진입 시점에 거래소에 미리 걸어두지만, 목표가는 기록만 될 뿐 주문으로
  // 걸리지 않는다 — 목표가 도달 전에도 상황이 바뀌면 더 들고 갈 수도, 일찍 정리할
  // 수도 있어야 해서다. 그래서 가격이 움직여 알림이 뜰 때마다(_raise가 이미 하는
  // 주기적 조회를 재사용한다 — 별도 폴링을 새로 만들지 않는다), 그 심볼에 실제로
  // 열려있는 거래소 포지션이 있으면 "유지/청산/손절선 조정"을 다시 판단한다.

  async _maybeReviewPosition(alert, cfg, w) {
    // 거래량·펀딩비 같은 출렁이는 신호로는 익절 AI 검토를 부르지 않는다 — 포지션 상태와
    // 무관한 소음이다. (2단계에서 이 검토 자체를 "근거 무효화 감지" 방식으로 교체 예정.)
    if (alert && alert.kind && alert.kind !== 'move') return;
    const full = cfg || {};
    const execCfg = full.execution || {};
    if (!execCfg.enabled) return; // 실행 자체가 꺼져있으면 검토할 실제 포지션이 있을 수 없다

    // 같은 심볼에 대해 전체 분석(12명)이 이미 진행 중이면 검토를 양보한다 — 전체 분석의
    // 마지막 단계(포지션 충돌 조정)가 어차피 이 포지션을 다시 살펴본다. 가벼운 검토가
    // 먼저 끝나서(익절/손절선 조정 같은) 뭔가 바꿔놓으면, 뒤늦게 끝난 전체 분석이 그걸
    // 모른 채 또 판단해서 서로 엇갈릴 수 있다 — 위험하진 않지만(reduceOnly라 이중 주문은
    // 안 나간다) AI 호출과 텔레그램 알림을 낭비한다. 더 종합적인 판단에 자리를 비켜준다.
    if (this.engine && this.engine.running && this.engine.runningSymbol === alert.symbol) {
      this.lastPositionReview = { ts: Date.now(), symbol: alert.symbol, action: '건너뜀(전체 분석 진행 중)' };
      return;
    }

    // 한도 소진 중이면 익절 검토도 건너뛴다 — 어차피 AI 호출이라 똑같이 실패한다.
    // 대신 트레일링 스탑(AI 없이 순수 계산)은 이 게이트와 무관하게 계속 작동해서
    // 최소한의 보호는 유지된다.
    if (this.engine && this.engine.quotaExhaustedUntil && Date.now() < this.engine.quotaExhaustedUntil) {
      this.lastPositionReview = { ts: Date.now(), symbol: alert.symbol, action: '건너뜀(한도 소진)' };
      return;
    }

    // 자동분석과 같은 "출퇴근제" 게이트 — 미장 시간대 밖의 가격 움직임은 신뢰할 수
    // 없다는 이유가 여기도 똑같이 적용된다.
    if (w.marketHoursOnly && !isUsMarketHours()) return;

    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET || !process.env.BINANCE_FUTURES_BASE_URL) return;
    if (!this._exchange || typeof this._exchange.createClient !== 'function') return;
    if (!this._agents || typeof this._agents.reviewPositionForExit !== 'function') return;

    let client;
    try {
      client = this._exchange.createClient({
        apiKey: process.env.BINANCE_API_KEY,
        apiSecret: process.env.BINANCE_API_SECRET,
        baseUrl: process.env.BINANCE_FUTURES_BASE_URL,
      });
    } catch (e) {
      return;
    }

    const resolved = resolveSymbol(alert.symbol);
    const exSymbol =
      'execSymbol' in resolved
        ? resolved.execSymbol
        : typeof this._exchange.toBinanceFuturesSymbol === 'function'
        ? this._exchange.toBinanceFuturesSymbol(alert.symbol)
        : null;
    if (!exSymbol) return; // 이 지역에서 실거래 지원 안 하는 종목(예: 삼성전자) 등

    let positionRisk;
    try {
      positionRisk = await client.getPosition(exSymbol);
    } catch (e) {
      return; // 조회 실패 — 다음 주기에 다시 시도한다
    }
    if (typeof this._exchange.summarizeOpenPosition !== 'function') return;
    const existing = this._exchange.summarizeOpenPosition(positionRisk);
    if (!existing) return; // 열려있는 실제 포지션이 없다 — 검토할 게 없다

    // 검토 전용 쿨다운 — 감시 알림·자동분석의 cooldownMin과는 별개 설정을 쓴다(시간
    // 단위). 익절 검토는 그만큼 자주 트리거될 필요가 없다 — 진짜 급한 움직임은 감시
    // 알림→자동분석→포지션 충돌 조정이라는 별도 경로로 이미 커버된다.
    //
    // 다만 이 쿨다운을 무조건 지키면 문제가 생긴다: 애매한 움직임에 검토가 한 번
    // 일어나 쿨다운 타이머가 갱신된 직후, 진짜 큰 움직임(예: 진입 후 1시간 만에
    // 5% 급등)이 와도 "아직 3시간 안 지났다"며 그냥 넘어가 버릴 수 있다. 그래서
    // 알림 severity가 'critical'(기준값의 2배 이상 — severityOf 참고)이면 쿨다운을
    // 무시하고 즉시 검토한다 — 이 정도 크기의 움직임은 기다릴 이유가 없다.
    const now = Date.now();
    const cdKey = `review|${exSymbol}`;
    const last = this._reviewCooldown.get(cdKey) || 0;
    const cooldownMs = (Number.isFinite(w.positionReviewCooldownHours) ? w.positionReviewCooldownHours : 3) * 3600000;
    const isCritical = alert && alert.severity === 'critical';
    if (!isCritical && now - last < cooldownMs) return;
    this._reviewCooldown.set(cdKey, now);

    // 이 심볼은 지금부터 "AI 검토 진행 중"으로 표시한다 — 트레일링 스탑이 같은 심볼의
    // 손절선을 동시에 건드리지 않도록 양보한다(둘 다 updateStopLoss를 쓰는데, 취소→
    // 재발주 사이에 서로 끼어들면 아주 짧은 순간 손절이 없는 상태가 생길 수 있다).
    // finally에서 반드시 지운다 — 함수가 어디서 끝나든(에러 포함) 락이 영원히 안 남게.
    this._reviewInFlight.add(exSymbol);
    try {

    // 원래 목표가·손절가·판정 근거는 거래소엔 없다(목표가는 개념상 기록만 되지 주문으로
    // 안 걸리고, 근거는 애초에 거래소가 알 이유가 없다) — 로컬 장부(positions.js)에서
    // 같은 심볼의 가장 최근 오픈 기록을 참고로 가져온다. 못 찾아도 검토 자체는 계속한다.
    // id도 같이 기억해둔다 — EXIT으로 정리될 때 로컬 장부도 같이 닫아야 하기 때문이다
    // (안 그러면 거래소엔 없는 포지션이 성적표엔 영원히 "열려있음"으로 남는다).
    let originalTarget = null;
    let originalStop = null;
    let originalRationale = null;
    let ledgerPositionId = null;
    if (this._positions && typeof this._positions.listPositions === 'function') {
      try {
        const list = this._positions.listPositions();
        const open = (list && list.open) || [];
        const matches = open.filter((p) => p && p.symbol === alert.symbol);
        matches.sort((a, b) => String(b.openedAt || '').localeCompare(String(a.openedAt || '')));
        if (matches[0]) {
          originalTarget = matches[0].target ?? null;
          originalStop = matches[0].stop ?? null;
          originalRationale = matches[0].rationale ?? null;
          ledgerPositionId = matches[0].id ?? null;
        }
      } catch (e) {
        // 장부 조회 실패 — 무시하고 계속한다.
      }
    }

    // 현재 기술 지표(SMA·RSI·MACD·최근 20일 고저) — AI 호출 없이 순수 계산이라 비용이
    // 없다. 가격만 보고 백지상태에서 판단하는 것보다, 최소한의 기술적 맥락은 있는 게
    // 낫다. 조회 실패해도 검토 자체는 계속한다(없이도 원래 근거만으로 판단할 수 있다).
    let indicatorLines = null;
    if (this._market && typeof this._market.fetchMarket === 'function') {
      try {
        const marketData = await this._market.fetchMarket(resolved);
        indicatorLines =
          marketData && marketData.indicators && Array.isArray(marketData.indicators.summaryLines)
            ? marketData.indicators.summaryLines
            : null;
      } catch (e) {
        // 지표 조회 실패 — 무시하고 계속한다.
      }
    }

    let verdict;
    try {
      verdict = await this._agents.reviewPositionForExit({
        symbol: exSymbol,
        display: alert.display || alert.symbol,
        existing: { ...existing, originalTarget, originalStop, originalRationale },
        trigger: alert.message,
        indicatorLines,
      });
    } catch (e) {
      console.error('[watcher] 포지션 검토 판단 실패:', e && e.message ? e.message : e);
      return;
    }

    const action = String((verdict && verdict.action) || 'KEEP').toUpperCase();
    this.lastPositionReview = { ts: now, symbol: exSymbol, action };

    if (action === 'EXIT') {
      const res = await this._exchange.closeExistingPosition(
        { symbol: exSymbol, side: existing.side, quantity: existing.quantity },
        client
      );
      // 거래소에서 실제로 정리됐으면 로컬 장부도 같이 닫는다 — 성적표가 실제 상태와
      // 어긋나지 않게 유지한다. 장부 갱신이 실패해도(예: id를 못 찾음) 실제 거래소
      // 청산은 이미 끝났으니 계속 진행한다(알림은 그대로 나간다).
      if (res.ok && ledgerPositionId && this._positions && typeof this._positions.closePosition === 'function') {
        try {
          this._positions.closePosition(ledgerPositionId, {
            price: existing.markPrice,
            reason: 'AI 판단(익절/손절 검토) — 청산',
          });
        } catch (e) {
          console.error('[watcher] 로컬 장부 청산 갱신 실패:', e && e.message ? e.message : e);
        }
      }
      await this._notifyReview(
        { type: 'exit', symbol: exSymbol, reasoning: verdict.reasoning, resultOk: !!res.ok, resultError: res.error },
        full
      );
      return;
    }

    if (action === 'TIGHTEN_STOP') {
      const newStop = Number(verdict.newStopPrice);
      if (!(newStop > 0)) return; // AI가 구체적 가격을 안 줬다 — 안전하게 아무것도 안 함
      const res = await this._exchange.updateStopLoss({ symbol: exSymbol, side: existing.side, newStopPrice: newStop }, client);
      await this._notifyReview(
        {
          type: 'tighten_stop',
          symbol: exSymbol,
          newStopPrice: newStop,
          reasoning: verdict.reasoning,
          resultOk: !!res.ok,
          resultError: res.error,
        },
        full
      );
    }
    // action === 'KEEP' — 아무것도 안 함(가장 흔한 경우, 알림도 안 보낸다 — 매번
    // "유지합니다"라고 알리면 그 자체가 소음이 된다. 실제로 뭔가 바뀔 때만 알린다).
    } finally {
      this._reviewInFlight.delete(exSymbol);
    }
  }

  async _notifyReview(review, cfg) {
    if (!this._notify || typeof this._notify.sendExecutionEvent !== 'function') return;
    try {
      await this._notify.sendExecutionEvent({ review }, cfg);
    } catch (e) {
      console.error('[watcher] 포지션 검토 알림 실패:', e && e.message ? e.message : e);
    }
  }

  // --- 트레일링 스탑(따라가는 손절) — AI 없이, 매 틱마다 ---------------------------
  //
  // 익절 검토(_maybeReviewPosition)는 AI 판단이라 한도가 없으면 아예 안 돈다. 그 공백을
  // 메우는 게 이거다: 순수 계산(진입 이후 고점 − ATR×배수)이라 한도와 완전히 무관하게
  // 항상 작동한다. "+10% 수익 상태에서 한도가 없어 검토가 안 되는 사이 큰 음봉이 뜨면
  // 원래 손절(-2%)까지 다 밀려야 정리된다"는 공백을, "손절선이 최소한 고점 대비 일정폭
  // 아래로는 계속 따라 올라가 있다"로 메운다 — 본전 밑으로 절대 안 내려가는 게 보장은
  // 아니지만(ATR 폭에 따라 다르다), 원래 손절선보다는 훨씬 유리한 지점에서 보호된다.

  async _maybeTrailStops(cfg, w) {
    const full = cfg || {};
    const execCfg = full.execution || {};
    if (!execCfg.enabled) return;
    if (w.marketHoursOnly && !isUsMarketHours()) return;
    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET || !process.env.BINANCE_FUTURES_BASE_URL) return;
    if (!this._exchange || typeof this._exchange.createClient !== 'function') return;
    if (!this._market || typeof this._market.fetchMarket !== 'function') return;
    if (!this._indicators || typeof this._indicators.atr14 !== 'function') return;

    let client;
    try {
      client = this._exchange.createClient({
        apiKey: process.env.BINANCE_API_KEY,
        apiSecret: process.env.BINANCE_API_SECRET,
        baseUrl: process.env.BINANCE_FUTURES_BASE_URL,
      });
    } catch (e) {
      return;
    }

    let allRaw;
    try {
      allRaw = await client.getPosition(); // 심볼 없이 — 계정 전체 열린 포지션 한 번에
    } catch (e) {
      return;
    }
    if (typeof this._exchange.summarizeAllOpenPositions !== 'function') return;
    const openPositions = this._exchange.summarizeAllOpenPositions(allRaw);
    if (!openPositions.length) return;

    const watchlist = Array.isArray(full.watchlist) ? full.watchlist : [];

    for (const pos of openPositions) {
      // 이 거래소 포지션이 워치리스트의 어느 내부 심볼에 해당하는지 찾는다 — 워치리스트
      // 밖 종목(수동으로 열린 것 등)은 지표를 조회할 방법이 마땅치 않아 관리 대상에서
      // 뺀다(트레일링 스탑을 아예 안 거는 것이, 틀린 지표로 잘못 거는 것보다 낫다).
      let resolved = null;
      for (const raw of watchlist) {
        const r = resolveSymbol(raw);
        const ex =
          'execSymbol' in r
            ? r.execSymbol
            : typeof this._exchange.toBinanceFuturesSymbol === 'function'
            ? this._exchange.toBinanceFuturesSymbol(raw)
            : null;
        if (ex && ex === pos.symbol) {
          resolved = r;
          break;
        }
      }
      if (!resolved) continue;

      // 이 심볼에 대해 AI 검토(익절/손절 판단)가 지금 진행 중이면 이번 틱은 건너뛴다 —
      // 둘 다 updateStopLoss(취소→재발주)를 쓰는데, 동시에 끼어들면 아주 짧은 순간
      // 손절이 없는 상태가 생길 수 있다. 다음 틱(60초 뒤)에 다시 시도한다.
      if (this._reviewInFlight.has(pos.symbol)) continue;

      // 로컬 장부에서 진입 시각·현재 손절가를 찾는다 — 기준 손절가를 모르면 "더
      // 유리한지" 비교 자체가 안 되므로 계산을 건너뛴다(안전한 기본값).
      let openedAt = null;
      let currentStop = null;
      if (this._positions && typeof this._positions.listPositions === 'function') {
        try {
          const list = this._positions.listPositions();
          const open = (list && list.open) || [];
          const matches = open.filter((p) => p && p.symbol === resolved.symbol);
          matches.sort((a, b) => String(b.openedAt || '').localeCompare(String(a.openedAt || '')));
          if (matches[0]) {
            openedAt = matches[0].openedAt;
            currentStop = matches[0].stop;
          }
        } catch (e) {
          continue;
        }
      }
      if (currentStop == null) continue;

      let marketData;
      try {
        marketData = await this._market.fetchMarket(resolved);
      } catch (e) {
        continue;
      }
      const candles = marketData && Array.isArray(marketData.candles) ? marketData.candles : [];
      const atr = this._indicators.atr14(candles);
      const sinceMs = openedAt ? Date.parse(openedAt) : null;
      const hl =
        typeof this._indicators.highLowSince === 'function'
          ? this._indicators.highLowSince(candles, Number.isFinite(sinceMs) ? sinceMs : null)
          : { high: null, low: null };

      const desired = this._exchange.computeTrailingStop({
        side: pos.side,
        highSinceEntry: hl.high,
        lowSinceEntry: hl.low,
        atr,
        atrMultiple: w.trailAtrMultiple,
        currentStop,
      });
      if (desired == null) continue; // 갱신할 게 없다(기존이 이미 더 유리하거나 데이터 부족)

      const res = await this._exchange.updateStopLoss({ symbol: pos.symbol, side: pos.side, newStopPrice: desired }, client);
      if (res.ok && this._positions && typeof this._positions.updateStopInLedger === 'function') {
        try {
          this._positions.updateStopInLedger(resolved.symbol, desired);
        } catch (e) {
          // 장부 갱신 실패해도 실제 거래소 손절은 이미 걸렸으니 계속 진행한다.
        }
      }
      this.lastTrailStop = { ts: Date.now(), symbol: pos.symbol, newStop: desired, ok: !!res.ok };
      await this._notifyReview(
        {
          type: 'tighten_stop',
          symbol: pos.symbol,
          newStopPrice: desired,
          reasoning:
            '트레일링 스탑(AI 없이 자동 계산) — 진입 이후 고점 대비 ATR 기준 여유폭만큼 손절선을 따라 올렸습니다.',
          resultOk: !!res.ok,
          resultError: res.error,
        },
        full
      );
    }
  }

  // --- 시세 조회 (전부 최소 호출) ---------------------------------------

  async _json(url, headers) {
    const res = await this._fetch(url, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      ...(headers ? { headers } : {}),
    });
    if (!res || !res.ok) {
      throw new Error(`HTTP ${res && res.status != null ? res.status : '?'}`);
    }
    return res.json();
  }

  // Binance kline 배열 → { closes, vols }
  static _klines(arr) {
    if (!Array.isArray(arr) || !arr.length) return { closes: [], vols: [] };
    return {
      closes: arr.map((k) => num(k[4])),
      vols: arr.map((k) => num(k[5])),
    };
  }

  // 코인: 현물 1분봉 + 24hr ticker (+ 무기한 펀딩. 무기한이 없으면 그냥 null)
  async _probeCrypto(resolved, limit) {
    const pair = `${resolved.symbol}USDT`;
    const [kR, tR, fR] = await Promise.allSettled([
      this._json(`${BINANCE_SPOT}/klines?symbol=${pair}&interval=1m&limit=${limit}`),
      this._json(`${BINANCE_SPOT}/ticker/24hr?symbol=${pair}`),
      this._json(`${BINANCE_FAPI}/premiumIndex?symbol=${pair}`),
    ]);
    if (kR.status !== 'fulfilled' && tR.status !== 'fulfilled') {
      throw new Error('바이낸스 시세 조회 실패');
    }
    const k = kR.status === 'fulfilled' ? Watcher._klines(kR.value) : { closes: [], vols: [] };
    const t = tR.status === 'fulfilled' ? tR.value : {};
    const f = fR.status === 'fulfilled' ? fR.value : {};
    const price =
      num(t.lastPrice) != null
        ? num(t.lastPrice)
        : k.closes.length
        ? k.closes[k.closes.length - 1]
        : null;
    return {
      price,
      changePct: num(t.priceChangePercent),
      closes: k.closes,
      vols: k.vols,
      fundingPct: f.lastFundingRate != null ? num(f.lastFundingRate) * 100 : null,
      cs: '$',
      source: `바이낸스 현물 ${pair}`,
    };
  }

  // 한국주식: 체결이 일어나는 USDⓈ-M 무기한 축(CLAUDE.md 이중 가격 체계).
  async _probeKrPerp(resolved, limit) {
    const perpSym = ((KR_STOCKS[resolved.symbol] || {}).perps || {}).binance || null;
    if (!perpSym) throw new Error('무기한 선물 미상장(바이낸스)');
    const [kR, tR, fR] = await Promise.allSettled([
      this._json(`${BINANCE_FAPI}/klines?symbol=${perpSym}&interval=1m&limit=${limit}`),
      this._json(`${BINANCE_FAPI}/ticker/24hr?symbol=${perpSym}`),
      this._json(`${BINANCE_FAPI}/premiumIndex?symbol=${perpSym}`),
    ]);
    if (kR.status !== 'fulfilled' && tR.status !== 'fulfilled') {
      throw new Error('무기한 시세 조회 실패');
    }
    const k = kR.status === 'fulfilled' ? Watcher._klines(kR.value) : { closes: [], vols: [] };
    const t = tR.status === 'fulfilled' ? tR.value : {};
    const f = fR.status === 'fulfilled' ? fR.value : {};
    const price =
      num(t.lastPrice) != null
        ? num(t.lastPrice)
        : k.closes.length
        ? k.closes[k.closes.length - 1]
        : null;
    return {
      price,
      changePct: num(t.priceChangePercent),
      closes: k.closes,
      vols: k.vols,
      fundingPct: f.lastFundingRate != null ? num(f.lastFundingRate) * 100 : null,
      cs: '$',
      source: `바이낸스 무기한 ${perpSym}`,
    };
  }

  // 해외주식: Yahoo 1분봉 한 번으로 가격·거래량을 모두 얻는다.
  async _probeStock(resolved, limit) {
    const sym = resolved.yahoo || resolved.symbol;
    const d = await this._json(
      `${YAHOO_CHART}/${encodeURIComponent(sym)}?range=1d&interval=1m`,
      YAHOO_HEADERS
    );
    const r = d && d.chart && d.chart.result && d.chart.result[0];
    if (!r) throw new Error('야후 1분봉 없음');
    const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
    const closesAll = [];
    const volsAll = [];
    const cl = q.close || [];
    for (let i = 0; i < cl.length; i++) {
      if (cl[i] == null) continue; // 야후는 결측 구간을 null 로 남긴다
      closesAll.push(num(cl[i]));
      volsAll.push(q.volume && q.volume[i] != null ? num(q.volume[i]) : null);
    }
    const m = r.meta || {};
    const price =
      num(m.regularMarketPrice) != null
        ? num(m.regularMarketPrice)
        : closesAll.length
        ? closesAll[closesAll.length - 1]
        : null;
    const prev = num(m.previousClose) != null ? num(m.previousClose) : num(m.chartPreviousClose);
    return {
      price,
      changePct: prev && price != null ? ((price - prev) / prev) * 100 : null,
      closes: closesAll.slice(-limit),
      vols: volsAll.slice(-limit),
      fundingPct: null,
      cs: m.currency === 'KRW' ? '₩' : '$',
      source: `야후 ${sym} 1분봉`,
    };
  }

  // --- 괴리 계산 --------------------------------------------------------
  //
  // 괴리는 매 주기 계산한다(무기한 가격이 매번 새로우니까). 대신 분모인 환율·KRX
  // 종가는 캐시로 재사용해서 야후 호출을 TTL 간격으로만 낸다. KRX 종가는 장 마감
  // 후에는 어차피 고정값이라 캐시해도 정확도가 떨어지지 않는다.
  async _maybePremium(resolved, perpPrice) {
    try {
      const [rate, krx] = await Promise.all([this._usdKrw(), this._krxPrice(resolved.yahoo)]);
      if (!rate || !krx) return null;
      const perpKrw = perpPrice * rate;
      return ((perpKrw - krx) / krx) * 100;
    } catch (_) {
      return null;
    }
  }

  // market.js 와 같은 소스 순서: Yahoo KRW=X → open.er-api.com
  async _usdKrw() {
    const now = Date.now();
    if (this._fxCache.rate && now - this._fxCache.ts < FX_TTL_MS) return this._fxCache.rate;
    if (now < this._fxRetryAt) return this._fxCache.rate; // 직전 실패 — 잠깐 쉰다
    try {
      const d = await this._json(`${YAHOO_CHART}/KRW=X?range=1d&interval=1d`, YAHOO_HEADERS);
      const m = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
      const rate = m ? num(m.regularMarketPrice) : null;
      if (rate) {
        this._fxCache = { ts: now, rate, source: 'Yahoo KRW=X' };
        return rate;
      }
      throw new Error('환율 없음');
    } catch (_) {
      try {
        const d = await this._json(ER_API, { Accept: 'application/json' });
        const rate = d && d.rates ? num(d.rates.KRW) : null;
        if (rate) {
          this._fxCache = { ts: now, rate, source: 'exchangerate-api' };
          return rate;
        }
      } catch (_) {}
      this._fxRetryAt = now + FAIL_RETRY_MS;
      return this._fxCache.rate; // 캐시가 남아 있으면 그거라도 쓴다
    }
  }

  async _krxPrice(yahooSym) {
    if (!yahooSym) return null;
    const now = Date.now();
    const hit = this._krxCache.get(yahooSym);
    if (hit && now - hit.ts < KRX_TTL_MS) return hit.price;
    if (now < (this._krxRetryAt.get(yahooSym) || 0)) return hit ? hit.price : null;
    try {
      const d = await this._json(
        `${YAHOO_CHART}/${encodeURIComponent(yahooSym)}?range=1d&interval=1d`,
        YAHOO_HEADERS
      );
      const m = d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
      const price = m ? num(m.regularMarketPrice) : null;
      if (price) {
        this._krxCache.set(yahooSym, { ts: now, price });
        return price;
      }
    } catch (_) {}
    this._krxRetryAt.set(yahooSym, now + FAIL_RETRY_MS);
    return hit ? hit.price : null;
  }

  // --- 상태 -------------------------------------------------------------

  status() {
    const cfg = this._config();
    const w = readWatchCfg(cfg);
    const quiet = inQuietHours(w.quietHours);
    return {
      enabled: !!w.enabled,
      running: !!(this._started && w.enabled),
      started: this._started,
      intervalSec: w.intervalSec,
      watchlist: w.watchlist,
      triggers: {
        movePct: w.movePct,
        windowMin: w.windowMin,
        volumeMultiple: w.volumeMultiple,
        fundingAbs: w.fundingAbs,
        premiumPct: w.premiumPct,
      },
      autoAnalyze: w.autoAnalyze,
      autoMode: w.autoMode,
      marketHoursOnly: w.marketHoursOnly,
      isMarketOpen: isUsMarketHours(),
      cooldownMin: w.cooldownMin,
      quietHours: w.quietHours,
      quiet,
      engineRunning: !!(this.engine && this.engine.running),
      lastTickAt: this.lastTickAt,
      lastTickAgoSec:
        this.lastTickAt != null ? Math.round((Date.now() - this.lastTickAt) / 1000) : null,
      tickCount: this.tickCount,
      alertCount: this.alertCount,
      lastError: this.lastError,
      lastAutoAnalyzeAt: this.lastAutoAnalyzeAt,
      lastAutoAnalyze: this.lastAutoAnalyze,
      lastPositionReview: this.lastPositionReview,
      symbols: Array.from(this._last.values()),
      alerts: this.alerts.slice(0, MAX_ALERTS),
    };
  }
}

module.exports = { Watcher, inQuietHours, severityOf, readWatchCfg };

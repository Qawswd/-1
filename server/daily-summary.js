'use strict';

// daily-summary.js — 하루 한 번, 정해진 현지(뉴욕) 시각에 그날의 실거래 손익 요약을
// 텔레그램으로 보낸다. "완전 자동화"로 돌아가는 중에도 하루 마감 때 한 번은 사람이
// 결과를 받아보게 하려는 목적이다.
//
// 손익 숫자는 exchange.js의 getIncomeHistory/sumRealizedPnl을 그대로 재사용한다 —
// 하루 손실 한도 체크와 같은 데이터 소스를 쓴다(같은 숫자를 두 군데서 따로 계산해
// 어긋나는 일이 없게 하려고).
//
// 외부 npm 의존성 0.

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5분마다 "지금 보낼 시각인가"만 확인(가벼움)
const DEFAULT_AT_HHMM = '16:05'; // 미국 정규장 마감(16:00 America/New_York) 5분 뒤 기본값

// --------------------------------------------------------------------------
// 순수 함수 — 네트워크 없이 전부 유닛테스트 가능
// --------------------------------------------------------------------------

function nyDateKey(date) {
  // 'YYYY-MM-DD' — en-CA 로케일이 그 형식을 그대로 준다(별도 조립 불필요).
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date);
}

function nyHHMM(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  const hh = String(Number(map.hour) % 24).padStart(2, '0');
  return `${hh}:${map.minute}`;
}

// 오늘(뉴욕 기준) 아직 안 보냈고, 지금 현지 시각이 atHHMM 이후면 true.
// lastSentDateKey는 이전에 보낸 날짜(nyDateKey 형식) — 같은 날 두 번 안 보내는 장치다.
function shouldSend({ now, atHHMM, lastSentDateKey }) {
  const todayKey = nyDateKey(now);
  if (todayKey === lastSentDateKey) return false;
  return nyHHMM(now) >= (atHHMM || DEFAULT_AT_HHMM);
}

// --------------------------------------------------------------------------
// 스케줄러 — 모듈들을 주입받는다(테스트 시 가짜로 교체 가능).
// --------------------------------------------------------------------------

class DailySummaryScheduler {
  // activityFn(now) → { moveTriggers, scheduledRuns, maxMove15mPct, maxMoveSymbol } | null (선택)
  constructor({ loadConfig, exchangeMod, notifyMod, positionsMod, reconcileMod, intervalMs, activityFn } = {}) {
    this.loadConfig = loadConfig;
    this.activityFn = typeof activityFn === 'function' ? activityFn : null;
    this.exchangeMod = exchangeMod;
    this.notifyMod = notifyMod;
    this.positionsMod = positionsMod;
    this.reconcileMod = reconcileMod;
    this.intervalMs = Number.isFinite(intervalMs) ? intervalMs : DEFAULT_INTERVAL_MS;
    this.lastSentDateKey = null;
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => {
      this._tick().catch((e) => console.error('[daily-summary]', e && e.message ? e.message : e));
    }, this.intervalMs);
    if (this._timer.unref) this._timer.unref(); // 이 타이머가 프로세스 종료를 막지 않게
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // 실제로 지금 보내야 하는지 판단하고, 맞으면 데이터를 모아 보낸다. 테스트에서 직접
  // 호출하기 좋도록 now를 인자로 받을 수 있게 한다(기본은 현재 시각).
  async _tick(now = new Date()) {
    if (typeof this.loadConfig !== 'function') return;
    const cfg = this.loadConfig();
    const ds = (cfg && cfg.dailySummary) || {};
    if (!ds.enabled) return;

    if (!shouldSend({ now, atHHMM: ds.atHHMM, lastSentDateKey: this.lastSentDateKey })) return;

    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET || !process.env.BINANCE_FUTURES_BASE_URL) {
      // 실행이 설정 안 된 상태 — 보낼 실거래 데이터 자체가 없으니 조용히 건너뛴다.
      this.lastSentDateKey = nyDateKey(now);
      return;
    }
    if (!this.exchangeMod || typeof this.exchangeMod.createClient !== 'function') return;

    let client;
    try {
      client = this.exchangeMod.createClient({
        apiKey: process.env.BINANCE_API_KEY,
        apiSecret: process.env.BINANCE_API_SECRET,
        baseUrl: process.env.BINANCE_FUTURES_BASE_URL,
      });
    } catch (e) {
      console.error('[daily-summary] 클라이언트 생성 실패:', e.message);
      return;
    }

    let realizedPnl = null;
    let incomeBreakdown = null;
    try {
      const end = now.getTime();
      const start = end - 24 * 60 * 60 * 1000;
      const income = await client.getIncomeHistory({ startTime: start, endTime: end, limit: 1000 });
      // 순손익(실현손익 + 수수료 + 펀딩)을 기본으로 보여준다 — 실현손익만 보면 실제보다
      // 좋아 보인다(R09). 구버전 exchangeMod(테스트 등)면 예전 방식으로 대체한다.
      if (typeof this.exchangeMod.summarizeIncome === 'function') {
        incomeBreakdown = this.exchangeMod.summarizeIncome(income);
        realizedPnl = incomeBreakdown.net;
      } else {
        realizedPnl = this.exchangeMod.sumRealizedPnl(income);
      }
    } catch (e) {
      console.error('[daily-summary] 손익 조회 실패:', e.message);
    }

    let positions = [];
    try {
      const raw = await client.getPosition();
      positions = this.exchangeMod.summarizeAllOpenPositions(raw);
    } catch (e) {
      console.error('[daily-summary] 포지션 조회 실패:', e.message);
    }

    // 감시 활동(트리거·예약 분석·최대 변동) — 주입된 함수가 있을 때만. 실패해도 요약은 보낸다.
    let activity = null;
    if (typeof this.activityFn === 'function') {
      try {
        activity = await this.activityFn(now);
      } catch (e) {
        console.error('[daily-summary] 감시 활동 집계 실패:', e && e.message ? e.message : e);
      }
    }

    if (this.notifyMod && typeof this.notifyMod.sendDailySummary === 'function') {
      try {
        await this.notifyMod.sendDailySummary({ realizedPnl, positions, incomeBreakdown, activity }, cfg);
      } catch (e) {
        console.error('[daily-summary] 발송 실패:', e && e.message ? e.message : e);
      }
    }

    // 정합성 점검 — 로컬 장부와 거래소 실제 상태를 하루 한 번 대조한다. 일간 요약과
    // 같은 주기(하루 한 번)면 충분하다 — 실시간으로 지킬 이유는 없고, 실제 안전(손절
    // 유무)은 서버 재시작 시 startup-audit이 이미 독립적으로 확인해준다.
    if (this.reconcileMod && typeof this.reconcileMod.reconcilePositions === 'function') {
      try {
        await this.reconcileMod.reconcilePositions({
          exchangeMod: this.exchangeMod,
          positionsMod: this.positionsMod,
          notifyMod: this.notifyMod,
          cfg,
        });
      } catch (e) {
        console.error('[daily-summary] 정합성 점검 실패:', e && e.message ? e.message : e);
      }
    }

    // 발송 성공/실패와 무관하게 "오늘은 시도했다"로 표시한다 — 실패했다고 5분마다
    // 계속 재시도하면(예: 텔레그램이 하루 종일 막혀있는 상황) 스팸이 될 수 있다.
    this.lastSentDateKey = nyDateKey(now);
  }
}

module.exports = { DailySummaryScheduler, shouldSend, nyDateKey, nyHHMM, DEFAULT_AT_HHMM };

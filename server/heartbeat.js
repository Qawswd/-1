'use strict';

// heartbeat.js — 서버 무응답 알림(Phase 2a 준비물, 2026-10-16).
// 서버가 죽으면 서버가 스스로 알릴 수 없다 — 그래서 서버가 살아 있는 동안 intervalMin 마다 바깥 감시 서비스
// (healthchecks.io 같은 '신호가 끊기면 알려주는' 서비스)에 신호를 보내고, 신호가 끊기면 그 서비스가 오너에게 알린다.
// .env 의 HEALTHCHECK_URL 이 비어 있으면 아무것도 안 한다. 신호 실패는 조용히 넘긴다(감시 서비스가 '끊김'으로 알린다).

class Heartbeat {
  constructor({ url = process.env.HEALTHCHECK_URL, intervalMin = 5, fetchImpl } = {}) {
    this.url = String(url || '').trim();
    this.intervalMs = Math.max(1, Number(intervalMin) || 5) * 60000;
    this.fetchImpl = fetchImpl || fetch;
    this._timer = null;
    this.lastOkAt = null;
    this.lastError = null;
  }

  enabled() {
    return /^https:\/\//.test(this.url);
  }

  async ping() {
    if (!this.enabled()) return false;
    try {
      const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.lastOkAt = Date.now();
      this.lastError = null;
      return true;
    } catch (e) {
      this.lastError = e.message;
      return false;
    }
  }

  start() {
    if (!this.enabled() || this._timer) return false;
    this.ping();
    this._timer = setInterval(() => this.ping(), this.intervalMs);
    if (this._timer.unref) this._timer.unref();
    return true;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { Heartbeat };

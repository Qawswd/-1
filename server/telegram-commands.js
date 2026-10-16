'use strict';

// telegram-commands.js — 텔레그램으로 서버에 명령(Phase 2a 준비물 '텔레그램 긴급 정지', 2026-10-16).
// 오너 채팅방(config.telegram.chatId)에서 온 메시지만 받는다. 폰만 쓰는 오너가 SSH 없이 바로 멈출 수 있게.
//   /상태 · /status      추세추종 계좌(순자산·포지션·손절) · Claude 선수 · 오너 기록 요약
//   /긴급정지 · /stop    확인 코드를 보낸다 → 2분 안에 '/stop 1234' : 추세추종 끄기 + BTC·ETH 포지션 전량 청산(손절 주문도 정리)
//   /재개 · /resume      확인 코드 → '/resume 1234' : 추세추종 다시 켬(다음 점검에서 규칙대로 다시 산다)
//   /도움 · /help        명령 목록
// 긴 폴링(getUpdates). 서버가 켜질 때 쌓여 있던 메시지는 건너뛴다 — 예전 /stop 이 뒤늦게 실행되지 않게.
// 오너가 직접 주문하는 기능이 아니다(오너는 주문하지 않는다) — 비상 정지와 재개만.

const crypto = require('crypto');
const EX = require('./exchange');

const API = 'https://api.telegram.org';
const CODE_TTL_MS = 2 * 60000;
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];

function parseCommand(text) {
  const t = String(text || '').trim();
  const m = /^\/?(\S+)(?:\s+(\d{4}))?\s*$/.exec(t);
  if (!m) return { cmd: null, code: null };
  const word = m[1].replace(/@\w+$/, '').toLowerCase();
  const map = { status: 'status', 상태: 'status', stop: 'stop', 긴급정지: 'stop', 정지: 'stop', resume: 'resume', 재개: 'resume', help: 'help', 도움: 'help', start: 'help' };
  return { cmd: map[word] || null, code: m[2] || null };
}

function telegramSettings(cfg) {
  const t = (cfg && cfg.telegram) || {};
  return {
    enabled: !!t.enabled,
    token: String(process.env.TELEGRAM_BOT_TOKEN || t.botToken || '').trim(),
    chatId: String(t.chatId == null ? '' : t.chatId).trim(),
  };
}

// 가격 표시 — 부동소수점 찌꺼기(2499.6399999999994) 없이
function fmtPrice(v) {
  const n = v == null || v === '' ? NaN : Number(v);
  if (!Number.isFinite(n)) return '-';
  return String(n >= 100 ? Math.round(n * 100) / 100 : Number(n.toPrecision(6)));
}

const HELP = [
  '<b>명령</b>',
  '/상태 — 추세추종 계좌·Claude 선수·대표님 기록',
  '/긴급정지 — 추세추종을 끄고 BTC·ETH 포지션을 전부 정리(확인 코드 필요)',
  '/재개 — 추세추종 다시 켜기(확인 코드 필요)',
].join('\n');

class TelegramCommander {
  constructor({ loadConfig, saveConfig, exchangeMod = EX, notifyMod, fetchImpl, now = () => Date.now(), makeClient } = {}) {
    Object.assign(this, { loadConfig, saveConfig, exchangeMod, notifyMod, now });
    this.fetchImpl = fetchImpl || fetch;
    this.makeClient = makeClient || (() => this.exchangeMod.createClient({ apiKey: process.env.BINANCE_API_KEY, apiSecret: process.env.BINANCE_API_SECRET, baseUrl: process.env.BINANCE_FUTURES_BASE_URL }));
    this.offset = null;
    this.pending = null; // { action, code, until }
    this._stopped = true;
    this._startedAt = 0;
  }

  async reply(text) {
    const cfg = this.loadConfig();
    if (this.notifyMod && typeof this.notifyMod.sendMessage === 'function') return this.notifyMod.sendMessage(text, cfg);
    return null;
  }

  async api(method, params, timeoutMs = 35000) {
    const { token } = telegramSettings(this.loadConfig());
    const qs = new URLSearchParams(params).toString();
    const res = await this.fetchImpl(`${API}/bot${token}/${method}?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok !== true) {
      const err = new Error(`[telegram] ${method} 실패: ${(data && data.description) || `HTTP ${res.status}`}`);
      err.status = res.status;
      throw err;
    }
    return data.result;
  }

  // 메시지 하나 처리 — 오너 채팅방에서 온 것만
  async handle(update) {
    const msg = update && (update.message || update.edited_message);
    if (!msg || !msg.chat) return null;
    const { chatId } = telegramSettings(this.loadConfig());
    if (!chatId || String(msg.chat.id) !== chatId) return null;
    if (Number(msg.date) * 1000 < this._startedAt - 5000) return null; // 서버 켜기 전 메시지
    const { cmd, code } = parseCommand(msg.text);
    if (!cmd) return null;
    if (cmd === 'help') return this.reply(HELP);
    if (cmd === 'status') return this.reply(await this.statusText());
    if (!code) {
      const c = String(crypto.randomInt(1000, 10000));
      this.pending = { action: cmd, code: c, until: this.now() + CODE_TTL_MS };
      const what = cmd === 'stop' ? '추세추종을 끄고 BTC·ETH 포지션을 <b>전부 정리</b>합니다' : '추세추종을 다시 켭니다(다음 점검에서 규칙대로 다시 삽니다)';
      return this.reply(`${cmd === 'stop' ? '🛑' : '▶️'} ${what}.\n정말 하려면 2분 안에 <b>/${cmd} ${c}</b> 를 보내세요.`);
    }
    const p = this.pending;
    if (!p || p.action !== cmd || p.code !== code || this.now() > p.until) {
      this.pending = null;
      return this.reply('확인 코드가 맞지 않거나 2분이 지났습니다. 처음부터 다시 보내세요.');
    }
    this.pending = null;
    return cmd === 'stop' ? this.emergencyStop() : this.resume();
  }

  async emergencyStop() {
    const lines = ['🛑 <b>긴급 정지</b>'];
    try {
      this.saveConfig({ trend: { enabled: false } });
      lines.push('추세추종 꺼짐 — 더 사지 않습니다');
    } catch (e) {
      lines.push(`⚠️ 설정 저장 실패: ${e.message}`);
    }
    let client;
    try {
      client = this.makeClient();
    } catch (e) {
      lines.push(`⚠️ 거래소 연결 실패: ${e.message} — 거래소 앱에서 직접 확인하세요`);
      return this.reply(lines.join('\n'));
    }
    for (const symbol of SYMBOLS) {
      try {
        const pos = this.exchangeMod.summarizeOpenPosition(await client.getPosition(symbol));
        if (!pos) {
          lines.push(`${symbol}: 포지션 없음`);
          continue;
        }
        const r = await this.exchangeMod.closeExistingPosition({ symbol, side: pos.side, quantity: pos.quantity }, client);
        lines.push(r.ok ? `${symbol}: ${pos.side === 'LONG' ? '롱' : '숏'} ${pos.quantity} 정리 완료` : `⚠️ ${symbol}: 정리 실패 — ${r.error}`);
      } catch (e) {
        lines.push(`⚠️ ${symbol}: 오류 — ${e.message} · 거래소 앱에서 직접 확인하세요`);
      }
    }
    lines.push('다시 켜려면 /재개');
    return this.reply(lines.join('\n'));
  }

  async resume() {
    try {
      this.saveConfig({ trend: { enabled: true } });
      return this.reply('▶️ 추세추종을 다시 켰습니다 — 다음 점검(한국 09:05)에서 규칙대로 비중을 맞춥니다.');
    } catch (e) {
      return this.reply(`⚠️ 다시 켜지 못했습니다: ${e.message}`);
    }
  }

  async statusText() {
    const cfg = this.loadConfig() || {};
    const lines = ['📋 <b>지금 상태</b>'];
    lines.push(`추세추종: ${cfg.trend && cfg.trend.enabled ? '켜짐' : '꺼짐'}`);
    try {
      const client = this.makeClient();
      const eq = this.exchangeMod.equityFromBalance(await client.getAccountBalance());
      lines.push(`시스템 계좌 순자산 ${eq ?? '데이터 없음'} USDT`);
      for (const symbol of SYMBOLS) {
        const pos = this.exchangeMod.summarizeOpenPosition(await client.getPosition(symbol));
        if (!pos) continue;
        const stop = this.exchangeMod.findExchangeStop(await client.getOpenAlgoOrders(symbol), pos.side);
        lines.push(`${symbol} ${pos.side === 'LONG' ? '롱' : '숏'} ${pos.quantity} @${fmtPrice(pos.entry)} (${pos.unrealizedPct}%) · 손절 ${stop == null ? '없음 ⚠️' : fmtPrice(stop)}`);
      }
    } catch (e) {
      lines.push(`계좌 조회 실패: ${e.message}`);
    }
    try {
      const CT = require('./claude-trader');
      const s = CT.loadState();
      if (s && s.startT) {
        const p = CT.effectiveParams(cfg.claudeTrader);
        const eq = CT.equityOf(s, {});
        lines.push(`Claude 선수: ${Math.round((eq / p.capital - 1) * 10000) / 100}% · 열린 ${s.positions.length}개 · 거래 ${s.closed.length}번`);
      }
    } catch (_) {
      /* 없으면 뺀다 */
    }
    try {
      const OR = require('./owner-record');
      const s = OR.loadState();
      if (s && s.baseT) lines.push(`대표님 기록: ${OR.chainReturns(s.snapshots).totalPct ?? 0}% · 청산 ${s.trades || 0}번 · 위반 ${(s.violationLog || []).length}번`);
      else if (cfg.ownerRecord && cfg.ownerRecord.enabled) lines.push('대표님 기록: 입금 기다림');
    } catch (_) {
      /* 없으면 뺀다 */
    }
    return lines.join('\n');
  }

  async start() {
    const s = telegramSettings(this.loadConfig());
    if (!s.enabled || !s.token || !s.chatId) return false;
    this._stopped = false;
    this._startedAt = this.now();
    try {
      // 쌓여 있던 메시지는 건너뛴다(마지막 것 다음부터)
      const backlog = await this.api('getUpdates', { offset: -1, timeout: 0 }, 15000);
      this.offset = backlog.length ? backlog[backlog.length - 1].update_id + 1 : null;
    } catch (e) {
      console.error(e.message);
    }
    this._loop();
    return true;
  }

  stop() {
    this._stopped = true;
  }

  async pollOnce() {
    const params = { timeout: 25, allowed_updates: JSON.stringify(['message']) };
    if (this.offset != null) params.offset = this.offset;
    const updates = await this.api('getUpdates', params);
    for (const u of updates) {
      this.offset = u.update_id + 1;
      try {
        await this.handle(u);
      } catch (e) {
        console.error('[telegram] 명령 처리 오류:', e.message);
      }
    }
    return updates.length;
  }

  async _loop() {
    while (!this._stopped) {
      try {
        await this.pollOnce();
      } catch (e) {
        // 409 = 웹훅이 걸려 있거나 다른 곳이 같은 봇으로 받는 중
        console.error(e.message);
        await new Promise((r) => setTimeout(r, e.status === 409 ? 60000 : 10000));
      }
    }
  }
}

module.exports = { parseCommand, telegramSettings, fmtPrice, TelegramCommander, CODE_TTL_MS };

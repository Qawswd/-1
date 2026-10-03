'use strict';

// reconcile.js — 로컬 장부(positions.json)가 "열려있다"는 것과 거래소가 실제로
// "열려있다"는 것을 대조한다. 하루에 한 번(daily-summary.js와 같은 주기)만 돌면
// 충분하다 — 실시간으로 지킬 이유는 없고(실제 안전은 startup-audit·트레일링 스탑이
// 이미 독립적으로 맡고 있다), 이건 "기록이 실제와 어긋나지 않았는지" 확인하는
// 뒷정리 성격이다.
//
// 두 가지 어긋남을 구분해서 다르게 다룬다:
// - 로컬엔 열려있다고 나오는데 거래소엔 없다(stale) → 실제 돈과 무관한 "기록 문제"라
//   안전하게 자동으로 정리한다(로컬 장부만 닫는다).
// - 거래소엔 있는데 로컬 기록이 없다(orphan) → 원래 목표가·근거를 알 방법이 없어
//   억지로 복원하지 않는다(무리한 자동 조치가 오히려 위험할 수 있다). 보고만 하고,
//   실제 보호(손절 유무)는 startup-audit이 로컬 기록과 무관하게 이미 확인해준다.

// --- 순수 함수 ---------------------------------------------------------------

// ledgerOpen(로컬 장부의 open 배열)과 exchangePositions(거래소 실제 열린 포지션,
// summarizeAllOpenPositions 형식)를 비교한다. toBinanceFuturesSymbol로 내부 심볼을
// 거래소 심볼로 변환해 맞춰본다(execSymbol이 있으면 그걸 우선한다).
function diffPositions(ledgerOpen, exchangePositions, toBinanceFuturesSymbol) {
  const ledger = Array.isArray(ledgerOpen) ? ledgerOpen : [];
  const exchange = Array.isArray(exchangePositions) ? exchangePositions : [];
  const exSymbols = new Set(exchange.map((p) => p && p.symbol).filter(Boolean));

  const ledgerExSymbolOf = (p) =>
    p && (p.execSymbol || (typeof toBinanceFuturesSymbol === 'function' ? toBinanceFuturesSymbol(p.symbol) : null));

  const staleInLedger = ledger.filter((p) => {
    const ex = ledgerExSymbolOf(p);
    return ex && !exSymbols.has(ex);
  });

  const ledgerExSymbols = new Set(ledger.map(ledgerExSymbolOf).filter(Boolean));
  const orphanOnExchange = exchange.filter((p) => p && p.symbol && !ledgerExSymbols.has(p.symbol));

  return { staleInLedger, orphanOnExchange };
}

// --- 오케스트레이션 ------------------------------------------------------------

async function reconcilePositions({ exchangeMod, positionsMod, notifyMod, cfg } = {}) {
  const report = { staleClosedCount: 0, orphanCount: 0, orphanSymbols: [] };

  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET || !process.env.BINANCE_FUTURES_BASE_URL) {
    return report;
  }
  if (!exchangeMod || typeof exchangeMod.createClient !== 'function') return report;
  if (!positionsMod || typeof positionsMod.listPositions !== 'function') return report;

  let client;
  try {
    client = exchangeMod.createClient({
      apiKey: process.env.BINANCE_API_KEY,
      apiSecret: process.env.BINANCE_API_SECRET,
      baseUrl: process.env.BINANCE_FUTURES_BASE_URL,
    });
  } catch (e) {
    return report;
  }

  let allRaw;
  try {
    allRaw = await client.getPosition();
  } catch (e) {
    return report; // 조회 실패 — 판단 근거가 없으니 이번엔 건드리지 않는다
  }
  const exchangePositions =
    typeof exchangeMod.summarizeAllOpenPositions === 'function' ? exchangeMod.summarizeAllOpenPositions(allRaw) : [];

  let ledgerOpen = [];
  try {
    const list = positionsMod.listPositions();
    ledgerOpen = (list && list.open) || [];
  } catch (e) {
    return report;
  }

  const { staleInLedger, orphanOnExchange } = diffPositions(ledgerOpen, exchangePositions, exchangeMod.toBinanceFuturesSymbol);

  // stale — 실제 돈과 무관한 기록 문제라 안전하게 자동으로 정리한다.
  if (staleInLedger.length && typeof positionsMod.closePosition === 'function') {
    for (const p of staleInLedger) {
      if (!p || !p.id) continue;
      try {
        positionsMod.closePosition(p.id, {
          reason: '정합성 점검 — 거래소엔 없는데 로컬 장부엔 "열려있음"으로 남아있어 자동 정리(정확한 청산가는 알 수 없음)',
        });
        report.staleClosedCount += 1;
      } catch (e) {
        // 하나 실패해도 나머지는 계속 처리한다.
      }
    }
  }

  // orphan — 원래 근거를 모르니 억지로 복원하지 않는다. 보고만 한다(실제 보호는
  // startup-audit이 로컬 기록과 무관하게 이미 확인한다).
  report.orphanCount = orphanOnExchange.length;
  report.orphanSymbols = orphanOnExchange.map((p) => p.symbol);

  if ((report.staleClosedCount > 0 || report.orphanCount > 0) && notifyMod && typeof notifyMod.sendExecutionEvent === 'function') {
    try {
      await notifyMod.sendExecutionEvent({ ok: true, reconcile: report }, cfg);
    } catch (e) {
      // 알림 실패해도 정리 자체는 이미 끝났다.
    }
  }

  return report;
}

module.exports = { diffPositions, reconcilePositions };

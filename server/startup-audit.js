'use strict';

// startup-audit.js — 서버가 켜질 때(재시작 포함) 딱 한 번, 지금 열려있는 모든 거래소
// 포지션에 실제로 손절(STOP_MARKET) 주문이 걸려있는지 확인한다. 없으면(예: 재시작이
// 하필 "손절 취소→재발주" 그 사이에 끼어든 경우) 사람 개입 없이 자동으로 복구한다:
//   1) 로컬 장부에 원래 손절가 기록이 있으면, 그 값 그대로 다시 건다(원래 보호 복원).
//   2) 그것도 실패하거나 원래 손절가를 모르면, 안전하게 즉시 청산한다(포지션을 보호
//      없이 남겨두는 것보다 낫다).
// 텔레그램은 "이런 일이 있었고 이렇게 조치했다"는 사후 보고용이지, 사람이 뭘 해야
// 한다는 요청이 아니다 — "완전 자동화"라는 원칙을 이 위기 대응 경로에서도 지킨다.

// --- 순수 함수 ---------------------------------------------------------------

// algoOrders 배열에 STOP류(STOP_MARKET 등) 주문이 하나라도 있으면 true.
// 대소문자·정확한 타입명에 관대하게 판단한다(거래소 응답 형식이 살짝 달라져도
// "STOP"이 들어간 타입이면 손절로 인정 — 과도하게 엄격해서 정상 보호를 놓치는
// 것보다, 조금 관대한 편이 안전하다).
// 바이낸스 알고 주문 조회(GET /fapi/v1/openAlgoOrders) 응답은 주문 종류를 `orderType`
// ("STOP_MARKET")에 담는다 — `type`이 아니다. 예전 코드는 `type`만 봐서 멀쩡한 손절을
// "없음"으로 판단했고, 재시작 때마다 손절을 취소·재발주했다(2026-09-24 실전에서 발견).
// 장부에 손절가가 없는 포지션이었다면 보호된 포지션을 강제 청산할 뻔했다. 두 필드를 다
// 보고, 포지션 방향을 알면 손절 방향(롱이면 SELL, 숏이면 BUY)까지 확인한다.
function hasStopOrder(algoOrders, positionSide) {
  if (!Array.isArray(algoOrders)) return false;
  const ps = String(positionSide || '').toUpperCase();
  const wantSide = ps === 'LONG' ? 'SELL' : ps === 'SHORT' ? 'BUY' : null;
  return algoOrders.some((o) => {
    if (!o) return false;
    const kind = typeof o.orderType === 'string' ? o.orderType : typeof o.type === 'string' ? o.type : '';
    if (!kind.toUpperCase().includes('STOP')) return false;
    const status = String(o.algoStatus || '').toUpperCase();
    if (status && !['NEW', 'PARTIALLY_FILLED'].includes(status)) return false; // 취소·만료·발동 완료는 보호 아님
    if (wantSide && o.side && String(o.side).toUpperCase() !== wantSide) return false; // 방향이 반대면 보호 아님
    return true;
  });
}

// 로컬 장부(open 배열)에서 거래소 심볼(exSymbol)에 해당하는 가장 최근 오픈 기록을
// 찾는다. execSymbol이 명시돼 있으면 그걸 우선 쓰고(SKHYNIX→SKHYUSDT 같은 경우),
// 없으면 toBinanceFuturesSymbol로 변환해 비교한다(크립토·미국주식 등 일반 경로).
function findLedgerMatch(openList, exSymbol, toBinanceFuturesSymbol) {
  if (!Array.isArray(openList)) return null;
  const matches = openList.filter((p) => {
    if (!p) return false;
    const ex = p.execSymbol || (typeof toBinanceFuturesSymbol === 'function' ? toBinanceFuturesSymbol(p.symbol) : null);
    return ex && ex === exSymbol;
  });
  if (!matches.length) return null;
  matches.sort((a, b) => String(b.openedAt || '').localeCompare(String(a.openedAt || '')));
  return matches[0];
}

// --- 오케스트레이션 ------------------------------------------------------------

async function auditAndFixUnprotectedPositions({ exchangeMod, positionsMod, notifyMod, cfg } = {}) {
  const report = { checked: 0, unprotected: [], fixed: [], flattened: [], failed: [] };

  if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET || !process.env.BINANCE_FUTURES_BASE_URL) {
    return report; // 실행 설정 자체가 없으면 점검할 실제 포지션이 있을 수 없다
  }
  if (!exchangeMod || typeof exchangeMod.createClient !== 'function') return report;

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
    allRaw = await client.getPosition(); // 심볼 없이 — 계정 전체 열린 포지션
  } catch (e) {
    return report;
  }
  const positions =
    typeof exchangeMod.summarizeAllOpenPositions === 'function' ? exchangeMod.summarizeAllOpenPositions(allRaw) : [];
  report.checked = positions.length;
  if (!positions.length) return report;

  const openLedger =
    positionsMod && typeof positionsMod.listPositions === 'function'
      ? ((positionsMod.listPositions() || {}).open || [])
      : [];

  for (const pos of positions) {
    let algoOrders;
    try {
      algoOrders = await client.getOpenAlgoOrders(pos.symbol);
    } catch (e) {
      // 조회 자체가 실패하면 판단할 근거가 없다 — 과잉 대응(멀쩡한 포지션을 잘못
      // 청산하는 것)을 피하려고 이번엔 건드리지 않는다. 다음 재시작 때 다시 확인된다.
      continue;
    }
    if (hasStopOrder(algoOrders, pos.side)) continue; // 정상 — 보호돼 있다

    report.unprotected.push(pos.symbol);

    const ledgerPos = findLedgerMatch(openLedger, pos.symbol, exchangeMod.toBinanceFuturesSymbol);
    const originalStop = ledgerPos && Number.isFinite(Number(ledgerPos.stop)) ? Number(ledgerPos.stop) : null;

    let fixedOk = false;
    if (originalStop != null && typeof exchangeMod.updateStopLoss === 'function') {
      try {
        const res = await exchangeMod.updateStopLoss({ symbol: pos.symbol, side: pos.side, newStopPrice: originalStop }, client);
        if (res.ok) {
          fixedOk = true;
          report.fixed.push({ symbol: pos.symbol, stop: originalStop });
        }
      } catch (e) {
        // 아래 청산 경로로 넘어간다 — 원래 손절 복원이 안 되면 안전하게 정리한다.
      }
    }

    if (!fixedOk) {
      // 원래 손절가를 모르거나(장부에 없음), 다시 거는 것도 실패했다 — 판단 근거 없이
      // 보호 없는 상태로 남겨두는 것보다, 안전하게 즉시 청산하는 쪽을 택한다.
      try {
        const res = await exchangeMod.closeExistingPosition(
          { symbol: pos.symbol, side: pos.side, quantity: pos.quantity },
          client
        );
        if (res.ok) {
          report.flattened.push(pos.symbol);
          if (ledgerPos && ledgerPos.id && positionsMod && typeof positionsMod.closePosition === 'function') {
            try {
              positionsMod.closePosition(ledgerPos.id, {
                price: pos.markPrice,
                reason: '서버 재시작 점검 — 무보호 포지션 자동 청산',
              });
            } catch (e) {
              // 장부 갱신 실패해도 실제 거래소 청산은 이미 끝났다.
            }
          }
        } else {
          report.failed.push({ symbol: pos.symbol, error: res.error });
        }
      } catch (e) {
        report.failed.push({ symbol: pos.symbol, error: e && e.message ? e.message : String(e) });
      }
    }
  }

  if (report.unprotected.length && notifyMod && typeof notifyMod.sendExecutionEvent === 'function') {
    try {
      await notifyMod.sendExecutionEvent({ ok: report.failed.length === 0, startupAudit: report }, cfg);
    } catch (e) {
      // 알림 실패해도 조치 자체는 이미 끝났다 — 조용히 넘어간다.
    }
  }

  return report;
}

module.exports = { hasStopOrder, findLedgerMatch, auditAndFixUnprotectedPositions };

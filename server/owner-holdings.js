'use strict';

// owner-holdings.js — 대표님이 실제로 들고 있는 것(2026-11-13 오너 '진입 · 유지 · 익절 신호 다 알려줘').
// 서버는 토스 · 업비트 계좌를 볼 수 없다 — 대표님이 텔레그램으로 /샀다 · /팔았다 를 보내면 여기 적고,
// 09:05 신호가 종목마다 '사기 · 유지 · 팔기 · 쉼'을 딱 집어 준다(owner-signal.todoLines). 돈·주문과는 상관없는 메모장이다.
// 파일: reports/owner-holdings.json { items: { MSFT: { avg: 543.43, stop: 407.57, since: '2026-11-10' } }, updatedAt }
//   주식 avg 는 달러(토스 '1주 평균' 아래 $ 숫자) · 코인 avg 는 원화(업비트 평균 매수가) — 코인 신호는 달러라 코인 avg 는 손절 예약 값 안내에만 쓴다.
//   stop: 주식 = avg × 0.75(종가로 본다) · 코인 = avg × 0.90(업비트 감시가). 더 사서 평균이 내려가도 손절은 내리지 않는다(docs/08).
// 테스트 중엔 실제 reports/ 파일을 읽지도 쓰지도 않는다.

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'reports', 'owner-holdings.json');
const COINS = Object.freeze(['BTC', 'ETH']);
const STOP_K = Object.freeze({ stock: 0.75, coin: 0.9 });
const LIMIT_K = 0.87; // 업비트 예약-지정가 주문 가격(감시가보다 조금 낮게)
const MAX_USD_STOCK = 5000; // 이보다 크면 원화로 보낸 것 — 주식은 달러로 받는다
const ALIAS = Object.freeze({ 비트코인: 'BTC', 비트: 'BTC', 이더리움: 'ETH', 이더: 'ETH', 엔비디아: 'NVDA', 마이크로소프트: 'MSFT', 마소: 'MSFT', 나스닥: 'QQQ', 큐큐큐: 'QQQ' });

let _path = FILE;
function _setPath(p) {
  _path = p || FILE;
}
const isDefault = () => _path === FILE && !!process.env.NODE_TEST_CONTEXT;

function kstDate(t) {
  return new Date(t + 9 * 3600000).toISOString().slice(0, 10);
}

function normSymbol(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  if (ALIAS[t]) return ALIAS[t];
  const u = t.toUpperCase().replace(/USDT$/, '').replace(/[^A-Z0-9.-]/g, '');
  return u || null;
}
const kindOf = (sym) => (COINS.includes(sym) ? 'coin' : 'stock');

// { known: 파일이 있었나(한 번이라도 알려 줬나), items, updatedAt }
function load() {
  if (isDefault()) return { known: false, items: {}, updatedAt: null };
  try {
    const j = JSON.parse(fs.readFileSync(_path, 'utf8'));
    const items = j && j.items && typeof j.items === 'object' && !Array.isArray(j.items) ? j.items : {};
    return { known: true, items, updatedAt: j.updatedAt || null };
  } catch {
    return { known: false, items: {}, updatedAt: null };
  }
}

function save(h) {
  if (isDefault()) return;
  fs.mkdirSync(path.dirname(_path), { recursive: true });
  fs.writeFileSync(`${_path}.tmp`, JSON.stringify({ items: h.items, updatedAt: h.updatedAt }, null, 1));
  fs.renameSync(`${_path}.tmp`, _path);
}

// 샀다(처음 · 더 삼 모두) → { ok, sym, item } | { ok:false, error }
function bought(symIn, { avg = null, now = Date.now() } = {}) {
  const sym = normSymbol(symIn);
  if (!sym) return { ok: false, error: '종목을 같이 보내 주세요 — 예: /샀다 QQQ 612.30' };
  const kind = kindOf(sym);
  const a = avg == null ? null : Number(avg);
  if (a != null && !(a > 0)) return { ok: false, error: '평균 단가는 숫자로 — 예: /샀다 QQQ 612.30' };
  if (kind === 'stock' && a != null && a > MAX_USD_STOCK) return { ok: false, error: `주식 평균 단가는 달러로 보내 주세요(토스 '1주 평균' 아래 $ 숫자) — ${a.toLocaleString('en-US')} 는 원화로 보입니다` };
  const h = load();
  const prev = h.items[sym] || null;
  const useAvg = a != null ? a : prev ? prev.avg : null;
  const fresh = useAvg != null ? useAvg * STOP_K[kind] : null;
  // 손절은 내리지 않는다 — 더 산 값이 낮아 평균이 내려가도 원래 손절 그대로
  const stop = prev && prev.stop > 0 && (fresh == null || prev.stop > fresh) ? prev.stop : fresh;
  const item = { avg: useAvg, stop, since: prev && prev.since ? prev.since : kstDate(now) };
  h.items = { ...h.items, [sym]: item };
  h.updatedAt = new Date(now).toISOString();
  save(h);
  return { ok: true, sym, kind, item, added: !prev };
}

function sold(symIn, { now = Date.now() } = {}) {
  const sym = normSymbol(symIn);
  if (!sym) return { ok: false, error: '종목을 같이 보내 주세요 — 예: /팔았다 MSFT' };
  const h = load();
  const had = !!h.items[sym];
  const items = { ...h.items };
  delete items[sym];
  h.items = items;
  h.updatedAt = new Date(now).toISOString();
  save(h); // 없던 종목이어도 파일을 만들어 '알려 준 적 있음'으로 둔다
  return { ok: true, sym, had };
}

// 텔레그램 답장 문구
function boughtReply(r) {
  if (!r.ok) return `⚠️ ${r.error}`;
  const { sym, kind, item } = r;
  const f = (x) => (x >= 1000 ? Math.round(x).toLocaleString('en-US') : Number(x.toFixed(2)).toString());
  if (kind === 'coin') {
    const tail = item.avg ? ` · 평균 ${f(item.avg)}원 → 업비트 손절 예약: 감시가 <b>${f(item.stop)}원</b> · 주문 가격 ${f(item.avg * LIMIT_K)}원 · 수량 전부` : ' — 업비트 평균 매수가(원)도 같이 보내면 손절 예약 값을 계산해 드립니다(예: /샀다 BTC 135000000)';
    return `✅ ${sym} 들고 있음으로 적었습니다${tail}\n내일 09:05 신호부터 ${sym} 는 '유지' 또는 '팔기'로 나옵니다.`;
  }
  const tail = item.avg ? ` · 평균 $${f(item.avg)} → 손절선 <b>$${f(item.stop)}</b>(종가로 — 이 아래로 마감하거나 200일선 아래로 마감하면 다음 17:30 팔기)` : " — 토스 '1주 평균'의 $ 숫자도 같이 보내면 손절선을 계산해 드립니다(예: /샀다 MSFT 543.43)";
  return `✅ ${sym} 들고 있음으로 적었습니다${tail}\n내일 09:05 신호부터 ${sym} 는 '유지' 또는 '팔기'로 나옵니다.`;
}

function soldReply(r) {
  if (!r.ok) return `⚠️ ${r.error}`;
  return r.had ? `✅ ${r.sym} 판 것으로 적었습니다 — 이제 '쉼'이고, 다시 두 선 위로 마감하면 신호가 '사기'로 알려 드립니다.` : `${r.sym} 는 들고 있는 것으로 적혀 있지 않았습니다(그대로 '안 들고 있음').`;
}

function listReply(h = load()) {
  const syms = Object.keys(h.items);
  if (!syms.length) return h.known ? '📦 들고 있는 것: 없음(전부 현금)' : "📦 아직 알려 주신 게 없습니다 — 산 날 '/샀다 종목 평균가', 판 날 '/팔았다 종목' 을 보내 주세요.";
  const f = (x) => (x == null ? '-' : x >= 1000 ? Math.round(x).toLocaleString('en-US') : Number(x.toFixed(2)).toString());
  return ['📦 <b>들고 있는 것</b>', ...syms.map((s) => {
    const it = h.items[s];
    const unit = kindOf(s) === 'coin' ? '원' : '';
    const pre = kindOf(s) === 'coin' ? '' : '$';
    return `${s} · ${it.since || '-'}부터 · 평균 ${it.avg ? `${pre}${f(it.avg)}${unit}` : '-'} · 손절 ${it.stop ? `${pre}${f(it.stop)}${unit}` : '-'}`;
  })].join('\n');
}

module.exports = { FILE, COINS, STOP_K, LIMIT_K, normSymbol, kindOf, load, save, bought, sold, boughtReply, soldReply, listReply, _setPath, kstDate };

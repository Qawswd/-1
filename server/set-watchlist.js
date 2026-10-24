'use strict';

// set-watchlist.js — 서버의 config.json에서 감시 종목과 실거래 허용 종목을 안전하게 바꾼다.
// 손으로 JSON을 고치다 괄호·쉼표가 깨지면 서버가 설정을 못 읽는다 — 그래서 스크립트로 바꾸고,
// 원본은 config.json.bak으로 백업한다. 다른 설정은 건드리지 않는다.
//
// 사용법: node server/set-watchlist.js BTC ETH          (미리보기)
//         node server/set-watchlist.js BTC ETH --apply  (실제 적용)

const fs = require('fs');
const path = require('path');

const CFG_PATH = path.join(__dirname, '..', 'config.json');

// 순수 함수 — 설정 객체에 감시 종목과 허용 거래소 심볼을 넣은 새 객체를 돌려준다.
function applyWatchlist(cfg, symbols) {
  const base = cfg && typeof cfg === 'object' ? JSON.parse(JSON.stringify(cfg)) : {};
  const syms = symbols.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
  base.watchlist = syms;
  base.execution = base.execution && typeof base.execution === 'object' ? base.execution : {};
  base.execution.allowedSymbols = syms.map((s) => (s.endsWith('USDT') ? s : `${s}USDT`));
  return base;
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const symbols = args.filter((a) => !a.startsWith('--'));
  if (!symbols.length) {
    console.log('종목을 지정하세요. 예: node server/set-watchlist.js BTC ETH');
    return;
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  } catch (e) {
    console.log('config.json을 읽지 못했습니다 — 건드리지 않습니다:', e.message);
    return;
  }
  const next = applyWatchlist(cfg, symbols);
  console.log('현재 감시 종목:', JSON.stringify(cfg.watchlist || null));
  console.log('바꿀 감시 종목:', JSON.stringify(next.watchlist));
  console.log('현재 허용 종목:', JSON.stringify((cfg.execution || {}).allowedSymbols || null));
  console.log('바꿀 허용 종목:', JSON.stringify(next.execution.allowedSymbols));
  if (!apply) {
    console.log('\n미리보기입니다. 적용하려면 --apply를 붙여 다시 실행하세요.');
    return;
  }
  fs.copyFileSync(CFG_PATH, CFG_PATH + '.bak');
  fs.writeFileSync(CFG_PATH, JSON.stringify(next, null, 2), 'utf8');
  console.log('\n적용 완료 — 원본은 config.json.bak에 백업했습니다. 서버를 재시작하세요.');
}

if (require.main === module) main();
module.exports = { applyWatchlist };

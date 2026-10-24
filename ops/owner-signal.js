'use strict';
// 대표님 규칙 신호(server/owner-signal.js) 켜기·끄기·지금 신호 보기(2026-10-23). 주문 없음 — 계산과 텔레그램 알림뿐.
//   node ops/owner-signal.js                         # 지금 신호를 화면에(보내지 않음)
//   node ops/owner-signal.js --on                    # 매일 한국 09:05 텔레그램 → sudo systemctl restart trading-floor
//   node ops/owner-signal.js --on --stocks QQQ NVDA  # 주식도(롱만, Yahoo 일봉)
//   node ops/owner-signal.js --no-short              # 코인 숏 줄 끄기(롱만) · --short 로 다시 켜기
//   node ops/owner-signal.js --off
//   node ops/owner-signal.js --send                  # 지금 신호를 텔레그램으로 한 번 보내기(시험)
const OS = require('../server/owner-signal');
const { loadConfig, saveConfig } = require('../server/config');

const argv = process.argv.slice(2);
const si = argv.indexOf('--stocks');
const stocks = si >= 0 ? argv.slice(si + 1).filter((x) => !x.startsWith('--')) : null;
const plain = (t) => t.replace(/<[^>]+>/g, '');

(async () => {
  const shortFlag = argv.includes('--no-short') ? { shorts: false } : argv.includes('--short') ? { shorts: true } : {};
  if (argv.includes('--on') || argv.includes('--off') || Object.keys(shortFlag).length) {
    saveConfig({ ownerSignal: argv.includes('--off') ? { enabled: false } : { ...(argv.includes('--on') ? { enabled: true } : {}), ...(stocks ? { stocks } : {}), ...shortFlag } });
    const p = OS.effectiveParams(loadConfig().ownerSignal);
    console.log(`대표님 규칙 신호: ${p.enabled ? `켬 — 매일 한국 ${p.runAtKst} · ${[...p.symbols, ...p.stocks].join(' · ')} · 코인 숏 ${p.shorts ? '냄' : '안 냄(롱만)'}` : '끔'}`);
    console.log('적용하려면: sudo systemctl restart trading-floor');
    return;
  }
  const cfg = loadConfig();
  const { text } = await OS.currentMessage(cfg);
  if (argv.includes('--send')) {
    const r = await require('../server/notify').sendMessage(text, cfg);
    console.log(r.ok ? '텔레그램으로 보냈습니다' : `보내기 실패: ${r.error}`);
    return;
  }
  console.log(plain(text));
})().catch((e) => console.log(`실패: ${e.message}`));

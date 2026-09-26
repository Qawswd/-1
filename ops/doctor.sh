#!/usr/bin/env bash
# ops/doctor.sh — 리눅스 서버 상태를 한 번에 점검한다 (Windows 의 doctor.cmd 대응).
#   bash ops/doctor.sh
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export PATH="$HOME/.local/bin:$PATH"

ok()  { echo "  [정상] $*"; }
bad() { echo "  [문제] $*"; }

echo "[1] 시간대 / 시각"
# /etc/timezone 은 timedatectl 이 갱신하지 않는 구식 파일이라 보지 않는다 — 실제 적용값은 date 가 안다
if [ "$(date +%Z)" = "KST" ]; then
  ok "Asia/Seoul · $(date '+%Y-%m-%d %H:%M %Z')"
else
  bad "시간대가 KST 가 아닙니다 → sudo timedatectl set-timezone Asia/Seoul (스케줄이 엉뚱한 시각에 돕니다)"
fi

echo "[2] Node"
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  if [ "$major" -ge 20 ]; then ok "node $(node -v)"; else bad "node $(node -v) — 20 이상 필요 (ops/install-ubuntu.sh 재실행)"; fi
else
  bad "node 없음"
fi

echo "[3] claude CLI"
if command -v claude >/dev/null 2>&1; then
  ok "claude $(claude --version 2>/dev/null | head -1)"
  if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    bad "ANTHROPIC_API_KEY 가 설정돼 있어 구독 대신 API 과금이 됩니다 → unset ANTHROPIC_API_KEY"
  fi
  out="$(cd ~ && echo 'Reply with the single word PONG' | timeout 90 claude -p 2>/dev/null | tr -d '\r')"
  if echo "$out" | grep -qi 'pong'; then
    ok "비대화형 호출 응답 확인 (claude -p)"
  else
    bad "claude -p 응답 없음 → cd ~ && claude 로 로그인/폴더 신뢰를 먼저 처리하세요"
  fi
else
  bad "claude 없음 → curl -fsSL https://claude.ai/install.sh | bash"
fi

echo "[4] 설정 파일 · .env"
if [ -f .env ]; then
  set -a; . ./.env; set +a
  ok ".env 있음 — 키: $(grep -E '^[A-Z_]+=.+' .env | cut -d= -f1 | tr '\n' ' ')"
  [ -n "${BINANCE_FUTURES_BASE_URL:-}" ] && { case "$BINANCE_FUTURES_BASE_URL" in *demo*|*testnet*) ok "바이낸스 주소 = 데모(가짜 돈): $BINANCE_FUTURES_BASE_URL";; *) bad "바이낸스 주소가 실계좌입니다: $BINANCE_FUTURES_BASE_URL — Phase 2b 전엔 demo 로 되돌리세요";; esac; }
else
  bad ".env 없음 → cp .env.example .env && chmod 600 .env"
fi
if [ -f config.json ]; then
  ok "config.json 있음"
  node -e '
    const c=require("./server/config").loadConfig();
    const t=c.telegram||{};
    const tok=(t.botToken||process.env.TELEGRAM_BOT_TOKEN||"").trim();
    console.log((t.enabled&&tok&&t.chatId)?"  [정상] 텔레그램 설정됨 (chatId "+t.chatId+")":"  [주의] 텔레그램 미설정 — enabled/토큰(.env TELEGRAM_BOT_TOKEN)/chatId 확인");
    const e=c.execution||{};
    console.log("         execution:", e.enabled?`켜짐 (계좌 ${e.accountSizeUsd} USD · 리스크 ${e.riskPct}% · 일일한도 ${e.dailyLossLimitPct}%)`:"꺼짐");
    console.log("         watchlist:", (c.watchlist||[]).join(", ")||"(비어 있음)");
    console.log("         risk:", JSON.stringify(c.risk));
    console.log("         schedule:", c.schedule&&c.schedule.enabled?`${(c.schedule.jobs||[]).length}개 잡`:"꺼짐");
    console.log("         watcher:", c.watcher&&c.watcher.enabled?`켜짐 (${c.watcher.intervalSec}s)`:"꺼짐");
  ' 2>/dev/null || bad "config.json 을 읽지 못함 (JSON 문법 확인)"
else
  bad "config.json 없음 → cp config.example.json config.json"
fi

echo "[5] 서비스"
if systemctl list-unit-files 2>/dev/null | grep -q '^trading-floor.service'; then
  st="$(systemctl is-active trading-floor 2>/dev/null)"
  if [ "$st" = "active" ]; then ok "trading-floor 서비스 active"; else bad "trading-floor 서비스 $st → sudo systemctl start trading-floor; journalctl -u trading-floor -n 50"; fi
else
  echo "  [정보] systemd 서비스 미등록 (ops/install-ubuntu.sh 로 등록)"
fi

echo "[6] HTTP"
port="${PORT:-8000}"
if curl -fsS --max-time 5 "http://127.0.0.1:$port/api/config" >/dev/null 2>&1; then
  ok "http://127.0.0.1:$port 응답"
else
  bad "포트 $port 응답 없음 (서비스가 꺼져 있거나 다른 포트)"
fi

echo "[7] 외부 시세 API 도달성"
node -e '
  const urls={binance:"https://api.binance.com/api/v3/ping",fapi:"https://fapi.binance.com/fapi/v1/ping",yahoo:"https://query1.finance.yahoo.com/v8/finance/chart/005930.KS?range=1d&interval=1d",coingecko:"https://api.coingecko.com/api/v3/ping",telegram:"https://api.telegram.org"};
  (async()=>{for(const [k,u] of Object.entries(urls)){try{const r=await fetch(u,{signal:AbortSignal.timeout(8000),headers:{"User-Agent":"Mozilla/5.0"}});console.log(`  [${r.status<500?"정상":"문제"}] ${k} HTTP ${r.status}`)}catch(e){console.log(`  [문제] ${k} ${e.message}`)}}})();
'

echo "[8] 앱 자체 진단 (node server/doctor.js)"
node server/doctor.js 2>/dev/null | sed -n '1,60p' | grep -v PowerShell || true

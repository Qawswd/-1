#!/usr/bin/env bash
# ops/install-ubuntu.sh — AWS Ubuntu 22.04/24.04 서버에 PIXEL TRADING FLOOR 를 한 번에 설치한다.
#
# 사용법 (Termux → ssh 로 서버 접속 후):
#   git clone <이 저장소> ~/trading-floor && cd ~/trading-floor
#   bash ops/install-ubuntu.sh
#
# 하는 일
#   1) 필수 패키지 + 시간대 KST (스케줄러·알림이 서버 로컬 시각 기준이라 반드시 필요)
#   2) 2GB 스왑 (프리티어 1GB 인스턴스에서 claude -p 가 메모리 부족으로 죽는 것을 막는다)
#   3) Node 22 LTS (NodeSource) — apt 기본 Node 는 18이라 global fetch/AbortSignal.timeout 이 불안정
#   4) Claude Code 네이티브 설치 (~/.local/bin/claude)
#   5) systemd 서비스 등록 (서버 재부팅·프로세스 사망 시 자동 재시작)
#
# 하지 않는 일 (사람이 직접 해야 하는 것)
#   - claude 로그인 (브라우저 인증이라 자동화 불가) → 스크립트 끝의 안내를 따른다
#   - config.json 작성 (텔레그램 토큰 등) → config.example.json 을 복사해 채운다
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="$(id -un)"
SERVICE_NAME="trading-floor"

if [ "$APP_USER" = "root" ]; then
  echo "[!] root 로 실행하지 마세요. claude 로그인 정보는 실행 사용자 홈에 저장되므로"
  echo "    서비스를 돌릴 일반 사용자(예: ubuntu)로 실행해야 합니다."
  exit 1
fi

echo "== [1/5] 패키지 · 시간대 =="
sudo apt-get update -y
sudo apt-get install -y curl git tmux unzip ca-certificates
sudo timedatectl set-timezone Asia/Seoul || true
date

echo "== [2/5] 스왑 2GB (이미 있으면 건너뜀) =="
if ! sudo swapon --show | grep -q '/swapfile'; then
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
free -h | sed -n '1,3p'

echo "== [3/5] Node 22 LTS =="
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "$major" -ge 20 ] && need_node=0
fi
if [ "$need_node" = 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "== [4/5] Claude Code =="
if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ]; then
  curl -fsSL https://claude.ai/install.sh | bash
fi
# 이 셸과 이후 로그인 셸 모두에서 claude 를 찾을 수 있게 한다
export PATH="$HOME/.local/bin:$PATH"
grep -q '.local/bin' "$HOME/.bashrc" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
claude --version || echo "[!] claude 실행 실패 — 새 셸을 열고 다시 확인하세요"

echo "== [5/5] systemd 서비스 =="
sudo mkdir -p /etc/systemd/system
sed -e "s|__APP_DIR__|$APP_DIR|g" \
    -e "s|__APP_USER__|$APP_USER|g" \
    -e "s|__HOME__|$HOME|g" \
    -e "s|__NODE__|$(command -v node)|g" \
    "$APP_DIR/ops/trading-floor.service" | sudo tee "/etc/systemd/system/$SERVICE_NAME.service" >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME" >/dev/null
mkdir -p "$APP_DIR/reports"
[ -f "$APP_DIR/config.json" ] || cp "$APP_DIR/config.example.json" "$APP_DIR/config.json"
if [ ! -f "$APP_DIR/.env" ]; then cp "$APP_DIR/.env.example" "$APP_DIR/.env"; chmod 600 "$APP_DIR/.env"; fi

cat <<EOF

========================================================
 설치 완료. 남은 수동 작업 2가지
========================================================
 (1) claude 로그인 — 반드시 홈 디렉터리에서, 서비스 사용자($APP_USER)로:
       cd ~ && claude
     → 로그인 URL 이 뜨면 폰 브라우저로 열어 승인 → 코드를 터미널에 붙여넣기
     → 세션 안에서 /status 로 구독 계정 확인 후 /exit
     → 동작 확인:  echo hi | claude -p
     ※ ANTHROPIC_API_KEY 환경변수가 있으면 구독 대신 API 과금이 됩니다. 비워 두세요.

 (2) 비밀값:  nano $APP_DIR/.env
     BINANCE_API_KEY / BINANCE_API_SECRET (데모 계좌) · TELEGRAM_BOT_TOKEN · DASHBOARD_PASSWORD
     설정:    nano $APP_DIR/config.json  →  telegram.chatId

 서비스 시작:   sudo systemctl start $SERVICE_NAME
 상태·로그:     bash ops/doctor.sh   /   journalctl -u $SERVICE_NAME -f
 폰에서 화면:   docs/02-TERMUX.md 의 SSH 터널 참고 (포트 8000 은 절대 외부에 열지 않는다)
========================================================
EOF

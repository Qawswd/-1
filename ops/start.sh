#!/usr/bin/env bash
# ops/start.sh — 서비스 없이 포그라운드로 바로 띄울 때 (개발·점검용).
# 상시 운영은 systemd(ops/install-ubuntu.sh)를 쓴다. 이 스크립트는 tmux 안에서 잠깐 돌려볼 때 쓴다.
#   bash ops/start.sh            # http://localhost:8000
#   PORT=8123 bash ops/start.sh
#   FLOOR_MODEL=opus bash ops/start.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
export TZ="${TZ:-Asia/Seoul}"
export PATH="$HOME/.local/bin:$PATH"
export FLOOR_MODEL="${FLOOR_MODEL:-sonnet}"
unset ANTHROPIC_API_KEY
mkdir -p reports
echo "PIXEL TRADING FLOOR  port=${PORT:-8000}  model=$FLOOR_MODEL  tz=$TZ"
exec node server/server.js

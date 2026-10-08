#!/usr/bin/env bash
# ops/migrate-old-server.sh — tar 패치로 운영하던 예전 ~/trading-floor 를 git 기반 새 코드로 바꾼다.
#
# 서버에서 (예전 서비스는 이미 멈춰 있어야 한다: sudo systemctl stop trading-floor):
#   curl -fsSL https://raw.githubusercontent.com/Qawswd/-1/claude/ai-stock-automation-earnings-93qeob/ops/migrate-old-server.sh | bash
#
# 하는 일
#   1) 예전 폴더를 ~/trading-floor-old-<날짜> 로 이름만 바꾼다 (지우지 않는다)
#   2) 이 저장소를 ~/trading-floor 로 clone
#   3) 예전 reports/ (판정·장부·로그·백테스트 데이터) 와 .env 를 그대로 가져온다
#   4) config.json 은 새 템플릿(config.example.json)으로 만들고, 예전 telegram.chatId 만 옮긴다
#   5) ops/install-ubuntu.sh 실행 (KST·스왑·systemd·.env 로딩)
set -euo pipefail

REPO_URL="https://github.com/Qawswd/-1.git"
BRANCH="claude/ai-stock-automation-earnings-93qeob"
NEW="$HOME/trading-floor"
STAMP="$(date '+%Y%m%d-%H%M')"
OLD="$HOME/trading-floor-old-$STAMP"

if systemctl is-active --quiet trading-floor 2>/dev/null; then
  echo "[!] trading-floor 서비스가 아직 돌고 있습니다. 먼저:  sudo systemctl stop trading-floor"
  exit 1
fi

if [ -d "$NEW/.git" ]; then
  echo "[i] $NEW 는 이미 git 저장소입니다 — 이관이 아니라 갱신을 하세요:"
  echo "    cd $NEW && git pull && npm test && sudo systemctl restart trading-floor"
  exit 0
fi

echo "== [1/5] 예전 폴더 보존 =="
if [ -d "$NEW" ]; then
  mv "$NEW" "$OLD"
  echo "  $NEW → $OLD"
else
  echo "  예전 폴더 없음 — 새로 설치만 합니다"
  OLD=""
fi

echo "== [2/5] 새 코드 clone =="
git clone --branch "$BRANCH" "$REPO_URL" "$NEW"
cd "$NEW"

echo "== [3/5] 기록·비밀값 이관 =="
if [ -n "$OLD" ]; then
  if [ -d "$OLD/reports" ]; then
    cp -r "$OLD/reports" "$NEW/reports"
    echo "  reports/ ($(find "$NEW/reports" -type f | wc -l) 파일) — 판정 $(node -e 'try{console.log(JSON.parse(require("fs").readFileSync("reports/decisions.json","utf8")).length)}catch{console.log(0)}')건 포함"
  fi
  if [ -f "$OLD/.env" ]; then
    cp "$OLD/.env" "$NEW/.env"
    chmod 600 "$NEW/.env"
    grep -q '^FLOOR_MODEL=' "$NEW/.env" || echo 'FLOOR_MODEL=sonnet' >> "$NEW/.env"
    echo "  .env 이관 (FLOOR_MODEL=sonnet 보장)"
  fi
fi
[ -f "$NEW/.env" ] || { cp .env.example .env; chmod 600 .env; echo "  .env 없어서 템플릿 생성 — 키·토큰을 채워야 합니다"; }

echo "== [4/5] config.json 새 템플릿 + chatId 이관 =="
node -e '
const fs=require("fs");
const tpl=JSON.parse(fs.readFileSync("config.example.json","utf8"));
let old=null; try{ old=JSON.parse(fs.readFileSync(process.argv[1]+"/config.json","utf8")); }catch{}
if(old&&old.telegram&&old.telegram.chatId){ tpl.telegram.chatId=String(old.telegram.chatId); console.log("  telegram.chatId 이관:", tpl.telegram.chatId); }
else console.log("  예전 chatId 없음 — config.json 의 telegram.chatId 를 직접 채우세요");
fs.writeFileSync("config.json", JSON.stringify(tpl,null,2)+"\n");
' "${OLD:-/nonexistent}"
[ -n "$OLD" ] && [ -f "$OLD/config.json" ] && cp "$OLD/config.json" "$NEW/config.json.old" && echo "  예전 설정은 config.json.old 로 보관"

echo "== [5/5] 설치 스크립트 =="
bash ops/install-ubuntu.sh

echo
echo "== 이관 완료 =="
echo "  예전 폴더: ${OLD:-없음}  (문제 없으면 한 달 뒤 지워도 됨)"
echo "  다음:  bash ops/doctor.sh   →   sudo systemctl start trading-floor   →   journalctl -u trading-floor -f"

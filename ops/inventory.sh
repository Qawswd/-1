#!/usr/bin/env bash
# ops/inventory.sh — 예전 설치가 남아 있는 서버의 상태를 한 번에 훑는다. 아무것도 바꾸지 않는다(읽기 전용).
#
# 서버에서:
#   curl -fsSL https://raw.githubusercontent.com/Qawswd/-1/claude/ai-stock-automation-earnings-93qeob/ops/inventory.sh | bash
# 출력을 그대로 복사해 대표이사(Claude)에게 보내면 재사용/폐기를 결정한다.
set -uo pipefail
h() { echo; echo "== $* =="; }

h "인스턴스"
echo "host: $(hostname)  user: $(id -un)  tz: $(date '+%Z')  now: $(date '+%F %T')"
uptime
df -h / | tail -1
free -h | sed -n '2,3p'

h "프로젝트 폴더 후보 (package.json 이 있는 곳)"
find "$HOME" /opt /srv -maxdepth 4 -name package.json -not -path '*/node_modules/*' -not -path '*/nvm/*' 2>/dev/null | while read -r f; do
  d="$(dirname "$f")"
  echo "$d  ($(du -sh "$d" 2>/dev/null | cut -f1))"
done

h "git 저장소와 커밋 안 된 변경"
find "$HOME" /opt /srv -maxdepth 4 -name .git -type d 2>/dev/null | while read -r g; do
  d="$(dirname "$g")"
  echo "-- $d"
  git -C "$d" log --oneline -1 2>/dev/null
  git -C "$d" remote -v 2>/dev/null | head -1
  git -C "$d" status --short 2>/dev/null | head -15
done

h "systemd 서비스 (우리 것으로 보이는 것)"
systemctl list-unit-files --type=service --no-pager 2>/dev/null | grep -iE 'trading|floor|node|pm2|bot|claude' || echo "(없음)"
systemctl list-units --type=service --state=running --no-pager 2>/dev/null | grep -iE 'trading|floor|node|pm2|bot|claude' || true

h "pm2 / tmux / screen / cron"
command -v pm2 >/dev/null 2>&1 && pm2 ls 2>/dev/null || echo "pm2 없음"
tmux ls 2>/dev/null || echo "tmux 세션 없음"
screen -ls 2>/dev/null | head -5 || true
crontab -l 2>/dev/null || echo "crontab 없음"

h "살아 있는 node / claude / python 프로세스"
pgrep -af 'node|claude|python' 2>/dev/null | grep -v pgrep | head -20 || echo "(없음)"

h "외부에 열린 포트 (0.0.0.0 / :: 은 인터넷에서 접근 가능)"
ss -tlnp 2>/dev/null | grep -vE '127\.0\.0\.1|\[::1\]' || true

h "node / claude"
command -v node >/dev/null 2>&1 && echo "node $(node -v)" || echo "node 없음"
export PATH="$HOME/.local/bin:$PATH"
if command -v claude >/dev/null 2>&1; then
  echo "claude $(claude --version 2>/dev/null | head -1)"
  [ -f "$HOME/.claude/.credentials.json" ] && echo "로그인 파일 있음 ($HOME/.claude/.credentials.json, $(date -r "$HOME/.claude/.credentials.json" '+%F'))" || echo "로그인 파일 없음"
  [ -n "${ANTHROPIC_API_KEY:-}" ] && echo "[주의] ANTHROPIC_API_KEY 설정됨 (API 과금)" || true
else
  echo "claude 없음"
fi

h "건질 만한 기록 파일"
find "$HOME" /opt /srv -maxdepth 5 \( -name decisions.json -o -name positions.json -o -name config.json -o -name '*.md' -path '*/reports/*' \) \
  -not -path '*/node_modules/*' 2>/dev/null | head -40 | while read -r f; do
  printf '%8s  %s  %s\n' "$(du -h "$f" | cut -f1)" "$(date -r "$f" '+%F')" "$f"
done
n=$(find "$HOME" /opt /srv -maxdepth 5 -path '*/reports/*.md' -not -path '*/node_modules/*' 2>/dev/null | wc -l)
echo "리포트 .md 총 $n 개"
for f in $(find "$HOME" /opt /srv -maxdepth 5 -name decisions.json -not -path '*/node_modules/*' 2>/dev/null); do
  node -e 'try{const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(process.argv[1]+": 판정 "+a.length+"건, 첫 "+(a[0]&&a[0].ts||"-")+" ~ 마지막 "+(a[a.length-1]&&a[a.length-1].ts||"-"))}catch(e){console.log(process.argv[1]+": 읽기 실패 "+e.message)}' "$f" 2>/dev/null
done

h "비밀 정보가 들어 있을 수 있는 파일 (내용은 출력하지 않는다)"
find "$HOME" -maxdepth 4 \( -name '.env' -o -name 'config.json' -o -name '*.pem' -o -name '*key*' \) -not -path '*/node_modules/*' -not -path '*/.claude/*' 2>/dev/null | head -20

echo
echo "== 끝. 이 출력을 그대로 복사해 보내면 된다. 토큰·키 값은 출력되지 않았다. =="

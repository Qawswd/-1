#!/usr/bin/env bash
# ops/salvage.sh — 예전 설치에서 가치 있는 것만 tar 하나로 묶는다. 원본은 건드리지 않는다.
#
# 건지는 것 (이것 말고는 전부 다시 만들 수 있다):
#   1) reports/  — decisions.json · positions.json · 리포트 .md  → 유일한 "실적 기록". 사후 분석 재료
#   2) config.json — 텔레그램 토큰·chatId·워치리스트·예약 (다시 만들면 30분 낭비)
#   3) 커밋 안 된 코드 변경 (git diff) — 예전에 손댄 게 있으면 왜 꼬였는지 여기 흔적이 있다
#   4) ~/.claude 의 설정(로그인 파일은 제외 — 새 로그인이 더 안전하다)
#
# 서버에서:
#   curl -fsSL https://raw.githubusercontent.com/Qawswd/-1/claude/ai-stock-automation-earnings-93qeob/ops/salvage.sh | bash
# 그러면 ~/salvage-<날짜>.tgz 가 생긴다. Termux 에서 폰으로 가져오기:
#   scp -i ~/.ssh/aws.pem ubuntu@<IP>:~/salvage-*.tgz ~/storage/downloads/
set -uo pipefail
stamp="$(date '+%Y%m%d-%H%M')"
work="$HOME/salvage-$stamp"
out="$HOME/salvage-$stamp.tgz"
mkdir -p "$work"

echo "== 프로젝트 폴더 탐색 =="
mapfile -t dirs < <(find "$HOME" /opt /srv -maxdepth 4 -name package.json -not -path '*/node_modules/*' -not -path '*/nvm/*' 2>/dev/null | xargs -r -n1 dirname | sort -u)
[ "${#dirs[@]}" -eq 0 ] && echo "(package.json 이 있는 폴더 없음 — reports 만 찾는다)"

i=0
for d in "${dirs[@]}"; do
  i=$((i+1))
  name="$(basename "$d")-$i"
  dest="$work/$name"
  mkdir -p "$dest"
  echo "-- $d → $name"
  [ -d "$d/reports" ] && cp -r "$d/reports" "$dest/" && echo "   reports/ ($(find "$d/reports" -type f | wc -l) 파일)"
  [ -f "$d/config.json" ] && cp "$d/config.json" "$dest/" && echo "   config.json"
  [ -f "$d/.env" ] && cp "$d/.env" "$dest/" && echo "   .env"
  if [ -d "$d/.git" ]; then
    git -C "$d" log --oneline -20 > "$dest/git-log.txt" 2>/dev/null
    git -C "$d" status --short > "$dest/git-status.txt" 2>/dev/null
    git -C "$d" diff > "$dest/uncommitted.diff" 2>/dev/null
    # 추적 안 된 새 파일(예전에 직접 만든 모듈)도 챙긴다
    git -C "$d" ls-files --others --exclude-standard 2>/dev/null | grep -vE '^(reports/|node_modules/|config\.json$|\.env$)' | while read -r f; do
      mkdir -p "$dest/untracked/$(dirname "$f")"
      cp "$d/$f" "$dest/untracked/$f" 2>/dev/null
    done
    echo "   git: 로그·상태·diff·미추적 파일"
  else
    # git 이 없으면 무엇이 바뀌었는지 알 길이 없다 → 소스 전체를 통째로 (대용량 폴더만 제외)
    mkdir -p "$dest/src"
    tar -C "$d" --exclude=node_modules --exclude=reports --exclude='vendor/ta-venv' --exclude='vendor/TradingAgents' \
        -cf - . 2>/dev/null | tar -C "$dest/src" -xf - 2>/dev/null
    echo "   git 없음 → 소스 전체 복사 ($(du -sh "$dest/src" 2>/dev/null | cut -f1))"
  fi
  echo "$d" > "$dest/ORIGIN.txt"
done

# 홈에 굴러다니는 패치·백업 tar, 로그, 명령 이력 — "무엇을 어떤 순서로 했는지"의 유일한 기록
mkdir -p "$work/home"
for f in "$HOME"/*.tar.gz "$HOME"/*.tgz "$HOME"/*.zip "$HOME"/*.log "$HOME"/*.txt; do
  [ -f "$f" ] && [ "$f" != "$out" ] && cp "$f" "$work/home/" 2>/dev/null
done
[ -f "$HOME/.bash_history" ] && cp "$HOME/.bash_history" "$work/home/bash_history.txt"
echo "-- 홈 파일: $(ls "$work/home" 2>/dev/null | wc -l)개 (tar·로그·명령 이력)"

# 프로젝트 폴더 밖에 굴러다니는 reports 도 줍는다
find "$HOME" -maxdepth 5 \( -name decisions.json -o -name positions.json \) -not -path "$work/*" -not -path '*/node_modules/*' 2>/dev/null | while read -r f; do
  rel="${f#$HOME/}"
  mkdir -p "$work/loose/$(dirname "$rel")"
  cp "$f" "$work/loose/$rel"
done

# claude 설정(로그인 제외)
if [ -d "$HOME/.claude" ]; then
  mkdir -p "$work/dot-claude"
  for f in settings.json settings.local.json CLAUDE.md; do
    [ -f "$HOME/.claude/$f" ] && cp "$HOME/.claude/$f" "$work/dot-claude/"
  done
fi

# 서비스 정의도 참고용으로
mkdir -p "$work/systemd"
ls /etc/systemd/system/*.service 2>/dev/null | grep -iE 'trading|floor|node|bot' | xargs -r -I{} cp {} "$work/systemd/" 2>/dev/null
crontab -l > "$work/crontab.txt" 2>/dev/null || true

tar -czf "$out" -C "$HOME" "$(basename "$work")" && rm -rf "$work"
echo
echo "== 완료: $out ($(du -h "$out" | cut -f1)) =="
echo "폰으로:  scp -i ~/.ssh/aws.pem $(id -un)@<서버IP>:$out ~/storage/downloads/"
echo "주의: 이 파일에는 텔레그램 토큰이 들어 있다. 공개 저장소에 올리지 말 것."

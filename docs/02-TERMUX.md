# Termux 운용 가이드 — 폰이 꺼져도 서버는 돈다

서버(AWS)가 24시간 분석·감시·알림을 하고, 폰은 **보는 창**과 **명령 창**일 뿐이다.
폰을 끄거나 Termux 를 종료해도 서버의 systemd 서비스는 계속 돈다.

## 1. 평소에 쓰는 것 — 텔레그램

설치가 끝나면 대부분의 정보는 텔레그램으로 온다.

- 예약 브리핑 판정 (액션·확신도·진입/손절/목표·손익비·청산 경고·리포트 파일명)
- 급변동 알림 (15분 ±1.5%, 거래량 급증, 펀딩비 이상, 선물↔KRX 괴리)
- 예약 실행 실패 알림

텔레그램만 보고 있어도 Phase 1(페이퍼) 운영은 충분하다.

## 2. 화면(픽셀 오피스·성적표)을 폰에서 보기 — SSH 터널

8000 포트를 인터넷에 열지 않고 본다.

```bash
ssh -i ~/.ssh/aws.pem -N -L 8000:localhost:8000 ubuntu@<퍼블릭IP>
```

이 명령을 켜 둔 채 폰 브라우저에서:

| 주소 | 화면 |
|---|---|
| http://localhost:8000 | 픽셀 오피스 (실시간 분석 중계) |
| http://localhost:8000/stats | **성적표·캘리브레이션** — 매주 이걸 본다 |
| http://localhost:8000/reports | 리포트 목록·다운로드 |
| http://localhost:8000/?demo=1 | claude 없이 화면만 |

터널을 끊으려면 Termux 로 돌아와 Ctrl+C. (`~/.ssh/config` 를 만들어 뒀으면 `ssh -N -L 8000:localhost:8000 aws`)

**로그인:** 터널로 들어오는 요청과 서버 셸의 `curl` 은 루프백(127.0.0.1)이라 **로그인 없이** 통과한다(SSH 키가 이미 인증이다). 인터넷에서 공인 IP 로 직접 들어오면 `/login` 페이지가 막는다(아이디 `DASHBOARD_USER`, 비밀번호 `.env` 의 `DASHBOARD_PASSWORD`).

## 3. 명령 — SSH 로 들어가서

```bash
ssh aws
cd ~/trading-floor
```

| 하고 싶은 것 | 명령 |
|---|---|
| 지금 분석 | `curl -s -X POST localhost:8000/api/analyze -H 'content-type: application/json' -d '{"symbol":"BTC","mode":"algo"}'` |
| 워치리스트 전체 스캔 | `curl -s -X POST localhost:8000/api/scan -H 'content-type: application/json' -d '{"mode":"scalp"}'` |
| 가상 포지션 보기 | `curl -s localhost:8000/api/positions \| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.summary);for(const p of j.open)console.log(p.display,p.side,p.entry,"→",p.lastPrice,p.roePct+"%")})'` |
| 성적표 JSON | `curl -s localhost:8000/api/stats` |
| 감시 켜기/끄기 | `curl -s -X POST localhost:8000/api/watcher -H 'content-type: application/json' -d '{"enabled":true}'` |
| 설정 바꾸기 | `nano config.json` → `sudo systemctl restart trading-floor` |
| 로그 | `journalctl -u trading-floor -n 100 -f` |
| 점검 | `bash ops/doctor.sh` |
| 코드 갱신 | `git pull && npm test && sudo systemctl restart trading-floor` |

## 4. 세션 안에서 에이전트 직접 돌리기 (구독 사용량 최소)

서버에서 Claude Code 세션을 열면 `/floor` 슬래시 커맨드가 있다. 별도 프로세스를 13개 띄우지 않고 세션 하나가 전 역할을 연기해 사용량이 가장 적다.

```bash
ssh aws
cd ~/trading-floor && claude
```

```
/floor 하이닉스 scalp
/floor BTC algo
```

폰 화면이 작으니 `tmux` 안에서 여는 것을 권한다 (`tmux new -s floor`, 끊겼다가 `tmux attach -t floor`).

## 5. 폰에서 절대 하지 말 것

- 보안 그룹에서 8000 포트 열기 (2절 터널로 충분하다)
- `attack`(공격) 모드 판정을 실전 근거로 쓰기 — 기준 문서가 "연출용"이라고 못 박은 모드다
- 텔레그램 판정을 보고 **20배**로 따라 들어가기 — 철칙은 5배 상한, 1회 손실 1% (`docs/00-CEO-PLAN.md`)

# AI 트레이딩 데스크 — PIXEL TRADING FLOOR on AWS Ubuntu

휴대폰(Termux)만으로 운영하는 24시간 AI 분석 데스크.
기준 앱은 [PIXEL TRADING FLOOR v1.2.1](START-HERE.md) — AI 에이전트 13명이 시장 데이터를 분석·토론·리스크 심사해 BUY/SELL/HOLD 판정을 내고, 가상 포지션 장부와 성적표까지 남기는 Node.js 앱(외부 의존성 0).

**이 저장소가 기준 앱에 더한 것**

| 경로 | 내용 |
|---|---|
| `docs/00-CEO-PLAN.md` | **대표이사 실행계획** — 목표의 수학, 철칙, 단계(페이퍼 → 소액 실전 → 자동), 영상 분석 프로토콜 |
| `docs/01-AWS-UBUNTU.md` | AWS 인스턴스 생성부터 텔레그램 연결까지, 폰만으로 하는 설치 순서 |
| `docs/02-TERMUX.md` | 평소 운용 — 텔레그램, SSH 터널로 화면 보기, 명령 모음 |
| `ops/install-ubuntu.sh` | 우분투 원클릭 설치 (KST·스왑·Node 22·Claude Code·systemd) |
| `ops/trading-floor.service` | systemd 유닛 (재부팅·죽음 시 자동 재시작, sonnet 기본, API 키 차단) |
| `ops/doctor.sh` | 8단계 서버 점검 |
| `ops/start.sh` | 포그라운드 실행(점검용) |
| `config.example.json` | 철칙이 반영된 설정 템플릿 (리스크 1%, 레버리지 5배, 손익비 1.8) |

## 빠른 시작 (서버)

```bash
git clone https://github.com/qawswd/-1.git ~/trading-floor && cd ~/trading-floor
bash ops/install-ubuntu.sh        # 설치
cd ~ && claude                    # 구독 로그인 (브라우저 인증 — 사람이 직접)
nano ~/trading-floor/config.json  # 텔레그램 토큰·chatId
sudo systemctl start trading-floor
bash ops/doctor.sh
```

자세한 순서는 `docs/01-AWS-UBUNTU.md`.

## 로컬에서 테스트

```bash
node -v            # 20 이상
npm test           # 68개 단위 테스트 (네트워크 불필요)
node server/server.js   # http://localhost:8000  (?demo=1 은 claude 없이 화면만)
```

## 현재 단계

**Phase 0 — 인프라.** 실제 돈은 0원. 페이퍼 트레이딩으로 30건 이상 성적을 쌓고 기대값이 검증되기 전에는 실전 진입하지 않는다. 근거와 조건은 `docs/00-CEO-PLAN.md`.

## 면책

AI 시뮬레이션이며 투자 조언이 아니다. 기준 앱은 설계상 실제 주문을 넣지 않으며, 이 저장소도 그 원칙을 유지한다. 투자 손실의 책임은 전적으로 사용자에게 있다.

---

아래는 기준 앱의 원본 설명이다.

<details>
<summary>PIXEL TRADING FLOOR 원본 README</summary>

티커 하나를 입력하면 AI 에이전트가 실시간으로 시장 데이터를 분석하고,
서로 토론한 뒤 **BUY / SELL / HOLD** 판정을 내리는 픽셀아트 트레이딩 오피스
로컬 웹앱입니다. TradingAgents 논문(멀티 에이전트 금융 의사결정 프레임워크)의
구조에서 착안했습니다.

의존성 0의 Node(20+) 내장 HTTP 서버가 무료 공개 API로 시장 데이터를 모으고,
에이전트별 `claude -p` 프로세스를 스폰해 받은 JSON 응답을 SSE로 프론트에 방송합니다.

| ID | 이름 | 역할 |
|----|------|------|
| taro | TARO | 기술적 분석 |
| diana | DIANA | 기본적 분석 |
| nova | NOVA | 뉴스 분석 |
| vibe | VIBE | 센티먼트 분석 |
| bull / bear | BULL / BEAR | 매수·매도 논거 토론 |
| blitz / guard | BLITZ / GUARD | 스캘퍼 / 리스크 관리 |
| risky / safe / neutral | 리스크 위원회 | 공격·보수·중립 심사 |
| ace | ACE | 수석 트레이더 (판정) |
| pm | PM | 포트폴리오 매니저 (승인) |

| 메서드 | 경로 | 설명 |
|--------|------|------|
| GET | `/` | 픽셀 오피스 UI |
| GET | `/api/stream` | SSE 스트림 |
| POST | `/api/analyze` | `{ "symbol": "BTC", "mode": "algo" }` |
| GET/POST | `/api/config` | 설정 |
| GET/POST | `/api/watcher` | 급변동 감시 |
| GET | `/api/stats` · `/stats` | 성적표 |
| GET | `/api/positions` | 가상 포지션 |
| POST | `/api/scan` | 워치리스트 스캔 |
| POST | `/api/telegram/test` | 텔레그램 테스트 |
| GET | `/reports` | 리포트 목록 |

자세한 구조·규칙은 `CLAUDE.md`, 설치·화면 설명은 `START-HERE.md` 와 `docs/가이드-v1.2.html`.

</details>

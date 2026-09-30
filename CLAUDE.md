# PIXEL TRADING FLOOR — Claude Code 안내

AI 에이전트들이 시장 데이터를 분석·토론해 매매 판정을 내리고, 가상 장부와 **바이낸스 선물 데모 계좌**에 주문까지 내는 Node 서버다. 운영 환경은 AWS Lightsail 우분투 + 텔레그램, 조작은 휴대폰 Termux.
경영 판단·단계·철칙은 `docs/00-CEO-PLAN.md`, 1차 실패 원인은 `docs/03-POSTMORTEM.md`.

## 실행

```bash
npm test                       # 678개 단위 테스트 (네트워크·claude 불필요)
node server/server.js          # http://localhost:8000  (?demo=1 은 claude 없이 화면만)
bash ops/doctor.sh             # 서버 점검
```

- 외부 npm 의존성 0. Node 20 이상.
- 실전 분석은 `claude` CLI 로그인 필요. 에이전트마다 `claude -p --model $FLOOR_MODEL --output-format json` 스폰.
- 비밀값은 `.env` 에만(`.env.example` 참고). `config.json` 은 HTTP POST 로 바뀔 수 있는 파일이라 비밀값을 두지 않는다.

## 구조

```
server/
  engine.js        파이프라인 오케스트레이션 → 리스크 게이트 → 가상 포지션 → (execution.enabled 면) 거래소 주문
  agents.js        역할별 프롬프트 · claude 스폰 · 한도 감지 · 데모 목업
  market.js        시장 데이터 (키 없는 공개 API)  indicators.js  지표 + 구조/역추세 필터
  watcher.js       급변동 감시 → 후보 필터(구조·역추세·예산) → 자동분석 → 포지션 리뷰·트레일링
  exchange.js      바이낸스 USDⓈ-M 주문 (레버리지 1배 코드 고정, 진입+손절 원자성, 손실 한도, 대사)
  startup-audit.js 재시작 시 손절 없는 포지션 복원/청산     reconcile.js  장부↔거래소 대조
  riskmath.js      손익비·사이징·청산가     positions.js  가상 장부     stats.js  성적표
  universe.js      거래 종목 고정(BTC·ETH)  analysis-budget.js  하루 자동분석 상한
  auth.js/login-page.js  대시보드 로그인    notify.js  텔레그램    daily-summary.js  일간 손익 요약
  candidate-log / trigger-log / cost-log   왜 분석이 안 됐는지·얼마나 썼는지 기록
  backtest/fetch-data.js   BTC·ETH 15m/1d/펀딩 수집 (reports/backtest/data)
ops/               우분투 설치·systemd·점검·이관 스크립트
docs/              계획·설치·운용·사후분석·영상 분석 기록
reports/           런타임 데이터 (git 제외)
```

## 작업 규칙

- **외부 의존성을 추가하지 않는다.**
- **배포는 git 으로만.** tar·scp 패치 금지 (`docs/03-POSTMORTEM.md` 원인 2). 서버에서 `git pull && npm test && sudo systemctl restart trading-floor`.
- **데이터에 없는 수치를 지어내지 않는다.** 없으면 `null` / "데이터 없음".
- **실주문 안전장치는 완화하지 않는다.** `exchange.js` 의 `HARD_LEVERAGE = 1`, 손절 필수, 허용 종목 잠금, 손실 한도는 설정으로 풀 수 없다 — 바꾸려면 코드 리뷰와 `docs/00-CEO-PLAN.md` 갱신이 먼저다.
- **실계좌 URL(`https://fapi.binance.com`)은 Phase 2b 조건 충족 전엔 쓰지 않는다.** 기본은 `https://demo-fapi.binance.com`.
- **자동분석 모델은 sonnet.** opus 는 사람이 직접 누르는 심층 분석에만. 한도 메시지(`session limit`)를 받으면 재시도하지 않는다.
- 시장 데이터 수집은 best-effort — 한 소스가 죽어도 진행. 캔들 실패만 치명적.
- 새 소스를 붙이기 전에 `node -e "fetch(...)"` 로 실제 응답을 확인한다.
- 테스트는 `NODE_TEST_CONTEXT` 하에서 실제 `reports/` 파일에 쓰지 않는다 — 새 로그 모듈도 같은 규칙.

## 한국 주식(하이닉스·삼성전자)의 이중 가격 체계
`market.candles` = KRX 원화 정규장, `market.perp` = USDT 무기한 24시간. 스캘핑 레벨은 반드시 `perp` 기준. 현재 운영 유니버스는 BTC·ETH 라 이 경로는 수동 분석에서만 쓴다.

## 슬래시 커맨드
`/floor <심볼> [algo|scalp|attack]` — 별도 프로세스 없이 현재 세션이 에이전트 전원을 연기한다(할당량 절약).

# PIXEL TRADING FLOOR — Claude Code 안내

AI 에이전트들이 시장 데이터를 분석·토론해 매매 판정을 내리고, 가상 장부와 **바이낸스 선물 데모 계좌**에 주문까지 내는 Node 서버다. 운영 환경은 AWS Lightsail 우분투 + 텔레그램, 조작은 휴대폰 Termux.
경영 판단·단계·철칙은 `docs/00-CEO-PLAN.md`, 1차 실패 원인은 `docs/03-POSTMORTEM.md`.

## 실행

```bash
npm test                       # 847개 단위 테스트 (네트워크·claude 불필요)
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
  trend-follow.js  일봉 추세추종(롱만) 실행기 — trend.enabled 면 매일 한국 09:05 BTC·ETH 비중 조절, 입출금만큼 고점 조정, AI 판정은 주문 안 함
  owner-record.js  오너 직접 매매 기록(실계좌 선물, 읽기 전용 키·GET 만) — 규칙 점검(1배·손절·종목)·수익률·시스템/나스닥 비교
  claude-trader.js 세 번째 선수 'Claude 분석' — 하루 두 번 claude 판단(먼저 복기·교훈 노트 고쳐 쓰기)을 가상 장부에만(주문 경로 없음), 오너와 같은 규칙·실제 시세 채점
  telegram-commands.js 텔레그램 /상태 · /긴급정지 · /재개(오너 채팅방만, 확인 코드)   heartbeat.js  서버 무응답 알림 신호(.env HEALTHCHECK_URL)
  startup-audit.js 재시작 시 손절 없는 포지션 복원/청산     reconcile.js  장부↔거래소 대조
  riskmath.js      손익비·사이징·청산가     positions.js  가상 장부     stats.js  성적표
  retro.js         과거 판정 회고(손절·익절 도달로만 성패 판정)
  universe.js      거래 종목 고정(BTC·ETH)  analysis-budget.js  하루 자동분석 상한
  auth.js/login-page.js  대시보드 로그인    notify.js  텔레그램    daily-summary.js  일간 손익 요약
  candidate-log / trigger-log / cost-log   왜 분석이 안 됐는지·얼마나 썼는지 기록
  backtest/fetch-data.js   BTC·ETH 15m/1d/펀딩 수집 (reports/backtest/data)
  backtest/carry.js        펀딩비 차익(현물 매수 + 선물 매도, 1배) 백테스트
  backtest/trend.js        일봉 추세추종(롱만, 이동평균 앙상블·비중·보호 손절) 백테스트
  backtest/fetch-stocks.js · stock-trend.js   바이낸스 상장 미국 주식의 긴 일봉(Yahoo)으로 같은 규칙 검증(롱만·롱숏)
  backtest/mix-trend.js    코인 + 지수(QQQ·SPY) + 금(GC=F) 섞기 — 같은 규칙, 주식·금 쉬는 날은 stale
  backtest/rotation.js · fetch-alts.js   여러 코인 순환(상대 강도) 연구 — 탈락, 알트는 거래 대상 아님(기록용)
  backtest/combo.js        조합 연구(변동성 맞춤·위험 균등·지수 ETF·쉬는 돈 차익) — 실제 운용 규칙(simulatePortfolio) 위에 얹는다
  backtest/short-term.js   단기 전략(변동성 돌파·RSI2 되돌림·단기 돌파) BTC·ETH 시험
  backtest/ma-grid.js      이평선 두 개 신호등(두 선 위 롱·아래 숏·사이 쉼) 설정값 격자 — SMA·EMA·SMMA, 이웃 고원 확인
  backtest/exits.js        신호등 매매의 롱·숏 방식과 손절·익절·신호청산·기간 비교(코인은 15분봉으로 같은 날 순서 확인)
  backtest/pullback.js     일봉 신호등 + 4시간 SMA20 눌림 진입(15분봉) — 다음 날 09시 진입보다 나빠 철회
  backtest/round2.js · fetch-tradfi.js   2차 탐색(복구 기준): 롱숏·물타기·그리드·공격형·바이낸스 미국 주식 순환
ops/               우분투 설치·systemd·점검·이관 스크립트
docs/              계획·설치·운용·사후분석·영상 분석 기록
reports/           런타임 데이터 (git 제외)
```

## 작업 규칙

- **외부 의존성을 추가하지 않는다.**
- **거래 대상은 BTC·ETH 와 바이낸스에 상장된 미국 주식(지수 ETF 포함)뿐이다(오너 2026-10-15).** 알트코인(잡코인)은 연구로도 후보에 올리지 않는다. 금·은 등 원자재도 주식이 아니라 제외 — 넣으려면 오너 승인이 먼저다.
- **배포는 git 으로만.** tar·scp 패치 금지 (`docs/03-POSTMORTEM.md` 원인 2). 서버에서 `git pull && npm test && sudo systemctl restart trading-floor`.
- **서버 코드는 이 저장소에서만 고친다.** 다른 대화방·다른 AI·다른 도구가 준 압축 묶음(`*.tar.gz`)이나 파일을 서버에 풀거나 복사하지 않는다 — 그들은 최신 코드를 모른다(2026-10-11 사고). 바꾸고 싶은 게 있으면 이 저장소에 커밋한 뒤 `git pull` 로만 반영한다.
- **데이터에 없는 수치를 지어내지 않는다.** 없으면 `null` / "데이터 없음".
- **추세추종 잠금(`trend-follow.js` `HARD`):** 비중 ≤ 100%(1배), 재난 손절 ≤ 평균 진입가 −25%(항상 걸려 있어야 함), 거래소 순자산 고점 대비 −60% 면 전량 청산·정지, BTC·ETH 롱만. 설정으로는 더 엄격하게만 바꾼다. 백테스트(`backtest/trend.js` `simulatePortfolio`)와 같은 규칙이어야 한다 — 실행기를 바꾸면 백테스트도 같이 바꾼다.
- **실주문 안전장치는 완화하지 않는다.** `exchange.js` 의 `HARD_LEVERAGE = 1`, 손절 필수, 허용 종목 잠금, 손실 한도(`HARD_LOSS_LIMITS` 일 3·주 6·월 10%)는 설정으로 풀 수 없다 — 바꾸려면 코드 리뷰와 `docs/00-CEO-PLAN.md` 갱신이 먼저다.
- **실계좌 URL(`https://fapi.binance.com`)은 Phase 1 관문과 Phase 2a 전환 준비물(출금 금지·IP 제한 키, 텔레그램 긴급 정지, 서버 무응답 알림)을 모두 갖추기 전엔 쓰지 않는다.** 기본은 `https://demo-fapi.binance.com`. 오너는 주문하지 않는다 — 모든 주문은 자동이다. **예외: `owner-record.js` 는 실계좌를 읽기만 한다** — 서명된 GET 만 보내는 별도 클라이언트이고, 키(`OWNER_BINANCE_API_*`)에 읽기 말고 다른 권한이 하나라도 있으면 쓰지 않는다. 여기에 주문 경로를 붙이지 않는다.
- **AI 자동 분석(급변동·정기)은 꺼 둔다(오너 2026-10-15, `ops/ai-switch.js --off`).** 매매는 추세추종 기계 규칙만 한다 — AI 판정은 2승 15패로 관문 미달. 다시 켜려면 오너 승인이 먼저다. **예외: `claude-trader.js`(오너 요청 2026-10-15 "너도 최선의 분석을 따로 기록해놔")** — 하루 두 번(09:30·23:40) claude 한 번씩(기본 opus·뉴스 검색), 가상 장부만, 거래소 주문 경로를 붙이지 않는다.
- **자동분석 모델은 sonnet.** opus 는 사람이 직접 누르는 심층 분석에만. 한도 메시지(`session limit`)를 받으면 재시도하지 않는다.
- 시장 데이터 수집은 best-effort — 한 소스가 죽어도 진행. 캔들 실패만 치명적.
- 새 소스를 붙이기 전에 `node -e "fetch(...)"` 로 실제 응답을 확인한다.
- 테스트는 `NODE_TEST_CONTEXT` 하에서 실제 `reports/` 파일에 쓰지 않는다 — 새 로그 모듈도 같은 규칙.

## 한국 주식(하이닉스·삼성전자)의 이중 가격 체계
`market.candles` = KRX 원화 정규장, `market.perp` = USDT 무기한 24시간. 스캘핑 레벨은 반드시 `perp` 기준. 현재 운영 유니버스는 BTC·ETH 라 이 경로는 수동 분석에서만 쓴다.

## 슬래시 커맨드
`/floor <심볼> [algo|scalp|attack]` — 별도 프로세스 없이 현재 세션이 에이전트 전원을 연기한다(할당량 절약).

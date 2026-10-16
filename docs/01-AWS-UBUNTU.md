# AWS 우분투 서버 설치 — 폰(Termux)만으로 끝내는 순서

전제: AWS 계정이 있고, 폰에 Termux 가 설치돼 있다. PC 는 필요 없다.

## 1. 인스턴스 만들기 (폰 브라우저 → AWS 콘솔)

| 항목 | 값 |
|---|---|
| AMI | **Ubuntu Server 24.04 LTS** (x86_64) |
| 타입 | 프리티어면 **t3.micro**, 아니면 **t3.small** |
| 스토리지 | 20 GB gp3 |
| 키 페어 | 새로 생성 → `.pem` 다운로드 (폰 다운로드 폴더에 저장) |
| 보안 그룹 | **SSH(22) 만 허용** — 내 IP 또는 0.0.0.0/0. **8000 포트는 절대 열지 않는다** (열면 아무나 분석을 돌려 구독 사용량을 소진하고 config 의 텔레그램 토큰이 노출된다) |

인스턴스 실행 후 **퍼블릭 IPv4** 를 적어 둔다. 재부팅 시 IP 가 바뀌지 않게 하려면 Elastic IP 를 붙인다(인스턴스에 연결돼 있으면 무료).

### Lightsail 을 쓰는 경우 (EC2 보다 단순, 월 고정 요금)

콘솔 주소가 다르다: <https://lightsail.aws.amazon.com>

| 항목 | 값 |
|---|---|
| 플랫폼 / 블루프린트 | Linux · **OS 전용 · Ubuntu 24.04** |
| 플랜 | **$5/월** (1GB RAM · 2 vCPU · 40GB) — 스왑 2GB 는 설치 스크립트가 만든다. $3.5 플랜(512MB)은 claude -p 가 메모리 부족으로 죽는다 |
| 리전 | **서울 (ap-northeast-2)** |
| SSH 키 | "SSH 키 페어 변경 → 새로 생성" 후 다운로드. 기본 계정명은 **ubuntu** |
| 방화벽 | 인스턴스 → **네트워킹** 탭 → 규칙에 **SSH(22) 만** 남긴다. HTTP(80)이 기본으로 열려 있으면 삭제. 8000 은 추가하지 않는다 |
| 고정 IP | 네트워킹 탭 → "고정 IP 생성" → 인스턴스에 연결 (연결돼 있으면 무료) |

**요금 주의:** Lightsail 은 인스턴스를 **정지(Stop)해도 요금이 나간다.** 안 쓰는 인스턴스는 **삭제(Delete)** 해야 과금이 멈춘다. 첫 3개월 무료 프로모션은 계정당 1회.

## 2. Termux 에서 접속

```bash
pkg update && pkg install -y openssh git
termux-setup-storage            # 폰 저장소 접근 허용 팝업 → 허용
mkdir -p ~/.ssh
cp ~/storage/downloads/키이름.pem ~/.ssh/aws.pem
chmod 600 ~/.ssh/aws.pem
ssh -i ~/.ssh/aws.pem ubuntu@<퍼블릭IP>
```

매번 치기 귀찮으면 `~/.ssh/config` 에:

```
Host aws
  HostName <퍼블릭IP>
  User ubuntu
  IdentityFile ~/.ssh/aws.pem
  ServerAliveInterval 30
```

이후 `ssh aws` 로 접속.

## 3. 서버에서 설치 (한 번만)

```bash
git clone https://github.com/qawswd/-1.git ~/trading-floor
cd ~/trading-floor
bash ops/install-ubuntu.sh
```

10분 안팎. 끝나면 남은 수동 작업 2가지가 안내된다.

### 3-1. claude 로그인 (사람만 할 수 있다)

```bash
cd ~ && claude
```

- 로그인 방식 선택 → **Claude 계정(구독)** 선택
- 터미널에 URL 이 뜬다 → 길게 눌러 복사 → 폰 브라우저에서 열기 → 승인
- 브라우저가 보여주는 코드를 복사 → 터미널의 `Paste code here` 에 붙여넣기
- `/status` 로 구독 계정인지 확인 → `/exit`
- 확인: `echo hi | claude -p` 가 답을 하면 끝

주의: `ANTHROPIC_API_KEY` 환경변수가 있으면 구독 대신 API 과금이 된다. 서비스 유닛은 이 변수를 강제로 비운다.

### 3-2. 설정

```bash
nano ~/trading-floor/config.json
```

- `telegram.botToken` — 텔레그램에서 @BotFather → `/newbot` → 토큰
- `telegram.chatId` — @userinfobot 에게 아무 말 → `Id` 숫자. 그리고 **내 봇에게 먼저 아무 메시지 하나를 보내 둔다** (봇은 먼저 말을 못 건다)
- `telegram.enabled` → `true`
- `risk.accountSize` — 이번 달 운용 한도(원). 매달 입금 후 갱신
- `schedule.jobs` — 시각은 **KST**. 서버 시간대는 설치 스크립트가 KST 로 맞췄다

## 4. 시작·확인

```bash
sudo systemctl start trading-floor
bash ops/doctor.sh                       # 8단계 점검
journalctl -u trading-floor -f           # 실시간 로그 (Ctrl+C 로 나감)
curl -s -X POST localhost:8000/api/telegram/test   # 폰에 테스트 메시지가 와야 한다
```

첫 분석을 수동으로 돌려 보려면:

```bash
curl -s -X POST localhost:8000/api/analyze -H 'content-type: application/json' \
  -d '{"symbol":"SKHYNIX","mode":"scalp"}'
```

2~3분 뒤 텔레그램으로 판정이 오고 `reports/` 에 마크다운이 쌓인다.

## 5. 갱신 (코드가 바뀌었을 때)

```bash
cd ~/trading-floor && git pull && npm test && sudo systemctl restart trading-floor
```

## 6. 문제가 생기면

| 증상 | 처치 |
|---|---|
| 분석이 "파싱 실패" | `bash ops/doctor.sh` → [3] claude -p 응답 확인. 로그인 만료면 `cd ~ && claude` 로 재로그인 |
| 메모리 부족으로 죽음 (`journalctl` 에 Killed) | 스왑 확인 `free -h`. 없으면 설치 스크립트 재실행. 계속되면 t3.small |
| 예약이 엉뚱한 시각에 돎 | `date` 가 KST 인지. 아니면 `sudo timedatectl set-timezone Asia/Seoul && sudo systemctl restart trading-floor` |
| 텔레그램이 안 옴 | 봇에게 먼저 메시지를 보냈는지, chatId 가 숫자인지, `enabled:true` 인지 |
| 시세가 "데이터 없음" | `bash ops/doctor.sh` [7] — AWS 리전에 따라 Binance 가 막히는 경우(미국 리전). **서울(ap-northeast-2) 또는 도쿄 리전**을 쓴다 |

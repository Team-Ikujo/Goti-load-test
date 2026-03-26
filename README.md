# Goti Load Test

Goti 티켓팅 서비스 부하 테스트 (K6 기반).

## 사전 준비

- [K6](https://grafana.com/docs/k6/latest/set-up/install-k6/) 설치

## 빠른 시작

```bash
# 1. 개인 설정 파일 생성
cp my-config.env.example my-config.env

# 2. my-config.env에서 RUNNER_ID, RUNNER_NAME 수정
#    RUNNER_ID: 0~3 (팀원마다 다른 번호)
#    RUNNER_NAME: 본인 이름

# 3. 실행
./run.sh smoke    # API 정상 확인
./run.sh e2e      # 혼합 시나리오 부하
```

## 시나리오

| 시나리오 | 명령 | 설명 |
|----------|------|------|
| **smoke** | `./run.sh smoke` | API 정상 응답 확인 (1 VU, 1회) |
| **e2e** | `./run.sh e2e` | 혼합 시나리오 부하 (조회 35% + 예매 25% + 취소 10% + 경합 10% + ...) |
| **spike** | `./run.sh spike` | 티켓 오픈 급증 시뮬레이션 (10→200→100→20 rps) |
| **normal** | `./run.sh normal` | 평시 트래픽 시뮬레이션 (10분, 30→80→80→30 VU) |
| **soak** | `./run.sh soak` | 장시간 안정성 검증 (기본 1시간, 메모리/커넥션 누수 감지) |

## 분산 실행 (팀원 4명 동시)

각자 PC에서 서로 다른 `RUNNER_ID`로 동시 실행:

```bash
# 1번 팀원
./run.sh e2e    # my-config.env: RUNNER_ID=0

# 2번 팀원
./run.sh e2e    # my-config.env: RUNNER_ID=1

# 3번 팀원
./run.sh e2e    # my-config.env: RUNNER_ID=2

# 4번 팀원
./run.sh e2e    # my-config.env: RUNNER_ID=3
```

동시 시작이 필요하면 `START_TIME` 설정:

```bash
# my-config.env에 추가
START_TIME=18:00:00
```

## 설정

`my-config.env`에서 조정 가능한 값:

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `RUNNER_ID` | 0 | 러너 번호 (0~3) |
| `RUNNER_NAME` | runner-0 | 대시보드 표시 이름 |
| `GAME_ID` | (자동 선택) | 타겟 경기 ID |
| `VUS` | 20 | 동시 사용자 수 |
| `BASE_URL` | https://your-api-url | API URL |
| `PUSH_METRICS` | false | Mimir로 메트릭 Push |
| `MAX_RATE` | 200 | 스파이크 최대 RPS |
| `DURATION` | 1h | Soak 지속 시간 |
| `START_TIME` | (즉시 시작) | 동시 시작 시각 (예: 18:00:00) |

CLI 환경변수가 config 파일보다 우선합니다:

```bash
VUS=50 ./run.sh e2e
```

## Mimir 메트릭 Push

K6 결과를 Grafana Mimir로 전송하여 대시보드에서 확인:

```bash
# my-config.env
PUSH_METRICS=true
MIMIR_PUSH_URL=https://your-api-url/mimir/api/v1/push
```

## 디렉토리 구조

```
├── config/
│   └── environments.js     # 환경별 설정 (URL, thresholds)
├── dashboards/
│   └── k6-load-test.json   # Grafana 대시보드
├── helpers/
│   ├── auth.js             # 회원가입/로그인
│   ├── data-setup.js       # 테스트 데이터 셋업
│   ├── http-client.js      # HTTP 래퍼 (헤더, 로깅)
│   └── ticketing-actions.js # 티켓팅 액션 (예매, 취소, 경합)
├── k8s/
│   └── synthetic-traffic.yaml  # CronJob 설정
├── scenarios/
│   ├── smoke.js            # 스모크 테스트
│   ├── e2e-ticketing.js    # E2E 혼합 시나리오
│   ├── spike-ticketing.js  # 스파이크 테스트
│   ├── normal-load.js      # 일반 부하
│   ├── soak-stability.js   # 장시간 안정성
│   └── synthetic-traffic.js # 합성 트래픽 (CronJob용)
├── run.sh                  # 실행 스크립트
├── my-config.env.example   # 설정 템플릿
└── my-config.env           # 개인 설정 (gitignore)
```

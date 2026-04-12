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

---

## 📒 테스트 운영 노트 (트러블슈팅 아카이브)

실패 재발 방지용. 유사 증상 발견 시 먼저 확인.

### Cloudflare Rate Limit (429, error code 1015)

**증상**: `api.go-ti.shop` 호출 시 HTTP 429, 테스트 즉시 종료.
**원인**: 단일 EC2 EIP에서 대량 요청 → Cloudflare WAF Rate Limit.
**해결**: Cloudflare `allow_internal_ip` 룰에 테스트 EC2 EIP 추가.
- 현재 EC2: `i-0f5fcae00e8d06a77` / EIP `43.202.205.23`
- 룰 예시: `(ip.src eq 43.202.205.23) → Skip`
- 위치: Cloudflare Dashboard → `go-ti.shop` → Security → WAF

### QUEUE_TOKEN_INVALID 대량 발생 (ticket success 0%)

**증상**: seat-enter는 `ADMITTED` 성공인데 이후 seat-hold부터 전부 실패. Ticketing 로그에 `errorCode=QUEUE_TOKEN_INVALID` 대량.
**원인**: `holdSeat()` 호출 시 7번째 인자 `queueToken` 누락 → 서버가 fake JTI를 JWE로 파싱 시도 → 검증 실패.
**해결**: 모든 시나리오의 `holdSeat(...)` 호출에 `queueResult.queueToken`를 전달해야 함.
```javascript
// OK
const hid = holdSeat(tUrl, seatId, gameId, __VU, __ITER, auth, queueResult.queueToken);
// NG (fake JTI 발급됨)
const hid = holdSeat(tUrl, seatId, gameId, __VU, __ITER, auth);
```

### 대기열 Cascade — activeCount 누적

**증상**: 두 번째 부하부터 VU들이 전부 `queue: 타임아웃 (150회 polling 후에도 미통과)`.
**원인**: `queue-suyeon.js`는 `if (success) queueLeave(...)` 로 **결제 성공 시에만 leave 호출**. 상류(seat-hold 등)에서 실패하면 leave 안 부름 → active 자리 점유 → maxCapacity 도달 → 후속 VU 전부 차단.
**해결책**:
1. 위의 QUEUE_TOKEN_INVALID 같은 상류 실패 원인을 먼저 제거 (그러면 결제까지 가서 leave 호출됨)
2. 재발 시 Redis `queue:{gameId}:meta` 확인 — `activeCount == maxCapacity`면 cascade 상태
3. 긴급 해결: Redis `FLUSHALL ASYNC` (테스트 전용 환경)

### Redis 직접 접근 (EKS 내부 경유)

**증상**: EC2에서 `redis6-cli ... FLUSHALL` 걸면 오래 걸리거나 TLS 연결 stuck.
**해결**: EKS 내부에 redis-alpine 디버그 Pod을 띄우고 거기서 접근. Kyverno 통과를 위해 아래 필드 필수:
```yaml
labels: {app: <name>, version: v1, app.kubernetes.io/name: <name>}
resources:
  requests: {cpu: 10m, memory: 32Mi}
  limits: {cpu: 200m, memory: 128Mi}
securityContext: {runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false, capabilities: {drop: ["ALL"]}}
livenessProbe:  {exec: {command: ["true"]}}
readinessProbe: {exec: {command: ["true"]}}
```
Redis 접속 정보:
```bash
AUTH=$(kubectl get secret goti-queue-prod-secrets -n goti -o jsonpath='{.data.REDIS_AUTH_TOKEN}' | base64 -d)
HOST=master.goti-prod-redis.t46pxo.apn2.cache.amazonaws.com
redis-cli -h $HOST -p 6379 --tls -a $AUTH --no-auth-warning <command>
```

### 테스트 전 필수 체크리스트

1. **좌석 init (기아/삼성 홈만 좌석 데이터 있음)**:
   ```bash
   TOKEN=$(curl -sk -X POST -H "Host: api.go-ti.shop" -H "Content-Type: application/json" \
     -d '{"mobile":"00000000001"}' <ALB_URL>/api/v1/test/users/login | jq -r .data.accessToken)
   curl -sk -X POST -H "Host: api.go-ti.shop" -H "Authorization: Bearer $TOKEN" \
     <ALB_URL>/api/v1/game-seats/<gameId>/init
   ```
   - idempotent: 좌석 레코드가 없을 때만 AVAILABLE로 생성. 이미 SOLD/HELD 상태는 건드리지 않음
   - 인증 필요 (Istio JWT 검증). 아무 유저 JWT나 OK
2. **Redis queue 상태 클린** (선행 테스트 잔여물 제거):
   ```bash
   redis-cli ... FLUSHALL ASYNC
   ```
3. **Ticketing KEDA 처리**: capacity baseline 측정 시 pod 수 고정 필요.
   - `environments/prod/goti-ticketing/values-aws.yaml` 에 `autoscaling.enabled: false` + `replicaCount: N` 추가 → PR + ArgoCD sync
   - 테스트 후 원복
4. **경기 유효성**:
   - `ticketingStatus == "AVAILABLE"` 이어야 함
   - `ticketingEndAt > now()` 이어야 함
   - 구장은 기아(광주) 또는 삼성(대구) 홈 (좌석 시드 존재)

### 성공 baseline (2026-04-12)

- **환경**: EKS prod, ticketing pod=2 (KEDA off), 경기 `a5cdd8b5-...` (기아 04-14)
- **부하**: 100 VU × 2.5분 via `api.go-ti.shop` (Cloudflare whitelist 적용)
- **시나리오**: `queue-suyeon.js`
- **결과**:
  - `goti_ticket_success_rate`: 99.59% (740/743)
  - `http_req_failed`: 0.16% (18/10862)
  - p95 — seat_selection 149ms, order 213ms, payment 424ms
  - `queue: 타임아웃 (150회 polling 후에도 미통과)`: 0건

---

## 🚀 실행 예시 (목적별 `my-config.env` 프리셋)

`my-config.env`는 gitignore. 아래 케이스별 설정을 복사해서 쓰세요. 실행은 `./run.sh <시나리오>`.

### 공통 경기 정보 (기아 홈, 2026-04-14)
```bash
GAME_ID=a5cdd8b5-8d93-4751-a0dd-a02de19849ee
STADIUM_ID=4553f1c7-f5c1-468f-8ac9-f4883eb59ebc
HOME_TEAM_ID=e5f58f8c-fcde-4017-8033-d8deb34fd4a2
```
삼성 홈은 `STADIUM_ID=49f8dfd8-ee9c-439b-bd6e-b31f01252d47`, `HOME_TEAM_ID=412cfc77-2c5d-4583-8e79-968339223864`. (팀 ID는 `goti-team-controller` 메모리의 `reference_team_stadium_ids.md` 참조)

---

### Case A — 로컬에서 smoke (빠른 검증, API 정상 응답만)

```bash
# my-config.env
RUNNER_ID=0
RUNNER_NAME=kimhj
VUS=1
BASE_URL=https://api.go-ti.shop
GAME_ID=a5cdd8b5-8d93-4751-a0dd-a02de19849ee
STADIUM_ID=4553f1c7-f5c1-468f-8ac9-f4883eb59ebc
HOME_TEAM_ID=e5f58f8c-fcde-4017-8033-d8deb34fd4a2
PUSH_METRICS=false
```
실행:
```bash
./run.sh smoke                 # scenarios/smoke.js (1 VU)
./run.sh flow-debug           # 단일 VU 전체 플로우 디버그 로그
```

---

### Case B — ALB 직접 (Cloudflare 우회, capacity 측정)

ALB 한계만 보고 싶거나, Cloudflare Rate Limit 미적용 구간이 필요할 때.

```bash
# my-config.env
RUNNER_ID=0
RUNNER_NAME=kimhj
VUS=100
ENV=prod-alb                    # ← 프리셋: BASE_URL/HOST_HEADER 자동 설정
GAME_ID=a5cdd8b5-8d93-4751-a0dd-a02de19849ee
STADIUM_ID=4553f1c7-f5c1-468f-8ac9-f4883eb59ebc
HOME_TEAM_ID=e5f58f8c-fcde-4017-8033-d8deb34fd4a2
# ENV=prod-alb 사용 시 TEAM=kia로 기아 구장 자동 전환 가능
# TEAM=kia
PUSH_METRICS=true
MIMIR_PUSH_URL=http://localhost:9009/api/v1/push   # 별도 터미널: ./run.sh port-forward
```
실행:
```bash
./run.sh port-forward &        # 1) Mimir port-forward
./run.sh queue-suyeon          # 2) 메인 부하
```
ℹ️ `ENV=prod-alb` 지정 시 `BASE_URL`/`HOST_HEADER`는 `config/environments.js`가 자동 주입.
ℹ️ k6 CLI 직접 호출 시에는 `--insecure-skip-tls-verify` 추가 필요 (run.sh는 자동).

---

### Case C — Cloudflare 경유 (실전 경로 측정)

실 서비스 경로(Cloudflare → ALB → Istio Gateway) 포함한 end-to-end 측정.

```bash
# my-config.env
RUNNER_ID=0
RUNNER_NAME=kimhj
VUS=100
BASE_URL=https://api.go-ti.shop
GAME_ID=a5cdd8b5-8d93-4751-a0dd-a02de19849ee
STADIUM_ID=4553f1c7-f5c1-468f-8ac9-f4883eb59ebc
HOME_TEAM_ID=e5f58f8c-fcde-4017-8033-d8deb34fd4a2
PUSH_METRICS=true
MIMIR_PUSH_URL=http://localhost:9009/api/v1/push
```
실행:
```bash
./run.sh port-forward &
./run.sh queue-suyeon
```
⚠️ **Cloudflare Rate Limit 주의**: 단일 IP로 대량 요청 시 HTTP 429 (error code 1015). 테스트 IP를 WAF `allow` 룰에 먼저 추가. 위 "Cloudflare Rate Limit" 섹션 참조.

---

### Case D — EC2 분산 실행 (예: 4대 × 1500 VU = 6000 VU)

EC2 4대에서 `START_TIME` 동기화로 동시 실행. 각 runner는 고유 `RUNNER_ID`.

```bash
# my-config.env (4대 동일하게 복사, RUNNER_ID만 변경)
RUNNER_NAME=runner
VUS=1500
ENV=prod-alb                   # 또는 BASE_URL=https://api.go-ti.shop
GAME_ID=a5cdd8b5-8d93-4751-a0dd-a02de19849ee
STADIUM_ID=4553f1c7-f5c1-468f-8ac9-f4883eb59ebc
HOME_TEAM_ID=e5f58f8c-fcde-4017-8033-d8deb34fd4a2
START_TIME=13:40:00            # 오늘 13:40:00까지 sleep 후 동시 시작
PUSH_METRICS=true
MIMIR_PUSH_URL=http://localhost:9009/api/v1/push

# 각 runner마다 RUNNER_ID만 다르게
# runner 1: RUNNER_ID=0
# runner 2: RUNNER_ID=1
# runner 3: RUNNER_ID=2
# runner 4: RUNNER_ID=3
```
실행 (각 EC2에서):
```bash
cd ~/goti-load-test && git pull
./run.sh queue-suyeon           # START_TIME까지 sleep 후 일제히 start
```
ℹ️ 메모리 레퍼런스: VU당 ~5MB 메모리. c7g.xlarge(8GB) = ~1500 VU 한계, r7g.xlarge(32GB) = ~6000 VU.
ℹ️ Grafana `load-test-command-center` 대시보드에서 `runner` 레이블로 분리 확인 가능.

---

### Case E — CLI 환경변수로 일회성 override (직접 k6 호출)

`run.sh` 안 쓰고 k6 직접 실행. Mimir push 없이 text summary만.

```bash
k6 run scenarios/queue-suyeon.js \
  -e BASE_URL=https://api.go-ti.shop \
  -e GAME_ID=a5cdd8b5-8d93-4751-a0dd-a02de19849ee \
  -e STADIUM_ID=4553f1c7-f5c1-468f-8ac9-f4883eb59ebc \
  -e HOME_TEAM_ID=e5f58f8c-fcde-4017-8033-d8deb34fd4a2 \
  -e VUS=100 \
  --insecure-skip-tls-verify \
  --summary-export /tmp/k6-result.json
```
⚠️ Mimir 메트릭 없으면 Grafana 대시보드에 안 뜸. 대시보드 관찰이 필요하면 Case B/C/D 사용.

---

### 환경변수 우선순위

1. CLI `-e KEY=VALUE` (최우선)
2. `run.sh` 실행 시점의 shell 환경변수
3. `my-config.env` 파일
4. 각 시나리오의 기본값

run.sh가 이 순서로 merge합니다. Case E처럼 `k6 run`을 직접 부르면 `my-config.env`는 무시됩니다.

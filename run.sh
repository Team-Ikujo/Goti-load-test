#!/usr/bin/env bash
# =============================================================================
# Goti 부하테스트 실행 스크립트
#
# 사용법:
#   ./run.sh                    # 기본 (smoke)
#   ./run.sh e2e                # E2E 혼합 시나리오
#   ./run.sh spike              # 스파이크 테스트
#   ./run.sh normal             # 일반 부하
#   ./run.sh soak              # 장시간 안정성
#   ./run.sh smoke             # 스모크 (API 정상 확인)
#   ./run.sh port-forward      # Mimir port-forward 시작
#
# 분산 실행 (4명 동시):
#   1. 터미널 1: ./run.sh port-forward
#   2. 터미널 2: ./run.sh e2e   (PUSH_METRICS=true)
# =============================================================================

# ---------------------------------------------------------------------------
# 설정 파일 로드 — my-config.env 파일에 개인 설정을 넣으면 됨
# ---------------------------------------------------------------------------
SCRIPT_DIR_EARLY="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="${SCRIPT_DIR_EARLY}/my-config.env"

# CLI 환경변수를 백업 (config 파일보다 CLI가 우선)
_CLI_RUNNER_ID="${RUNNER_ID-}"
_CLI_RUNNER_NAME="${RUNNER_NAME-}"
_CLI_GAME_ID="${GAME_ID-}"
_CLI_VUS="${VUS-}"
_CLI_BASE_URL="${BASE_URL-}"
_CLI_MAX_RATE="${MAX_RATE-}"
_CLI_DURATION="${DURATION-}"
_CLI_PUSH_METRICS="${PUSH_METRICS-}"
_CLI_MIMIR_PUSH_URL="${MIMIR_PUSH_URL-}"
_CLI_START_TIME="${START_TIME-}"
_CLI_TEST_NAME="${TEST_NAME-}"
_CLI_QUEUE_URL="${QUEUE_URL-}"
_CLI_STADIUM_ID="${STADIUM_ID-}"
_CLI_HOME_TEAM_ID="${HOME_TEAM_ID-}"
_CLI_HOST_HEADER="${HOST_HEADER-}"

# config 파일 로드 (없으면 my-config.env.example → my-config.env 복사 안내)
if [ -f "$CONFIG_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$CONFIG_FILE"; set +a
fi

# CLI 환경변수가 있으면 config보다 우선
[ -n "$_CLI_RUNNER_ID" ]      && RUNNER_ID="$_CLI_RUNNER_ID"
[ -n "$_CLI_RUNNER_NAME" ]    && RUNNER_NAME="$_CLI_RUNNER_NAME"
[ -n "$_CLI_GAME_ID" ]        && GAME_ID="$_CLI_GAME_ID"
[ -n "$_CLI_VUS" ]            && VUS="$_CLI_VUS"
[ -n "$_CLI_BASE_URL" ]       && BASE_URL="$_CLI_BASE_URL"
[ -n "$_CLI_MAX_RATE" ]       && MAX_RATE="$_CLI_MAX_RATE"
[ -n "$_CLI_DURATION" ]       && DURATION="$_CLI_DURATION"
[ -n "$_CLI_PUSH_METRICS" ]   && PUSH_METRICS="$_CLI_PUSH_METRICS"
[ -n "$_CLI_MIMIR_PUSH_URL" ] && MIMIR_PUSH_URL="$_CLI_MIMIR_PUSH_URL"
[ -n "$_CLI_START_TIME" ]     && START_TIME="$_CLI_START_TIME"
[ -n "$_CLI_TEST_NAME" ]     && TEST_NAME="$_CLI_TEST_NAME"
[ -n "$_CLI_QUEUE_URL" ]     && QUEUE_URL="$_CLI_QUEUE_URL"
[ -n "$_CLI_STADIUM_ID" ]    && STADIUM_ID="$_CLI_STADIUM_ID"
[ -n "$_CLI_HOME_TEAM_ID" ]  && HOME_TEAM_ID="$_CLI_HOME_TEAM_ID"
[ -n "$_CLI_HOST_HEADER" ]   && HOST_HEADER="$_CLI_HOST_HEADER"

# 기본값 (어디에도 설정 안 된 항목만)
RUNNER_ID="${RUNNER_ID:-0}"
RUNNER_NAME="${RUNNER_NAME:-runner-${RUNNER_ID}}"
GAME_ID="${GAME_ID:-}"
VUS="${VUS:-20}"
BASE_URL="${BASE_URL:-}"
MAX_RATE="${MAX_RATE:-200}"
DURATION="${DURATION:-1h}"
PUSH_METRICS="${PUSH_METRICS:-false}"
MIMIR_PUSH_URL="${MIMIR_PUSH_URL:-}"
START_TIME="${START_TIME:-}"
QUEUE_URL="${QUEUE_URL:-}"
STADIUM_ID="${STADIUM_ID:-}"
HOME_TEAM_ID="${HOME_TEAM_ID:-}"
HOST_HEADER="${HOST_HEADER:-}"

# ---------------------------------------------------------------------------
# 실행 (아래는 수정 불필요)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCENARIO="${1:-smoke}"

# port-forward 헬퍼
if [ "$SCENARIO" = "port-forward" ]; then
  echo ""
  CONTEXT="${K8S_CONTEXT:-goti-prod}"
  MIMIR_SVC="${MIMIR_SVC:-mimir-prod-distributor}"
  echo "  Mimir Distributor port-forward 시작"
  echo "  localhost:9009 → ${MIMIR_SVC}.monitoring.svc:8080"
  echo "  context: ${CONTEXT}"
  echo "  (Ctrl+C로 종료)"
  echo ""
  kubectl port-forward -n monitoring --context "$CONTEXT" "svc/${MIMIR_SVC}" 9009:8080
  exit 0
fi

# 시나리오 매핑
case "$SCENARIO" in
  e2e)                     FILE="scenarios/e2e-ticketing.js" ;;
  spike)                   FILE="scenarios/spike-ticketing.js" ;;
  normal)                  FILE="scenarios/normal-load.js" ;;
  soak)                    FILE="scenarios/soak-stability.js" ;;
  smoke)                   FILE="scenarios/smoke.js" ;;
  queue-suyeon)            FILE="scenarios/queue-suyeon.js" ;;
  queue-suyeon-spike)      FILE="scenarios/queue-suyeon-spike.js" ;;
  queue-suyeon-saturation) FILE="scenarios/queue-suyeon-saturation.js" ;;
  queue-suyeon-heartbeat)  FILE="scenarios/queue-suyeon-heartbeat.js" ;;
  queue-oneshot)           FILE="scenarios/queue-oneshot.js" ;;
  *)
    echo "사용법: $0 {smoke|e2e|spike|normal|soak|queue-suyeon*|queue-oneshot|port-forward}"
    echo ""
    echo "  smoke                   — API 정상 응답 확인 (1 VU, 1회)"
    echo "  e2e                     — 혼합 시나리오 부하 (조회+예매+취소+경합)"
    echo "  spike                   — 티켓 오픈 급증 시뮬레이션"
    echo "  normal                  — 평시 트래픽 시뮬레이션"
    echo "  soak                    — 장시간 안정성 검증"
    echo "  queue-suyeon            — 대기열→예매 E2E (방식3)"
    echo "  queue-suyeon-spike      — 대기열만 스파이크 (예매 X)"
    echo "  queue-suyeon-saturation — 대기열 포화 (수용 초과)"
    echo "  queue-suyeon-heartbeat  — Polling 스트레스 (Redis 부하)"
    echo "  queue-oneshot             — 대기열 원샷 (1인 1회, 대규모 동시접속)"
    echo "  port-forward            — Mimir port-forward (메트릭 Push용)"
    exit 1
    ;;
esac

# 테스트 세션명 자동 생성
TIMESTAMP=$(date '+%Y%m%d-%H%M%S')
TEST_NAME="${TEST_NAME:-${SCENARIO}-${TIMESTAMP}}"

# 결과 디렉토리
RESULTS_DIR="${SCRIPT_DIR}/results"
mkdir -p "$RESULTS_DIR"

# 배너
echo ""
echo "  ┌──────────────────────────────────────┐"
echo "  │     Goti Load Test                   │"
echo "  └──────────────────────────────────────┘"
echo ""
echo "  시나리오:    $SCENARIO"
echo "  테스트명:    $TEST_NAME"
echo "  러너:        $RUNNER_NAME (ID: $RUNNER_ID)"
echo "  경기 ID:     ${GAME_ID:-자동 선택}"
echo "  VUS:         $VUS"
echo "  URL:         $BASE_URL"
echo "  Mimir Push:  $PUSH_METRICS"
[ -n "$HOST_HEADER" ]       && echo "  Host 헤더:   $HOST_HEADER"
[ -n "$QUEUE_URL" ]         && echo "  Queue URL:   $QUEUE_URL"
[ "$SCENARIO" = "spike" ]  && echo "  MAX_RATE:    $MAX_RATE rps"
[ "$SCENARIO" = "soak" ]   && echo "  DURATION:    $DURATION"
[ -n "$START_TIME" ]        && echo "  시작 시각:   $START_TIME"
echo ""

# 동시 시작 대기
if [ -n "$START_TIME" ]; then
  # macOS/Linux 호환 시각 파싱
  if date -j >/dev/null 2>&1; then
    # macOS
    TODAY=$(date '+%Y-%m-%d')
    TARGET_EPOCH=$(date -j -f "%Y-%m-%d %H:%M:%S" "${TODAY} ${START_TIME}" +%s 2>/dev/null)
  else
    # Linux
    TODAY=$(date '+%Y-%m-%d')
    TARGET_EPOCH=$(date -d "${TODAY} ${START_TIME}" +%s 2>/dev/null)
  fi

  if [ -n "$TARGET_EPOCH" ]; then
    NOW_EPOCH=$(date +%s)
    WAIT_SECS=$((TARGET_EPOCH - NOW_EPOCH))
    if [ "$WAIT_SECS" -gt 0 ]; then
      echo "  ⏳ ${START_TIME}까지 ${WAIT_SECS}초 대기 중..."
      sleep "$WAIT_SECS"
      echo "  🚀 시작!"
      echo ""
    else
      echo "  ⚡ 지정 시각 이미 지남 — 즉시 시작"
      echo ""
    fi
  else
    echo "  ⚠️  START_TIME 파싱 실패 (${START_TIME}) — 즉시 시작"
    echo ""
  fi
fi

# K6 실행 옵션 조립
K6_ARGS=(
  "${SCRIPT_DIR}/${FILE}"
  -e RUNNER_ID="$RUNNER_ID"
  -e RUNNER_NAME="$RUNNER_NAME"
  -e TEST_NAME="$TEST_NAME"
  -e GAME_ID="$GAME_ID"
  -e BASE_URL="$BASE_URL"
  -e VUS="$VUS"
  -e MAX_RATE="$MAX_RATE"
  -e DURATION="$DURATION"
  -e QUEUE_URL="$QUEUE_URL"
  -e STADIUM_ID="$STADIUM_ID"
  -e HOME_TEAM_ID="$HOME_TEAM_ID"
  -e HOST_HEADER="$HOST_HEADER"
  --tag runner="$RUNNER_NAME"
  --tag test_name="$TEST_NAME"
  --tag scenario="$SCENARIO"
  --summary-export "${RESULTS_DIR}/${TEST_NAME}-${RUNNER_NAME}.json"
)

# Mimir Push 옵션
if [ "$PUSH_METRICS" = "true" ]; then
  export K6_PROMETHEUS_RW_SERVER_URL="$MIMIR_PUSH_URL"
  export K6_PROMETHEUS_RW_PUSH_INTERVAL="2s"
  export K6_PROMETHEUS_RW_STALE_MARKERS="true"
  K6_ARGS+=(--out experimental-prometheus-rw)
  echo "  📊 메트릭 → $MIMIR_PUSH_URL"
  echo ""
fi

k6 run "${K6_ARGS[@]}"
EXIT_CODE=$?

echo ""
echo "  결과 저장: ${RESULTS_DIR}/${TEST_NAME}-${RUNNER_NAME}.json"
echo "  종료 코드: $EXIT_CODE"
echo ""

exit $EXIT_CODE

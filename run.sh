#!/usr/bin/env bash
# =============================================================================
# Goti 부하테스트 실행 스크립트
#
# 2026-04-18 정리: queue-oneshot 과 multicloud-readonly 만 유지.
# 나머지 시나리오는 scenarios/_deprecated/ 로 이관 예정 (아래 주석 참조).
#
# 사용법:
#   ./run.sh queue-oneshot          # 대기열→예매 1인 1회 (대규모 동시접속 시뮬)
#   ./run.sh multicloud-readonly    # 멀티클라우드 read-only 관측 (ADR-0018 Phase B)
#   ./run.sh port-forward           # Mimir port-forward (메트릭 push 용)
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

if [ -f "$CONFIG_FILE" ]; then
  set -a; source "$CONFIG_FILE"; set +a
fi

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
[ -n "$_CLI_TEST_NAME" ]      && TEST_NAME="$_CLI_TEST_NAME"
[ -n "$_CLI_QUEUE_URL" ]      && QUEUE_URL="$_CLI_QUEUE_URL"
[ -n "$_CLI_STADIUM_ID" ]     && STADIUM_ID="$_CLI_STADIUM_ID"
[ -n "$_CLI_HOME_TEAM_ID" ]   && HOME_TEAM_ID="$_CLI_HOME_TEAM_ID"
[ -n "$_CLI_HOST_HEADER" ]    && HOST_HEADER="$_CLI_HOST_HEADER"

# 기본값
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
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCENARIO="${1:-queue-oneshot}"

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

# 시나리오 매핑 — queue-oneshot, multicloud-readonly 만 유지
case "$SCENARIO" in
  queue-oneshot)         FILE="scenarios/queue-oneshot.js" ;;
  multicloud-readonly)   FILE="scenarios/multicloud-readonly.js" ;;
  *)
    echo "사용법: $0 {queue-oneshot|multicloud-readonly|port-forward}"
    echo ""
    echo "  queue-oneshot        — 대기열 원샷 (1인 1회, 대규모 동시접속 시뮬)"
    echo "  multicloud-readonly  — 멀티클라우드 read-only 관측 (ADR-0018 Phase B)"
    echo "  port-forward         — Mimir port-forward (메트릭 Push용)"
    echo ""
    echo "  (2026-04-18 정리: smoke/e2e/spike/normal/soak/queue-suyeon*/flow-debug"
    echo "   시나리오는 더 이상 사용하지 않음. 기존 파일이 남아있다면 수동 정리 권장.)"
    exit 1
    ;;
esac

# 테스트 세션명 자동 생성
TIMESTAMP=$(date '+%Y%m%d-%H%M%S')
TEST_NAME="${TEST_NAME:-${SCENARIO}-${TIMESTAMP}}"

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
echo "  VUS:         $VUS"
echo "  URL:         $BASE_URL"
echo "  Mimir Push:  $PUSH_METRICS"
[ -n "$HOST_HEADER" ]       && echo "  Host 헤더:   $HOST_HEADER"
[ -n "$QUEUE_URL" ]         && echo "  Queue URL:   $QUEUE_URL"
[ -n "$START_TIME" ]        && echo "  시작 시각:   $START_TIME"
echo ""

# 동시 시작 대기
if [ -n "$START_TIME" ]; then
  if date -j >/dev/null 2>&1; then
    TODAY=$(date '+%Y-%m-%d')
    TARGET_EPOCH=$(date -j -f "%Y-%m-%d %H:%M:%S" "${TODAY} ${START_TIME}" +%s 2>/dev/null)
  else
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
    fi
  fi
fi

# K6 실행 옵션
USER_AGENT="${USER_AGENT:-Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36}"

K6_ARGS=(
  "${SCRIPT_DIR}/${FILE}"
  --user-agent "$USER_AGENT"
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

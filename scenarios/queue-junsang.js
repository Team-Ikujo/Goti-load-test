import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { signup, authHeaders } from '../helpers/auth.js';
import { get, post } from '../helpers/http-client.js';
import {
  queueMetrics,
  waitForQueuePass,
  queueAuthHeaders,
} from '../helpers/queue-actions.js';
import {
  metrics,
  browseSeatGrades,
  browseSeatSections,
  browsePricingPolicy,
  browseSeatStatus,
  holdSeat,
  createOrder,
  payOrder,
} from '../helpers/ticketing-actions.js';

/**
 * 대기열 부하테스트 — 구현 방식 1 (junsang): Redis Sorted Set + Scheduler.
 *
 * PR: https://github.com/Team-Ikujo/Goti-server/pull/312
 * 브랜치: poc/queue-waiting-junsang
 *
 * 측정 목표:
 *   - 대기열 진입 → 통과 대기 시간 (queue_wait_duration_ms)
 *   - 동시 진입 시 처리량 (queue_validate_ms)
 *   - 즉시 통과 비율 (queue_immediate_pass_rate)
 *   - 대기열 → 예매 완료 E2E 시간 (queue_e2e_duration_ms)
 *   - 예매 성공률 (goti_ticket_success_rate)
 *
 * 플로우:
 *   회원가입 → 대기열 진입 → Polling 대기 → 통과(토큰 획득)
 *   → 등급조회(X-Queue-Token) → 섹션조회 → 가격조회
 *   → 좌석상태 → Hold → 주문 → 결제
 *
 * 환경변수:
 *   QUEUE_URL   — Queue 서비스 URL (기본: BASE_URL, MSA면 별도 지정)
 *   VUS         — 동시 사용자 수 (기본: 200)
 *   RUNNER_ID   — 러너 ID (0~3)
 *   GAME_ID     — 타겟 경기 ID
 *
 * 실행:
 *   ./run.sh queue-junsang
 *   # 또는 직접
 *   k6 run scenarios/queue-junsang.js \
 *     -e BASE_URL=http://localhost:8080 \
 *     -e QUEUE_URL=http://localhost:8086 \
 *     -e VUS=200 -e RUNNER_ID=0
 */

// --- Think Time ---
function thinkBrowse() { sleep(Math.random() * 2 + 1); }
function thinkSeatSelect() { sleep(Math.random() * 3 + 2); }
function thinkOrderForm() { sleep(Math.random() * 3 + 3); }
function thinkPayment() { sleep(Math.random() * 2 + 2); }

function randomSeatCount() { return Math.floor(Math.random() * 4) + 1; }

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function extractData(res) {
  if (res.status < 200 || res.status >= 300) return null;
  try {
    const body = JSON.parse(res.body);
    return body.data || body;
  } catch {
    return null;
  }
}

// --- K6 Options ---
const vus = parseInt(__ENV.VUS || '200', 10);

export const options = {
  scenarios: {
    // Phase 1: 대기열 동시 진입 스파이크 (오픈 직후 몰리는 상황)
    queue_spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: vus },        // 10초에 걸쳐 전원 진입
        { duration: '3m', target: vus },          // 3분 유지 (대기열 통과 + 예매)
        { duration: '30s', target: 0 },           // 정리
      ],
      gracefulRampDown: '60s',
    },
  },
  thresholds: {
    ...thresholds,
    // 대기열 전용 기준
    queue_validate_ms: ['p(95)<1000'],            // 진입 응답 1초 이내
    queue_status_ms: ['p(95)<500'],               // polling 응답 500ms 이내
    queue_wait_duration_ms: ['p(95)<60000'],       // 95%가 1분 이내 통과
    queue_pass_rate: ['rate>0.90'],                // 90% 이상 통과
    goti_ticket_success_rate: ['rate>0.30'],       // 예매 성공률 (좌석 경합 감안)
  },
};

// --- Setup ---
export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  const queueUrl = __ENV.QUEUE_URL || baseUrl;

  console.log(`=== 대기열 부하테스트: 방식 1 (junsang) ===`);
  console.log(`  API: ${baseUrl}`);
  console.log(`  Queue: ${queueUrl}`);
  console.log(`  VUs: ${vus}`);

  const testData = setupTestData(baseUrl, runnerId, gameId);
  if (!testData) return null;

  return { ...testData, queueUrl };
}

// --- Main ---
export default function (data) {
  if (!data) return;

  const { baseUrl, runnerId } = getEnv();
  const queueUrl = data.queueUrl;
  const vuId = __VU;
  const iterId = __ITER;

  // 1. 회원가입 + JWT
  const uniqueId = runnerId * 1000000 + vuId * 10000 + iterId;
  const authResult = signup(baseUrl, uniqueId, runnerId);
  if (!authResult) {
    metrics.ticketSuccess.add(false);
    return;
  }
  const auth = authHeaders(authResult.token);

  // 2. 대기열 E2E 시작
  const e2eStart = Date.now();

  // 3. 대기열 진입 + Polling 대기
  const queueResult = waitForQueuePass(queueUrl, data.gameId, auth);
  if (!queueResult) {
    metrics.ticketSuccess.add(false);
    sleep(Math.random() * 3 + 2);
    return;
  }

  console.log(
    `  VU${vuId}: 대기열 통과 — ${queueResult.waitMs}ms, polls=${queueResult.polls}`
  );

  // 4. Queue Token이 포함된 인증 헤더 (QueueInterceptor 검증용)
  const queueAuth = queueAuthHeaders(authResult.token, queueResult.token);
  const sectionId = pickRandom(data.sections);

  // 5. 구역 선택 페이지 (seat-grades는 QueueInterceptor 보호 대상)
  browseSeatGrades(baseUrl, data.stadiumId, data.gameId, queueAuth);
  browseSeatSections(baseUrl, data.stadiumId, auth);
  browsePricingPolicy(baseUrl, data.homeTeamId, auth);

  thinkBrowse();

  // 6. 좌석 선택
  const seats = browseSeatStatus(baseUrl, data.gameId, sectionId, auth);
  if (!Array.isArray(seats)) {
    metrics.ticketSuccess.add(false);
    return;
  }
  const available = seats.filter((s) => s.status === 'AVAILABLE');
  if (available.length === 0) {
    metrics.ticketSuccess.add(false);
    return;
  }

  thinkSeatSelect();

  // 7. 좌석 점유 (1~4석)
  const wantCount = randomSeatCount();
  const holdIds = [];
  const shuffled = available.sort(() => Math.random() - 0.5);
  for (let i = 0; i < Math.min(wantCount, shuffled.length); i++) {
    const hid = holdSeat(baseUrl, shuffled[i].seatId, data.gameId, vuId, iterId, auth);
    if (hid) holdIds.push(hid);
  }
  if (holdIds.length === 0) {
    metrics.ticketSuccess.add(false);
    return;
  }

  thinkOrderForm();

  // 8. 주문 생성
  const order = createOrder(baseUrl, data.gameId, holdIds, vuId, auth);
  if (!order) {
    metrics.ticketSuccess.add(false);
    return;
  }

  thinkPayment();

  // 9. 결제
  const payment = payOrder(baseUrl, order.orderId, vuId, auth);
  const success = !!payment;

  // 10. E2E 시간 기록
  queueMetrics.e2eDuration.add(Date.now() - e2eStart);
  metrics.ticketSuccess.add(success);

  if (success) {
    console.log(
      `  VU${vuId}: 예매 완료 — E2E ${Date.now() - e2eStart}ms, ` +
      `대기 ${queueResult.waitMs}ms, 좌석 ${holdIds.length}석`
    );
  }

  sleep(Math.random() * 3 + 2);
}

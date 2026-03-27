import { sleep } from 'k6';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { signup, authHeaders } from '../helpers/auth.js';
import { metrics } from '../helpers/ticketing-actions.js';
import {
  queueMetrics,
  waitForQueuePass,
  queueLeave,
} from '../helpers/queue-actions.js';
import {
  browseSeatGrades,
  browseSeatSections,
  browseSeatStatus,
  holdSeat,
  createOrder,
  payOrder,
} from '../helpers/ticketing-actions.js';

/**
 * 대기열 포화 테스트 — 방식 2 (sungjeon).
 * maxCapacity(100명) 초과 사용자를 밀어넣고,
 * 슬롯 반환(결제 완료 → DELETE /queues/games/{gameId}) → 다음 사용자 입장 메커니즘 검증.
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │ 방식 2 슬롯 반환 메커니즘                                 │
 * │                                                          │
 * │  1. 사용자가 DELETE /queues/games/{gameId} 호출           │
 * │     (또는 Active TTL 600초 만료)                          │
 * │  2. WaitingQueueLeaveEvent 발행                          │
 * │  3. WaitingQueueEventListener.handleUserLeave():         │
 * │     - 분산 락 획득 (queue:lock:game:{gameId})            │
 * │     - currentUsers -1                                    │
 * │     - availableSlots = maxCapacity - currentUsers        │
 * │     - getNthQueueNum(availableSlots) → allowedNum 갱신   │
 * │  4. 대기자가 global-status polling → isAllowed=true 확인  │
 * │  5. seat/enter 호출 → 입장                               │
 * │                                                          │
 * │  Polling 간격: 5초, Heartbeat: 10초                      │
 * └──────────────────────────────────────────────────────────┘
 *
 * 실행:
 *   VUS=300 ./run.sh queue-sungjeon-saturation
 */

const vus = parseInt(__ENV.VUS || '300', 10);

export const options = {
  scenarios: {
    queue_saturation: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: vus },
        { duration: '5m', target: vus },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '120s',
    },
  },
  thresholds: {
    ...thresholds,
    queue_wait_duration_ms: ['p(50)<30000', 'p(95)<120000'],
    queue_pass_rate: ['rate>0.70'],
    goti_ticket_success_rate: ['rate>0.20'],
  },
};

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  const queueUrl = __ENV.QUEUE_URL || baseUrl;
  console.log(`=== 대기열 포화: 방식 2 (sungjeon) — ${vus} VU (수용 100명) ===`);
  const testData = setupTestData(baseUrl, runnerId, gameId);
  if (!testData) return null;
  return { ...testData, queueUrl };
}

export default function (data) {
  if (!data) return;

  const { baseUrl, runnerId } = getEnv();
  const queueUrl = data.queueUrl;
  const uniqueId = runnerId * 1000000 + __VU * 10000 + __ITER;

  const authResult = signup(baseUrl, uniqueId, runnerId);
  if (!authResult) {
    metrics.ticketSuccess.add(false);
    return;
  }
  const auth = authHeaders(authResult.token);

  const e2eStart = Date.now();

  // 대기열 진입 → 통과 (polling 5초, heartbeat 10초)
  const queueResult = waitForQueuePass(queueUrl, data.gameId, auth, 120, 5);
  if (!queueResult) {
    metrics.ticketSuccess.add(false);
    sleep(Math.random() * 3 + 2);
    return;
  }

  // 빠른 예매 (1석만, 슬롯 빠른 반환 목적)
  const sectionId = pickRandom(data.sections);

  browseSeatGrades(baseUrl, data.stadiumId, data.gameId, auth);
  browseSeatSections(baseUrl, data.stadiumId, auth);
  sleep(1);

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

  const seat = available[Math.floor(Math.random() * available.length)];
  const hid = holdSeat(baseUrl, seat.seatId, data.gameId, __VU, __ITER, auth);
  if (!hid) {
    metrics.ticketSuccess.add(false);
    return;
  }

  sleep(1);

  const order = createOrder(baseUrl, data.gameId, [hid], __VU, auth);
  if (!order) {
    metrics.ticketSuccess.add(false);
    return;
  }

  sleep(1);

  const payment = payOrder(baseUrl, order.orderId, __VU, auth);
  const success = !!payment;

  // 결제 완료 → 대기열 이탈 (슬롯 반환)
  if (success) {
    queueLeave(queueUrl, data.gameId, auth);
  }

  queueMetrics.e2eDuration.add(Date.now() - e2eStart);
  metrics.ticketSuccess.add(success);

  if (success) {
    console.log(
      `  VU${__VU}: 포화 예매 완료 — 대기 ${queueResult.waitMs}ms, ` +
      `E2E ${Date.now() - e2eStart}ms`
    );
  }

  sleep(Math.random() * 2 + 1);
}

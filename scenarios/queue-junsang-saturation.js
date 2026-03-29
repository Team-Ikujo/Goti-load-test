import { sleep } from 'k6';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { signup, authHeaders, meshAuthHeaders } from '../helpers/auth.js';
import { metrics } from '../helpers/ticketing-actions.js';
import {
  queueMetrics,
  waitForQueuePass,
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
 * 대기열 포화 테스트 — 방식 1 (junsang).
 * maxCapacity(100명) 초과 사용자를 밀어넣고,
 * 슬롯 반환(예매 완료 후) → 다음 사용자 승격 메커니즘을 검증한다.
 *
 * ┌─────────────────────────────────────────────────────┐
 * │ 방식 1 승격 메커니즘                                  │
 * │                                                     │
 * │  서버 Scheduler (1초 주기):                          │
 * │    1. 현재 PASSED 수 카운트                          │
 * │    2. 빈 슬롯 = 100 - PASSED 수                     │
 * │    3. PENDING에서 빈 슬롯만큼 승격                    │
 * │    4. Heartbeat 없는 유저는 유령으로 제거             │
 * │                                                     │
 * │  Polling 간격: 1초 (Heartbeat 겸용)                  │
 * │  기대: 예매 완료 → PASSED 해제 → 1초 내 다음 승격    │
 * └─────────────────────────────────────────────────────┘
 *
 * 실행:
 *   VUS=300 ./run.sh queue-junsang-saturation
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
  const queueImpl = __ENV.QUEUE_IMPL || '';
  const ticketingBase = queueImpl ? `${baseUrl}/${queueImpl}` : baseUrl;

  console.log(`=== 대기열 포화: 방식 1 (junsang) — ${vus} VU, Impl: ${queueImpl || '(none)'} ===`);
  console.log(`  Ticketing: ${ticketingBase}`);
  const testData = setupTestData(baseUrl, runnerId, gameId);
  if (!testData) return null;
  return { ...testData, queueUrl, ticketingBase };
}

export default function (data) {
  if (!data) return;

  const { baseUrl, runnerId } = getEnv();
  const queueUrl = data.queueUrl;
  const ticketingBase = data.ticketingBase;
  const uniqueId = runnerId * 1000000 + __VU * 10000 + __ITER;

  const authResult = signup(baseUrl, uniqueId, runnerId);
  if (!authResult) { metrics.ticketSuccess.add(false); return; }
  const auth = authHeaders(authResult.token);
  const meshAuth = meshAuthHeaders(authResult.token, authResult.userId);

  const e2eStart = Date.now();

  // 대기열 진입 → 통과 (오래 걸릴 수 있음, polling 1초)
  const queueResult = waitForQueuePass(queueUrl, data.gameId, auth, 300, 1);
  if (!queueResult) { metrics.ticketSuccess.add(false); sleep(3); return; }

  // 빠른 예매 (1석만, 슬롯 빠른 반환 목적)
  // ticketing/payment API는 meshAuth 사용 — X-User-Id 필요
  browseSeatGrades(ticketingBase, data.stadiumId, data.gameId, meshAuth);
  const sections = browseSeatSections(ticketingBase, data.stadiumId, data.gameId, meshAuth);
  sleep(1);

  if (!sections || sections.length === 0) { metrics.ticketSuccess.add(false); return; }
  const sectionId = pickRandom(sections);

  const seats = browseSeatStatus(ticketingBase, data.gameId, sectionId, meshAuth);
  if (!Array.isArray(seats)) { metrics.ticketSuccess.add(false); return; }
  const available = seats.filter((s) => s.status === 'AVAILABLE');
  if (available.length === 0) { metrics.ticketSuccess.add(false); return; }

  const seat = available[Math.floor(Math.random() * available.length)];
  const hid = holdSeat(ticketingBase, seat.seatId, data.gameId, __VU, __ITER, meshAuth);
  if (!hid) { metrics.ticketSuccess.add(false); return; }

  sleep(1);
  const order = createOrder(ticketingBase, data.gameId, [hid], __VU, meshAuth);
  if (!order) { metrics.ticketSuccess.add(false); return; }

  sleep(1);
  const payment = payOrder(ticketingBase, order.orderId, __VU, meshAuth);
  const success = !!payment;

  queueMetrics.e2eDuration.add(Date.now() - e2eStart);
  metrics.ticketSuccess.add(success);

  if (success) {
    console.log(`  VU${__VU}: 포화 예매 — 대기 ${queueResult.waitMs}ms, E2E ${Date.now() - e2eStart}ms`);
  }

  sleep(Math.random() * 2 + 1);
}

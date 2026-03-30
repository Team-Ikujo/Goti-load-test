import { sleep } from 'k6';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { authHeaders } from '../helpers/auth.js';
import { metrics } from '../helpers/ticketing-actions.js';
import {
  queueMetrics, waitForQueuePass, queueLeave,
} from '../helpers/queue-actions.js';
import {
  browseSeatGrades, browseSeatSections, browseSeatStatus,
  holdSeat, createOrder, payOrder,
} from '../helpers/ticketing-actions.js';

/**
 * 대기열 포화 테스트 — 방식 3 (suyeon).
 * maxCapacity 초과 사용자 → 슬롯 반환(leave) → 승격 메커니즘 검증.
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │ 방식 3 승격 메커니즘                                      │
 * │                                                          │
 * │  status API 호출 시 동적 계산:                            │
 * │    availableSlots = maxCapacity - activeCount             │
 * │    publishedRank = max(currentAllowed, lastEntered + avail)│
 * │                                                          │
 * │  leave 호출 시:                                           │
 * │    activeCount -1 → 다음 status에서 publishedRank 증가   │
 * │                                                          │
 * │  Scheduler (30초 주기):                                   │
 * │    Admitted TTL(15분) 만료된 사용자 자동 expire            │
 * │                                                          │
 * │  분산 Lock: 모든 쓰기에 적용 → Lock 경합 측정 포인트     │
 * │  Polling 간격: 2초                                       │
 * └──────────────────────────────────────────────────────────┘
 *
 * 실행: VUS=300 ./run.sh queue-suyeon-saturation
 */

const vus = parseInt(__ENV.VUS || '300', 10);

export const options = {
  setupTimeout: '180s',
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

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  const queueUrl = __ENV.QUEUE_URL || baseUrl;
  const queueImpl = __ENV.QUEUE_IMPL || '(none)';
  console.log(`=== 대기열 포화: 방식 3 (suyeon) — ${vus} VU, Impl: ${queueImpl} ===`);
  const testData = setupTestData(baseUrl, runnerId, gameId);
  if (!testData) return null;
  return { ...testData, queueUrl };
}

export default function (data) {
  if (!data) return;
  const { baseUrl, runnerId } = getEnv();
  const queueUrl = data.queueUrl;

  // setup에서 사전 발급된 토큰 사용 → VU 실행 중 login/signup 호출 제거
  const preToken = data.tokens && data.tokens[__VU];
  if (!preToken) { metrics.ticketSuccess.add(false); sleep(5 + Math.random() * 5); return; }
  const auth = authHeaders(preToken);

  const e2eStart = Date.now();

  const queueResult = waitForQueuePass(queueUrl, data.gameId, auth, 300, 1);
  if (!queueResult) { metrics.ticketSuccess.add(false); sleep(3); return; }

  // 빠른 예매 (1석, 슬롯 빠른 반환)
  browseSeatGrades(baseUrl, data.stadiumId, data.gameId, auth);
  const sections = browseSeatSections(baseUrl, data.stadiumId, data.gameId, auth);
  if (!sections || sections.length === 0) { metrics.ticketSuccess.add(false); return; }
  sleep(1);

  const sectionId = pickRandom(sections);
  const seats = browseSeatStatus(baseUrl, data.gameId, sectionId, auth);
  if (!Array.isArray(seats)) { metrics.ticketSuccess.add(false); return; }
  const available = seats.filter((s) => s.status === 'AVAILABLE');
  if (available.length === 0) { metrics.ticketSuccess.add(false); return; }

  const seat = available[Math.floor(Math.random() * available.length)];
  const hid = holdSeat(baseUrl, seat.seatId, data.gameId, __VU, __ITER, auth);
  if (!hid) { metrics.ticketSuccess.add(false); return; }

  sleep(1);
  const order = createOrder(baseUrl, data.gameId, [hid], __VU, auth);
  if (!order) { metrics.ticketSuccess.add(false); return; }

  sleep(1);
  const payment = payOrder(baseUrl, order.orderId, __VU, auth);
  const success = !!payment;

  if (success) queueLeave(queueUrl, data.gameId, auth);

  queueMetrics.e2eDuration.add(Date.now() - e2eStart);
  metrics.ticketSuccess.add(success);
  sleep(Math.random() * 2 + 1);
}

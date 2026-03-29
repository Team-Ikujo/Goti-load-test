import { sleep } from 'k6';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { signup, meshAuthHeaders } from '../helpers/auth.js';
import { metrics } from '../helpers/ticketing-actions.js';
import {
  queueMetrics,
  waitForQueuePass,
  queueComplete,
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
 * 대기열 원샷 테스트 — 방식 1 (junsang).
 *
 * VU당 1회만 실행. "N명이 동시에 몰렸을 때 M분 내 몇 명이 예매 완료하는가" 측정.
 * 예매 완료 후 슬롯 반환 API를 호출하여 실제 운영 환경과 동일한 순환을 시뮬레이션.
 *
 * 측정 포인트:
 *   - 총 예매 완료 수 (iterations)
 *   - 대기열 대기 시간 분포 (queue_wait_duration_ms)
 *   - 대기열 → 예매 완료 E2E 시간 (queue_e2e_duration_ms)
 *   - 예매 성공률 (goti_ticket_success_rate)
 *   - 대기열 통과율 (queue_pass_rate)
 *
 * 실행:
 *   VUS=300  QUEUE_IMPL=junsang ./run.sh queue-junsang-oneshot
 *   VUS=1000 QUEUE_IMPL=junsang ./run.sh queue-junsang-oneshot
 *   VUS=3000 QUEUE_IMPL=junsang ./run.sh queue-junsang-oneshot
 */

const vus = parseInt(__ENV.VUS || '300', 10);

export const options = {
  scenarios: {
    queue_oneshot: {
      executor: 'per-vu-iterations',
      vus: vus,
      iterations: 1,
      maxDuration: '5m',
    },
  },
  thresholds: {
    ...thresholds,
    queue_wait_duration_ms: ['p(50)<60000', 'p(95)<300000'],
    queue_pass_rate: ['rate>0.80'],
    goti_ticket_success_rate: ['rate>0.50'],
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

  console.log(`=== 대기열 원샷: 방식 1 (junsang) — ${vus} VU × 1회, Impl: ${queueImpl || '(none)'} ===`);
  console.log(`  Ticketing: ${ticketingBase}`);
  console.log(`  Queue: ${queueUrl}`);

  const testData = setupTestData(baseUrl, runnerId, gameId);
  if (!testData) return null;
  return { ...testData, queueUrl, ticketingBase };
}

export default function (data) {
  if (!data) return;

  const { baseUrl, runnerId } = getEnv();
  const queueUrl = data.queueUrl;
  const ticketingBase = data.ticketingBase;

  // 1. 회원가입
  const uniqueId = runnerId * 1000000 + __VU;
  const authResult = signup(baseUrl, uniqueId, runnerId);
  if (!authResult) { metrics.ticketSuccess.add(false); return; }

  const meshAuth = meshAuthHeaders(authResult.token, authResult.userId);

  const e2eStart = Date.now();

  // 2. 대기열 진입 → 통과 (최대 10분 대기)
  const queueResult = waitForQueuePass(queueUrl, data.gameId, meshAuth, 300, 1);
  if (!queueResult) { metrics.ticketSuccess.add(false); return; }

  // 3. 좌석 조회
  browseSeatGrades(ticketingBase, data.stadiumId, data.gameId, meshAuth);
  const sections = browseSeatSections(ticketingBase, data.stadiumId, data.gameId, meshAuth);
  sleep(1);

  if (!sections || sections.length === 0) { metrics.ticketSuccess.add(false); return; }
  const sectionId = pickRandom(sections);

  const seats = browseSeatStatus(ticketingBase, data.gameId, sectionId, meshAuth);
  if (!Array.isArray(seats)) { metrics.ticketSuccess.add(false); return; }
  const available = seats.filter((s) => s.status === 'AVAILABLE');
  if (available.length === 0) { metrics.ticketSuccess.add(false); return; }

  // 4. 좌석 점유 (1석 — 빠른 슬롯 반환)
  const seat = available[Math.floor(Math.random() * available.length)];
  const hid = holdSeat(ticketingBase, seat.seatId, data.gameId, __VU, 0, meshAuth);
  if (!hid) { metrics.ticketSuccess.add(false); return; }

  sleep(1);

  // 5. 주문 생성
  const order = createOrder(ticketingBase, data.gameId, [hid], __VU, meshAuth);
  if (!order) { metrics.ticketSuccess.add(false); return; }

  sleep(1);

  // 6. 결제
  const payment = payOrder(ticketingBase, order.orderId, __VU, meshAuth);
  const success = !!payment;

  // 7. 슬롯 반환 (BookingCompletedEvent 시뮬레이션)
  if (success) {
    queueComplete(queueUrl, data.gameId, meshAuth);
  }

  // 8. 메트릭 기록
  queueMetrics.e2eDuration.add(Date.now() - e2eStart);
  metrics.ticketSuccess.add(success);

  if (success) {
    console.log(
      `  VU${__VU}: 예매 완료 — E2E ${Date.now() - e2eStart}ms, ` +
      `대기 ${queueResult.waitMs}ms, polls=${queueResult.polls}`
    );
  }
}

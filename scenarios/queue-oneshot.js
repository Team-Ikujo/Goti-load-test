import { sleep } from 'k6';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { signup, authHeaders } from '../helpers/auth.js';
import {
  queueMetrics, waitForQueuePass, queueLeave,
} from '../helpers/queue-actions.js';
import {
  metrics, browseSeatGrades, browseSeatSections, browsePricingPolicy,
  browseSeatStatus, holdSeat, createOrder, payOrder,
} from '../helpers/ticketing-actions.js';

/**
 * 대기열 원샷 부하테스트 — 1인 1회 전체 플로우.
 *
 * per-vu-iterations (iterations=1) 실행기를 사용하여 각 VU가 정확히 1회만 실행.
 * 실제 티켓 오픈 시나리오처럼 N명이 동시에 대기열에 진입하여 예매를 완료하는 패턴.
 *
 * 기존 queue-suyeon.js와의 차이:
 *   - queue-suyeon: ramping-vus + 반복 iteration (지속 부하)
 *   - queue-oneshot: per-vu-iterations × 1회 (대규모 동시접속 시뮬레이션)
 *
 * 플로우:
 *   사전 발급 토큰 → enter(JWE) → Polling(2초, status)
 *   → 순번 도달 → seat-enter → 좌석 조회 → 점유 → 주문 → 결제 → leave
 *
 * 분산 실행 (RUNNER_ID 파티셔닝):
 *   RUNNER_ID=0 VUS=5000 ./run.sh queue-oneshot  # 인스턴스 1
 *   RUNNER_ID=1 VUS=5000 ./run.sh queue-oneshot  # 인스턴스 2
 *   → RUNNER_ID별로 유저 mobile이 분리되므로 충돌 없음
 *
 * 실행: ./run.sh queue-oneshot
 */

function thinkBrowse() { sleep(Math.random() * 2 + 1); }
function thinkSeatSelect() { sleep(Math.random() * 3 + 2); }
function thinkOrderForm() { sleep(Math.random() * 3 + 3); }
function thinkPayment() { sleep(Math.random() * 2 + 2); }
function randomSeatCount() { return Math.floor(Math.random() * 4) + 1; }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const vus = parseInt(__ENV.VUS || '5000', 10);

export const options = {
  insecureSkipTLSVerify: true,
  setupTimeout: '600s',
  scenarios: {
    queue_oneshot: {
      executor: 'per-vu-iterations',
      vus: vus,
      iterations: 1,
      maxDuration: '30m',
    },
  },
  thresholds: {
    ...thresholds,
    queue_enter_ms: ['p(95)<3000'],
    queue_status_ms: ['p(95)<1000'],
    queue_seat_enter_ms: ['p(95)<3000'],
    queue_wait_duration_ms: ['p(95)<300000'],
    queue_pass_rate: ['rate>0.85'],
    goti_ticket_success_rate: ['rate>0.30'],
  },
};

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  const queueUrl = __ENV.QUEUE_URL || baseUrl;
  const ticketingUrl = __ENV.TICKETING_URL || baseUrl;
  console.log(`=== 대기열 원샷 부하테스트 ===`);
  console.log(`  API: ${baseUrl}, Queue: ${queueUrl}, Ticketing: ${ticketingUrl}`);
  console.log(`  VUs: ${vus} (각 1회 실행), setupTimeout: 600s`);
  const testData = setupTestData(baseUrl, runnerId, gameId);
  if (!testData) return null;
  return { ...testData, queueUrl, ticketingUrl };
}

export default function (data) {
  if (!data) return;
  const { baseUrl, runnerId } = getEnv();
  const queueUrl = data.queueUrl;
  const tUrl = data.ticketingUrl;

  // 사전 발급 토큰 사용 (setup에서 batch login한 토큰)
  const tokenCount = Object.keys(data.tokens).length;
  const vuNum = ((__VU - 1) % tokenCount) + 1;
  let auth;

  if (data.tokens[vuNum]) {
    auth = authHeaders(data.tokens[vuNum]);
  } else {
    // fallback: 토큰이 없으면 개별 signup
    const uniqueId = runnerId * 1000000 + __VU * 10000;
    const authResult = signup(baseUrl, uniqueId, runnerId);
    if (!authResult) { metrics.ticketSuccess.add(false); return; }
    auth = authHeaders(authResult.token);
  }

  const e2eStart = Date.now();

  // 대기열 진입 → polling(2초) → seat-enter
  const queueResult = waitForQueuePass(queueUrl, data.gameId, auth);
  if (!queueResult) { metrics.ticketSuccess.add(false); return; }

  // 예매 플로우
  browseSeatGrades(tUrl, data.stadiumId, data.gameId, auth);
  const sections = browseSeatSections(tUrl, data.stadiumId, data.gameId, auth);
  browsePricingPolicy(tUrl, data.homeTeamId, auth);
  thinkBrowse();

  if (!sections || sections.length === 0) { metrics.ticketSuccess.add(false); return; }
  const sectionId = pickRandom(sections);
  const seats = browseSeatStatus(tUrl, data.gameId, sectionId, auth);
  if (!Array.isArray(seats)) { metrics.ticketSuccess.add(false); return; }
  const available = seats.filter((s) => s.status === 'AVAILABLE');
  if (available.length === 0) { metrics.ticketSuccess.add(false); return; }

  thinkSeatSelect();

  const wantCount = randomSeatCount();
  const holdIds = [];
  const shuffled = available.sort(() => Math.random() - 0.5);
  for (let i = 0; i < Math.min(wantCount, shuffled.length); i++) {
    const hid = holdSeat(tUrl, shuffled[i].seatId, data.gameId, __VU, __ITER, auth);
    if (hid) holdIds.push(hid);
  }
  if (holdIds.length === 0) { metrics.ticketSuccess.add(false); return; }

  thinkOrderForm();
  const order = createOrder(tUrl, data.gameId, holdIds, __VU, auth);
  if (!order) { metrics.ticketSuccess.add(false); return; }

  thinkPayment();
  const payment = payOrder(tUrl, order.orderId, __VU, auth);
  const success = !!payment;

  if (success) queueLeave(queueUrl, data.gameId, auth);

  queueMetrics.e2eDuration.add(Date.now() - e2eStart);
  metrics.ticketSuccess.add(success);
}

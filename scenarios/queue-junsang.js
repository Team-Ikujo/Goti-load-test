import { sleep } from 'k6';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { signup, authHeaders } from '../helpers/auth.js';
import {
  queueMetrics, waitForQueuePass, queueComplete,
} from '../helpers/queue-actions.js';
import {
  metrics, browseSeatGrades, browseSeatSections, browsePricingPolicy,
  browseSeatStatus, holdSeat, createOrder, payOrder,
} from '../helpers/ticketing-actions.js';

/**
 * 대기열 부하테스트 — 구현 방식 1 (junsang): Redis Sorted Set + Scheduler.
 *
 * 플로우:
 *   [setup] 회원가입 일괄 발급 (VU 수만큼)
 *   [VU] validate(대기열 진입) → Polling(1초, status)
 *   → 순번 도달 → 예매 → complete(슬롯 반환)
 *
 * 실행: ./run.sh queue-junsang
 */

function thinkBrowse() { sleep(Math.random() * 2 + 1); }
function thinkSeatSelect() { sleep(Math.random() * 3 + 2); }
function thinkOrderForm() { sleep(Math.random() * 3 + 3); }
function thinkPayment() { sleep(Math.random() * 2 + 2); }
function randomSeatCount() { return Math.floor(Math.random() * 4) + 1; }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const vus = parseInt(__ENV.VUS || '200', 10);
const isSmoke = vus <= 5;

export const options = {
  setupTimeout: '300s',
  insecureSkipTLSVerify: true,
  scenarios: {
    queue_spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: isSmoke
        ? [
            { duration: '2s', target: vus },
            { duration: '30s', target: vus },
            { duration: '3s', target: 0 },
          ]
        : [
            { duration: '10s', target: vus },
            { duration: '3m', target: vus },
            { duration: '30s', target: 0 },
          ],
      gracefulRampDown: isSmoke ? '10s' : '60s',
    },
  },
  thresholds: {
    ...thresholds,
    queue_validate_ms: ['p(95)<1000'],
    queue_status_ms: ['p(95)<500'],
    queue_wait_duration_ms: ['p(95)<60000'],
    queue_pass_rate: ['rate>0.90'],
    goti_ticket_success_rate: ['rate>0.30'],
  },
};

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  const queueUrl = __ENV.QUEUE_URL || baseUrl;
  const queueImpl = __ENV.QUEUE_IMPL || '(none)';
  const ticketingUrl = `${baseUrl}/junsang`;
  console.log(`=== 대기열 부하테스트: 방식 1 (junsang) ===`);
  console.log(`  API: ${baseUrl}, Queue: ${queueUrl}, Ticketing: ${ticketingUrl}, Impl: ${queueImpl}, VUs: ${vus}`);
  const testData = setupTestData(baseUrl, runnerId, gameId);
  if (!testData) return null;

  // VU 토큰 일괄 발급
  const tokens = [];
  const totalUsers = vus;
  console.log(`  토큰 일괄 발급 시작: ${totalUsers}명`);

  for (let i = 0; i < totalUsers; i++) {
    const uniqueId = runnerId * 1000000 + i + 1;
    const result = signup(baseUrl, uniqueId, runnerId);
    if (result) {
      tokens.push({ token: result.token, userId: result.userId });
    }
    if ((i + 1) % 100 === 0) {
      console.log(`  토큰 발급: ${i + 1}/${totalUsers} (성공: ${tokens.length})`);
    }
  }

  console.log(`  토큰 발급 완료: ${tokens.length}/${totalUsers}`);
  if (tokens.length === 0) {
    console.error('  토큰 발급 전부 실패 — 테스트 중단');
    return null;
  }

  return { ...testData, queueUrl, ticketingUrl, tokens };
}

export default function (data) {
  if (!data || !data.tokens || data.tokens.length === 0) return;

  const queueUrl = data.queueUrl;
  const tUrl = data.ticketingUrl;

  // VU별로 고유 토큰 할당
  const tokenIdx = (__VU - 1) % data.tokens.length;
  const { token } = data.tokens[tokenIdx];
  const auth = authHeaders(token);

  const e2eStart = Date.now();

  // 대기열 진입 → polling(1초) → 통과
  const queueResult = waitForQueuePass(queueUrl, data.gameId, auth);
  if (!queueResult) { metrics.ticketSuccess.add(false); sleep(3); return; }

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

  if (success) queueComplete(queueUrl, data.gameId, auth);

  queueMetrics.e2eDuration.add(Date.now() - e2eStart);
  metrics.ticketSuccess.add(success);
  sleep(Math.random() * 3 + 2);
}

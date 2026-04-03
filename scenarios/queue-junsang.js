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
 * PR: https://github.com/Team-Ikujo/Goti-server/pull/312
 * 브랜치: poc/queue-waiting-junsang
 *
 * 플로우:
 *   회원가입 → validate(대기열 진입) → Polling(1초, status)
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
  setupTimeout: '180s',
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
            { duration: '30s', target: vus },
            { duration: '9m', target: vus },
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
  // ticketing-junsang은 /junsang prefix로 라우팅 (deploy/prod와 API 경로가 다름)
  const ticketingUrl = `https://api.go-ti.shop/junsang`;
  console.log(`=== 대기열 부하테스트: 방식 1 (junsang) ===`);
  console.log(`  API: ${baseUrl}, Queue: ${queueUrl}, Ticketing: ${ticketingUrl}, Impl: ${queueImpl}, VUs: ${vus}`);
  const testData = setupTestData(baseUrl, runnerId, gameId);
  if (!testData) return null;
  return { ...testData, queueUrl, ticketingUrl };
}

export default function (data) {
  if (!data) return;
  const { baseUrl, runnerId } = getEnv();
  const queueUrl = data.queueUrl;
  const tUrl = data.ticketingUrl; // ticketing-junsang (/junsang prefix)
  const uniqueId = runnerId * 1000000 + __VU * 10000 + __ITER;

  const authResult = signup(baseUrl, uniqueId, runnerId);
  if (!authResult) { metrics.ticketSuccess.add(false); return; }
  const auth = authHeaders(authResult.token);

  const e2eStart = Date.now();

  // 대기열 진입 → polling(1초) → 통과
  const queueResult = waitForQueuePass(queueUrl, data.gameId, auth);
  if (!queueResult) { metrics.ticketSuccess.add(false); sleep(3); return; }

  // 예매 플로우: ticketing-junsang으로 라우팅 (/junsang prefix)
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

  // 예매 완료 후 대기열 슬롯 반환
  if (success) queueComplete(queueUrl, data.gameId, auth);

  queueMetrics.e2eDuration.add(Date.now() - e2eStart);
  metrics.ticketSuccess.add(success);
  sleep(Math.random() * 3 + 2);
}

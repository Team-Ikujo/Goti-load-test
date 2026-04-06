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
 * 대기열 부하테스트 — 구현 방식 3 (suyeon): JWE 토큰 + 분산 Lock + Scheduler 만료.
 *
 * PR: https://github.com/Team-Ikujo/Goti-server/pull/309
 * 브랜치: poc/queue-waiting-suyeon
 *
 * 플로우:
 *   회원가입 → enter(JWE 토큰) → Polling(2초, status)
 *   → 순번 도달 → seat-enter(토큰 검증) → 예매 → leave
 *
 * 실행: ./run.sh queue-suyeon
 */

function thinkBrowse() { sleep(Math.random() * 2 + 1); }
function thinkSeatSelect() { sleep(Math.random() * 3 + 2); }
function thinkOrderForm() { sleep(Math.random() * 3 + 3); }
function thinkPayment() { sleep(Math.random() * 2 + 2); }
function randomSeatCount() { return Math.floor(Math.random() * 4) + 1; }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const vus = parseInt(__ENV.VUS || '200', 10);
const duration = __ENV.DURATION || '10m';
const isSmoke = vus <= 5;

// duration 파싱 (예: '3m' → 180, '1h' → 3600)
function parseDuration(d) {
  const m = d.match(/^(\d+)(s|m|h)$/);
  if (!m) return 600;
  const v = parseInt(m[1], 10);
  return m[2] === 'h' ? v * 3600 : m[2] === 'm' ? v * 60 : v;
}
const totalSec = parseDuration(duration);
const rampSec = Math.min(30, Math.floor(totalSec * 0.1));
const sustainSec = totalSec - rampSec * 2;

export const options = {
  insecureSkipTLSVerify: true,
  setupTimeout: '180s',
  scenarios: {
    queue_e2e: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: isSmoke
        ? [
            { duration: '2s', target: vus },
            { duration: '30s', target: vus },
            { duration: '3s', target: 0 },
          ]
        : [
            { duration: `${rampSec}s`, target: vus },
            { duration: `${sustainSec}s`, target: vus },
            { duration: `${rampSec}s`, target: 0 },
          ],
      gracefulRampDown: isSmoke ? '10s' : '60s',
    },
  },
  thresholds: {
    ...thresholds,
    queue_enter_ms: ['p(95)<1000'],
    queue_status_ms: ['p(95)<500'],
    queue_seat_enter_ms: ['p(95)<1000'],
    queue_wait_duration_ms: ['p(95)<60000'],
    queue_pass_rate: ['rate>0.90'],
    goti_ticket_success_rate: ['rate>0.30'],
  },
};

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  const queueUrl = __ENV.QUEUE_URL || baseUrl;
  const ticketingUrl = __ENV.TICKETING_URL || baseUrl;
  console.log(`=== 대기열 부하테스트 ===`);
  console.log(`  API: ${baseUrl}, Queue: ${queueUrl}, Ticketing: ${ticketingUrl}, VUs: ${vus}`);
  const testData = setupTestData(baseUrl, runnerId, gameId);
  if (!testData) return null;
  return { ...testData, queueUrl, ticketingUrl };
}

export default function (data) {
  if (!data) return;
  const { baseUrl, runnerId } = getEnv();
  const queueUrl = data.queueUrl;
  const tUrl = data.ticketingUrl; // ticketing-suyeon (/suyeon prefix)
  const uniqueId = runnerId * 1000000 + __VU * 10000 + __ITER;

  const authResult = signup(baseUrl, uniqueId, runnerId);
  if (!authResult) { metrics.ticketSuccess.add(false); return; }
  const auth = authHeaders(authResult.token);

  const e2eStart = Date.now();

  // 대기열 진입 → polling(2초) → seat-enter
  const queueResult = waitForQueuePass(queueUrl, data.gameId, auth);
  if (!queueResult) { metrics.ticketSuccess.add(false); sleep(3); return; }

  // 예매 플로우: ticketing-suyeon으로 라우팅 (/suyeon prefix)
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
  sleep(Math.random() * 3 + 2);
}

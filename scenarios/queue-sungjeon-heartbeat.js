import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { signup, authHeaders } from '../helpers/auth.js';
import {
  queueMetrics,
  queueEnter,
  queueGlobalStatus,
  queueHeartbeatWaiting,
} from '../helpers/queue-actions.js';

/**
 * 대기열 Heartbeat 스트레스 테스트 — 방식 2 (sungjeon).
 * 대량 사용자가 대기 상태에서 지속적으로 polling + heartbeat하는 상황.
 * 예매 진행 없이 대기만 → Redis 부하 집중 측정.
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │ 방식 2 Heartbeat 사양                                     │
 * │                                                          │
 * │  Polling API:   GET /queues/global-status?secureToken    │
 * │  Polling 간격:  5초                                       │
 * │                                                          │
 * │  Heartbeat API: POST /queues/heartbeat/waiting           │
 * │  Heartbeat 간격: 10초                                     │
 * │  Heartbeat TTL:  30초 (갱신 안 하면 유령 판정 → 제거)     │
 * │                                                          │
 * │  ⚠️  방식 1과의 차이:                                     │
 * │    방식 1: polling = heartbeat (1 API로 겸용)             │
 * │    방식 2: polling ≠ heartbeat (2 API 별도 호출)          │
 * │                                                          │
 * │  Redis 부하 계산 (500 VU 기준):                           │
 * │    Polling:   500 × (1회/5초) = 100 req/s                │
 * │    Heartbeat: 500 × (1회/10초) = 50 req/s                │
 * │    합계:      150 req/s                                   │
 * │    vs 방식 1: 500 × (1회/1초) = 500 req/s                │
 * └──────────────────────────────────────────────────────────┘
 *
 * 실행:
 *   VUS=500 ./run.sh queue-sungjeon-heartbeat
 */

const vus = parseInt(__ENV.VUS || '500', 10);
const testDuration = __ENV.DURATION || '3m';

// Heartbeat 전용 메트릭
const heartbeatOk = new Counter('queue_heartbeat_ok');
const heartbeatFail = new Counter('queue_heartbeat_fail');
const pollingOk = new Counter('queue_polling_ok');
const pollingFail = new Counter('queue_polling_fail');

export const options = {
  scenarios: {
    heartbeat_stress: {
      executor: 'constant-vus',
      vus: vus,
      duration: testDuration,
    },
  },
  thresholds: {
    ...thresholds,
    queue_status_ms: ['p(95)<500', 'p(99)<1000'],
    queue_heartbeat_ms: ['p(95)<500', 'p(99)<1000'],
  },
};

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  const queueUrl = __ENV.QUEUE_URL || baseUrl;
  console.log(`=== Heartbeat 스트레스: 방식 2 (sungjeon) — ${vus} VU, ${testDuration} ===`);
  console.log(`  예상 Redis 부하: ${Math.round(vus / 5)} polling/s + ${Math.round(vus / 10)} heartbeat/s = ${Math.round(vus / 5 + vus / 10)} req/s`);

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
  if (!authResult) return;
  const auth = authHeaders(authResult.token);

  // 대기열 진입
  const enterResult = queueEnter(queueUrl, data.gameId, auth);
  if (!enterResult) return;

  const { secureToken } = enterResult;

  // 60초 동안 polling(5초) + heartbeat(10초)
  // = 12회 polling + 6회 heartbeat
  for (let sec = 0; sec < 60; sec += 5) {
    // Polling (5초마다)
    const status = queueGlobalStatus(queueUrl, secureToken, auth);
    if (status) {
      pollingOk.add(1);
    } else {
      pollingFail.add(1);
    }

    // Heartbeat (10초마다 — 짝수 cycle)
    if (sec % 10 === 0) {
      const hbOk = queueHeartbeatWaiting(queueUrl, data.gameId, auth);
      if (hbOk) {
        heartbeatOk.add(1);
      } else {
        heartbeatFail.add(1);
      }
    }

    sleep(5); // 5초 간격 — 방식 2 polling 주기
  }
}

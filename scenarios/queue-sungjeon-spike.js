import { sleep } from 'k6';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { signup, authHeaders } from '../helpers/auth.js';
import {
  queueMetrics,
  waitForQueuePass,
} from '../helpers/queue-actions.js';

/**
 * 대기열 전용 스파이크 테스트 — 방식 2 (sungjeon).
 * 예매 플로우 없이 대기열 진입 + Polling + Heartbeat만 수행.
 * 대기열 자체의 처리량과 응답시간을 측정한다.
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │ 방식 2 Polling/Heartbeat 사양                             │
 * │                                                          │
 * │  진입:      POST /api/v1/queues/enter                    │
 * │  Polling:   GET /api/v1/queues/global-status?secureToken │
 * │  간격:      5초                                           │
 * │  Heartbeat: POST /api/v1/queues/heartbeat/waiting        │
 * │  간격:      10초 (TTL 30초이므로 3배 여유)                │
 * │  좌석진입:  POST /api/v1/queues/seat/enter?secureToken   │
 * │  승격:      이벤트 기반 (사용자 이탈 시 슬롯 반환)        │
 * │  수용:      maxCapacity (기본 100명)                      │
 * │                                                          │
 * │  Redis 부하 계산:                                         │
 * │    500 VU × (1회/5초 polling + 1회/10초 heartbeat)       │
 * │    = 100 req/s (polling) + 50 req/s (heartbeat)          │
 * │    = 150 req/s                                           │
 * └──────────────────────────────────────────────────────────┘
 *
 * 실행:
 *   ./run.sh queue-sungjeon-spike
 *   VUS=500 ./run.sh queue-sungjeon-spike
 */

const vus = parseInt(__ENV.VUS || '500', 10);

export const options = {
  scenarios: {
    queue_spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5s', target: vus },
        { duration: '2m', target: vus },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    ...thresholds,
    queue_enter_ms: ['p(95)<2000'],
    queue_status_ms: ['p(95)<1000'],
    queue_heartbeat_ms: ['p(95)<500'],
    queue_pass_rate: ['rate>0.80'],
  },
};

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  const queueUrl = __ENV.QUEUE_URL || baseUrl;
  console.log(`=== 대기열 스파이크: 방식 2 (sungjeon) — ${vus} VU ===`);
  console.log(`  Queue: ${queueUrl}`);

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

  // 대기열 진입 → polling(5초) + heartbeat(10초) → 통과까지만 (예매 X)
  const result = waitForQueuePass(queueUrl, data.gameId, auth, 60, 5);

  if (result) {
    console.log(`  VU${__VU}: 통과 ${result.waitMs}ms, polls=${result.polls}`);
  }

  sleep(Math.random() * 2 + 1);
}

import { sleep } from 'k6';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { signup, authHeaders } from '../helpers/auth.js';
import {
  queueMetrics,
  waitForQueuePass,
} from '../helpers/queue-actions.js';

/**
 * 대기열 전용 스파이크 테스트 — 방식 1 (junsang).
 * 예매 플로우 없이 대기열 진입 + Polling만 수행.
 * 대기열 자체의 처리량과 응답시간을 측정한다.
 *
 * ┌─────────────────────────────────────────────────────┐
 * │ 방식 1 Polling 사양                                  │
 * │                                                     │
 * │  진입:     POST /api/v1/queue/validate              │
 * │  Polling:  GET /api/v1/queue/status/games/{gameId}  │
 * │  간격:     1초 (서버 Scheduler도 1초 주기)            │
 * │  Heartbeat: polling이 겸함 (별도 API 없음)           │
 * │  TTL:      30초 (QUEUE_ACTIVE), 1시간 (Token)       │
 * │  승격:     서버 Scheduler 자동 (1초마다 빈 슬롯 채움)  │
 * │  수용:     MAX_ALLOWED_COUNT = 100명                 │
 * │                                                     │
 * │  Redis 부하 = VU 수 × 1 req/s (polling)             │
 * │  500 VU = 500 req/s                                 │
 * └─────────────────────────────────────────────────────┘
 *
 * 실행:
 *   ./run.sh queue-junsang-spike
 *   VUS=500 ./run.sh queue-junsang-spike
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
    queue_validate_ms: ['p(95)<2000'],
    queue_status_ms: ['p(95)<1000'],
    queue_pass_rate: ['rate>0.80'],
  },
};

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  const queueUrl = __ENV.QUEUE_URL || baseUrl;
  const queueImpl = __ENV.QUEUE_IMPL || '(none)';
  console.log(`=== 대기열 스파이크: 방식 1 (junsang) — ${vus} VU, Impl: ${queueImpl} ===`);
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

  // 대기열 진입 → polling(1초) → 통과까지만 (예매 X)
  const result = waitForQueuePass(queueUrl, data.gameId, auth, 120, 1);

  if (result) {
    console.log(`  VU${__VU}: 통과 ${result.waitMs}ms, polls=${result.polls}`);
  }

  sleep(Math.random() * 2 + 1);
}

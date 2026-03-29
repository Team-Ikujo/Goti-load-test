import { sleep } from 'k6';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { signup, authHeaders } from '../helpers/auth.js';
import { queueMetrics, waitForQueuePass } from '../helpers/queue-actions.js';

/**
 * 대기열 전용 스파이크 테스트 — 방식 3 (suyeon).
 * 예매 없이 대기열 진입 + Polling만. 대기열 자체 처리량 측정.
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │ 방식 3 Polling 사양                                      │
 * │                                                          │
 * │  진입:     POST /api/v1/queue/enter                      │
 * │  Polling:  GET /api/v1/queue/{gameId}/status              │
 * │  간격:     2초                                            │
 * │  Heartbeat: 없음 (Entry TTL 10분으로 유지)                │
 * │  승격:     status 호출 시 publishedRank 동적 계산         │
 * │  분산Lock: enter/seat-enter/leave에 적용                  │
 * │  수용:     maxCapacity = 5000명 (기본값)                  │
 * │                                                          │
 * │  Redis 부하 = VU / 2 req/s (2초 간격 polling)            │
 * │  500 VU = 250 req/s                                      │
 * └──────────────────────────────────────────────────────────┘
 *
 * 실행: VUS=500 ./run.sh queue-suyeon-spike
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
    queue_pass_rate: ['rate>0.80'],
  },
};

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  const queueUrl = __ENV.QUEUE_URL || baseUrl;
  const queueImpl = __ENV.QUEUE_IMPL || '(none)';
  console.log(`=== 대기열 스파이크: 방식 3 (suyeon) — ${vus} VU, Impl: ${queueImpl} ===`);
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

  // 대기열 진입 → polling(2초) → 통과까지만 (예매 X)
  const result = waitForQueuePass(queueUrl, data.gameId, auth, 150, 2);
  if (result) {
    console.log(`  VU${__VU}: 통과 ${result.waitMs}ms, polls=${result.polls}`);
  }
  sleep(Math.random() * 2 + 1);
}

import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { signup, authHeaders } from '../helpers/auth.js';
import { queueMetrics, queueEnter, queueStatus } from '../helpers/queue-actions.js';

/**
 * 대기열 Polling 스트레스 테스트 — 방식 3 (suyeon).
 * 대량 사용자가 대기 상태에서 지속적으로 polling하는 상황.
 * (방식 3은 별도 Heartbeat 없음 — polling만으로 Redis 부하 측정)
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │ 방식 3 Polling 사양 (Heartbeat 없음)                     │
 * │                                                          │
 * │  Polling API:   GET /queue/{gameId}/status                │
 * │  Polling 간격:  2초                                       │
 * │  Heartbeat:     없음 (Entry TTL 10분으로 유지)            │
 * │                                                          │
 * │  ⚠️  방식별 부하 비교 (500 VU 기준):                      │
 * │    방식 1: 500 req/s (1초 polling = heartbeat)            │
 * │    방식 2: 150 req/s (5초 polling + 10초 heartbeat)       │
 * │    방식 3: 250 req/s (2초 polling, heartbeat 없음)        │
 * │                                                          │
 * │  방식 3 특이점:                                           │
 * │    - status에서 publishedRank 동적 계산 (읽기인데 쓰기)   │
 * │    - 분산 Lock은 status에는 미적용 (읽기 전용)            │
 * └──────────────────────────────────────────────────────────┘
 *
 * 실행: VUS=500 ./run.sh queue-suyeon-heartbeat
 */

const vus = parseInt(__ENV.VUS || '500', 10);
const testDuration = __ENV.DURATION || '3m';

const pollingOk = new Counter('queue_polling_ok');
const pollingFail = new Counter('queue_polling_fail');
const pollingRt = new Trend('queue_polling_rt_ms', true);

export const options = {
  scenarios: {
    polling_stress: {
      executor: 'constant-vus',
      vus: vus,
      duration: testDuration,
    },
  },
  thresholds: {
    ...thresholds,
    queue_status_ms: ['p(95)<500', 'p(99)<1000'],
    queue_polling_rt_ms: ['p(95)<500'],
  },
};

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  const queueUrl = __ENV.QUEUE_URL || baseUrl;
  const queueImpl = __ENV.QUEUE_IMPL || '(none)';
  console.log(`=== Polling 스트레스: 방식 3 (suyeon) — ${vus} VU, ${testDuration}, Impl: ${queueImpl} ===`);
  console.log(`  예상 Redis 부하: ${Math.round(vus / 2)} req/s (2초 간격 polling)`);
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

  // 30초 동안 2초 간격으로 polling (= 15회)
  for (let i = 0; i < 15; i++) {
    const start = Date.now();
    const status = queueStatus(queueUrl, data.gameId, auth);
    const rt = Date.now() - start;
    pollingRt.add(rt);

    if (status) {
      pollingOk.add(1);
    } else {
      pollingFail.add(1);
    }

    sleep(2); // 2초 간격 — 방식 3 polling 주기
  }
}

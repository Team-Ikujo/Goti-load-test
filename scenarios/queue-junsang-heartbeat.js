import { sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { signup, authHeaders } from '../helpers/auth.js';
import {
  queueMetrics,
  queueValidate,
  queueStatus,
} from '../helpers/queue-actions.js';

/**
 * 대기열 Heartbeat 스트레스 테스트 — 방식 1 (junsang).
 * 대량 사용자가 대기 상태에서 지속적으로 polling하는 상황.
 * 예매 진행 없이 대기만 → Redis 부하 집중 측정.
 *
 * ┌─────────────────────────────────────────────────────┐
 * │ 방식 1 Heartbeat 사양                                │
 * │                                                     │
 * │  별도 Heartbeat API: 없음                            │
 * │  Heartbeat 방식: status polling이 겸함               │
 * │    → GET /queue/status/games/{gameId} 호출 시        │
 * │      QUEUE_ACTIVE:{gameId}:{memberId} TTL 갱신      │
 * │                                                     │
 * │  Polling 간격: 1초                                   │
 * │  ACTIVE TTL: 30초 (polling 안 하면 유령 판정)        │
 * │  Token TTL: 1시간                                   │
 * │                                                     │
 * │  Redis 부하 = VU 수 × 1 req/s (polling = heartbeat) │
 * │  500 VU = 500 req/s                                 │
 * │  vs 방식 2: 500 × (1/5 + 1/10) = 150 req/s         │
 * └─────────────────────────────────────────────────────┘
 *
 * 실행:
 *   VUS=500 ./run.sh queue-junsang-heartbeat
 */

const vus = parseInt(__ENV.VUS || '500', 10);
const testDuration = __ENV.DURATION || '3m';

const heartbeatOk = new Counter('queue_heartbeat_ok');
const heartbeatFail = new Counter('queue_heartbeat_fail');
const heartbeatRt = new Trend('queue_heartbeat_rt_ms', true);

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
    queue_heartbeat_rt_ms: ['p(95)<500'],
  },
};

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  const queueUrl = __ENV.QUEUE_URL || baseUrl;
  console.log(`=== Heartbeat 스트레스: 방식 1 (junsang) — ${vus} VU, ${testDuration} ===`);
  console.log(`  예상 Redis 부하: ${vus} req/s (polling = heartbeat)`);

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
  const validateResult = queueValidate(queueUrl, data.gameId, auth);
  if (!validateResult) return;

  // 30초 동안 1초 간격으로 polling (= heartbeat)
  for (let i = 0; i < 30; i++) {
    const start = Date.now();
    const status = queueStatus(queueUrl, data.gameId, auth);
    const rt = Date.now() - start;
    heartbeatRt.add(rt);

    if (status) {
      heartbeatOk.add(1);
    } else {
      heartbeatFail.add(1);
    }

    sleep(1); // 1초 간격 — 방식 1 polling 주기
  }
}

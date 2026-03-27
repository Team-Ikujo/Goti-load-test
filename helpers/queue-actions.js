import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { get, post } from './http-client.js';

/**
 * 대기열 액션 모듈 — PR #312 (구현 방식 1: Redis Sorted Set + Scheduler).
 *
 * Queue 서비스 API:
 *   POST /api/v1/queue/validate           — 대기열 진입 (토큰 발급 또는 대기)
 *   GET  /api/v1/queue/status/games/{id}  — 대기 상태 조회 (Polling + Heartbeat)
 *
 * 승격 메커니즘:
 *   - 서버 Scheduler 1초 주기로 빈 슬롯만큼 PENDING → PASSED 승격
 *   - 최대 동시 수용: 100명 (MAX_ALLOWED_COUNT)
 *   - Heartbeat TTL: 30초 (polling이 heartbeat 역할)
 *   - Token TTL: 1시간
 *
 * 예매 API 보호:
 *   - QueueInterceptor가 X-Queue-Token 헤더 검증
 *   - 보호 대상: /api/v1/stadium-seats/stadiums/{}/games/{}/seat-grades
 */

// --- 커스텀 메트릭 (대기열 전용) ---
export const queueMetrics = {
  // 대기열 진입 응답 시간
  validateLatency: new Trend('queue_validate_ms', true),
  // 상태 조회(polling) 응답 시간
  statusLatency: new Trend('queue_status_ms', true),
  // 대기열 진입 → 통과까지 총 대기 시간
  waitDuration: new Trend('queue_wait_duration_ms', true),
  // 통과까지 필요한 polling 횟수
  pollCount: new Trend('queue_poll_count'),
  // 즉시 통과 비율 (대기 없이 바로 입장)
  immediatePassRate: new Rate('queue_immediate_pass_rate'),
  // 대기열 통과 성공률
  passRate: new Rate('queue_pass_rate'),
  // 대기열 타임아웃 (polling 제한 초과)
  timeoutCount: new Counter('queue_timeouts'),
  // 대기열 진입 → 예매 완료 E2E 시간
  e2eDuration: new Trend('queue_e2e_duration_ms', true),
};

// --- 헬퍼 ---
function extractData(res) {
  if (res.status < 200 || res.status >= 300) return null;
  try {
    const body = JSON.parse(res.body);
    return body.data || body;
  } catch {
    return null;
  }
}

/**
 * 대기열 진입.
 *
 * @param {string} queueUrl  Queue 서비스 base URL (예: http://localhost:8086)
 * @param {string} gameId    대상 경기 ID
 * @param {object} auth      인증 헤더 ({ headers: { Authorization: 'Bearer ...' } })
 * @returns {{ isPassed: boolean, rank: number, token: string|null } | null}
 */
export function queueValidate(queueUrl, gameId, auth) {
  const start = Date.now();
  const res = post(
    `${queueUrl}/api/v1/queue/validate`,
    { gameId },
    { ...auth, tags: { name: 'POST /queue/validate' } }
  );
  queueMetrics.validateLatency.add(Date.now() - start);

  return extractData(res);
}

/**
 * 대기 상태 조회 (Polling + Heartbeat 갱신).
 *
 * @returns {{ isPassed: boolean, rank: number, token: string|null } | null}
 */
export function queueStatus(queueUrl, gameId, auth) {
  const start = Date.now();
  const res = get(
    `${queueUrl}/api/v1/queue/status/games/${gameId}`,
    { ...auth, tags: { name: 'GET /queue/status' } }
  );
  queueMetrics.statusLatency.add(Date.now() - start);

  return extractData(res);
}

/**
 * 대기열 진입 → 통과까지 대기 (Polling Loop).
 *
 * 1. validate로 진입
 * 2. isPassed=false면 1초 간격으로 status polling
 * 3. isPassed=true가 되면 token 반환
 * 4. maxPolls 초과 시 타임아웃
 *
 * @param {string} queueUrl     Queue 서비스 base URL
 * @param {string} gameId       대상 경기 ID
 * @param {object} auth         인증 헤더
 * @param {number} [maxPolls=120] 최대 polling 횟수 (120 = 약 2분)
 * @param {number} [pollInterval=1] polling 간격 (초)
 * @returns {{ token: string, waitMs: number, polls: number } | null}
 */
export function waitForQueuePass(queueUrl, gameId, auth, maxPolls = 120, pollInterval = 1) {
  const waitStart = Date.now();

  // Step 1: 대기열 진입
  const validateResult = queueValidate(queueUrl, gameId, auth);
  if (!validateResult) return null;

  // 즉시 통과
  if (validateResult.isPassed) {
    const waitMs = Date.now() - waitStart;
    queueMetrics.immediatePassRate.add(true);
    queueMetrics.passRate.add(true);
    queueMetrics.waitDuration.add(waitMs);
    queueMetrics.pollCount.add(0);
    return { token: validateResult.token, waitMs, polls: 0 };
  }

  queueMetrics.immediatePassRate.add(false);

  // Step 2: Polling 대기
  let polls = 0;
  while (polls < maxPolls) {
    sleep(pollInterval);
    polls++;

    const status = queueStatus(queueUrl, gameId, auth);
    if (!status) continue;

    if (status.isPassed) {
      const waitMs = Date.now() - waitStart;
      queueMetrics.passRate.add(true);
      queueMetrics.waitDuration.add(waitMs);
      queueMetrics.pollCount.add(polls);
      return { token: status.token, waitMs, polls };
    }

    // 10회마다 진행 상황 로그
    if (polls % 10 === 0) {
      console.log(`  queue: polling ${polls}/${maxPolls}, rank=${status.rank}`);
    }
  }

  // 타임아웃
  queueMetrics.passRate.add(false);
  queueMetrics.timeoutCount.add(1);
  queueMetrics.waitDuration.add(Date.now() - waitStart);
  queueMetrics.pollCount.add(polls);
  console.warn(`  queue: 타임아웃 (${maxPolls}회 polling 후에도 미통과)`);
  return null;
}

/**
 * Queue Token을 포함한 인증 헤더 생성.
 * QueueInterceptor가 X-Queue-Token 헤더를 검증한다.
 */
export function queueAuthHeaders(token, queueToken) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Queue-Token': queueToken,
    },
  };
}

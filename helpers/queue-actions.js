import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { get, post } from './http-client.js';

/**
 * 대기열 액션 모듈 — PR #309 (구현 방식 3: suyeon).
 *
 * Queue 서비스 API (QUEUE_IMPL prefix 자동 삽입):
 *   POST /api/v1/queue/{impl}/enter             — 대기열 진입 (JWE 토큰 발급)
 *   GET  /api/v1/queue/{impl}/{gameId}/global-status — 대기 상태 조회 (CDN 캐싱, Polling)
 *   POST /api/v1/queue/{impl}/{gameId}/seat-enter — 좌석 진입 (토큰 검증)
 *   POST /api/v1/queue/{impl}/{gameId}/leave    — 대기열 이탈
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │ 방식 3 타이밍 사양                                        │
 * │                                                          │
 * │  Polling 간격:    2초 (Heartbeat 없음, polling만)         │
 * │  Heartbeat:      없음 (별도 API 없음)                    │
 * │  Entry TTL:      10분 (WAITING 상태 유지)                │
 * │  Admitted TTL:   15분 (입장 후 활동 시간)                 │
 * │  만료 체크:      Scheduler 30초 주기                      │
 * │  토큰:           JWE (AES-256-GCM, body로 전달)          │
 * │  분산 Lock:      모든 쓰기 작업에 적용                    │
 * │  수용:           maxCapacity (기본 5000명)                │
 * │  승격:           status polling 시 publishedRank 계산    │
 * │                                                          │
 * │  Redis 부하 = VU 수 × 1회/2초 = VU/2 req/s              │
 * │  500 VU = 250 req/s (polling only)                       │
 * └──────────────────────────────────────────────────────────┘
 */

// --- POC prefix (QUEUE_IMPL=suyeon → /api/v1/queue/suyeon) ---
const queueImpl = __ENV.QUEUE_IMPL || '';
const queueBasePath = queueImpl
  ? `/api/v1/queue/${queueImpl}`
  : '/api/v1/queue';

// --- 커스텀 메트릭 (대기열 전용) ---
export const queueMetrics = {
  enterLatency: new Trend('queue_enter_ms', true),
  statusLatency: new Trend('queue_status_ms', true),
  seatEnterLatency: new Trend('queue_seat_enter_ms', true),
  leaveLatency: new Trend('queue_leave_ms', true),
  waitDuration: new Trend('queue_wait_duration_ms', true),
  pollCount: new Trend('queue_poll_count'),
  immediatePassRate: new Rate('queue_immediate_pass_rate'),
  passRate: new Rate('queue_pass_rate'),
  timeoutCount: new Counter('queue_timeouts'),
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
 * @returns {{ queueToken: string, queueNumber: number, gameId: string, issuedAt: string } | null}
 */
export function queueEnter(queueUrl, gameId, auth) {
  const start = Date.now();
  const res = post(
    `${queueUrl}${queueBasePath}/enter`,
    { gameId },
    { ...auth, tags: { name: 'POST /queue/enter' } }
  );
  queueMetrics.enterLatency.add(Date.now() - start);
  return extractData(res);
}

/**
 * 대기 상태 조회 (Polling).
 * @returns {{ gameId, maxCapacity, activeCount, availableSlots, currentAllowedRank, publishedRank } | null}
 */
export function queueStatus(queueUrl, gameId, auth) {
  const start = Date.now();
  const res = get(
    `${queueUrl}${queueBasePath}/${gameId}/global-status`,
    { tags: { name: 'GET /queue/:gameId/global-status' } }
  );
  queueMetrics.statusLatency.add(Date.now() - start);
  return extractData(res);
}

/**
 * 좌석 진입 (순번 도달 후, JWE 토큰 검증).
 * @returns {{ enterAllowed: boolean, queueNumber: number, status: string } | null}
 */
export function queueSeatEnter(queueUrl, gameId, queueToken, auth) {
  const start = Date.now();
  const res = post(
    `${queueUrl}${queueBasePath}/${gameId}/seat-enter`,
    { queueToken },
    { ...auth, tags: { name: 'POST /queue/:gameId/seat-enter' } }
  );
  queueMetrics.seatEnterLatency.add(Date.now() - start);
  return extractData(res);
}

/**
 * 대기열 이탈 (결제 완료 또는 자발적).
 */
export function queueLeave(queueUrl, gameId, auth) {
  const start = Date.now();
  const res = post(
    `${queueUrl}${queueBasePath}/${gameId}/leave`,
    {},
    { ...auth, tags: { name: 'POST /queue/:gameId/leave' } }
  );
  queueMetrics.leaveLatency.add(Date.now() - start);
  return res.status >= 200 && res.status < 300;
}

/**
 * 대기열 진입 → Polling → 좌석 진입까지 대기.
 *
 * @param {number} [maxPolls=150]    최대 polling 횟수 (150 × 2초 = 5분)
 * @param {number} [pollInterval=2]  polling 간격 (초)
 * @returns {{ queueToken: string, waitMs: number, polls: number } | null}
 */
export function waitForQueuePass(queueUrl, gameId, auth, maxPolls = 150, pollInterval = 2) {
  const waitStart = Date.now();

  // Step 1: 대기열 진입
  const enterResult = queueEnter(queueUrl, gameId, auth);
  if (!enterResult) return null;

  const { queueToken, queueNumber } = enterResult;

  // Step 2: 첫 상태 확인 — 즉시 입장 가능한지
  const firstStatus = queueStatus(queueUrl, gameId, auth);
  if (firstStatus && queueNumber <= firstStatus.publishedRank) {
    const seatResult = queueSeatEnter(queueUrl, gameId, queueToken, auth);
    if (!seatResult || !seatResult.enterAllowed) {
      queueMetrics.passRate.add(false);
      return null;
    }

    const waitMs = Date.now() - waitStart;
    queueMetrics.immediatePassRate.add(true);
    queueMetrics.passRate.add(true);
    queueMetrics.waitDuration.add(waitMs);
    queueMetrics.pollCount.add(0);
    return { queueToken, waitMs, polls: 0 };
  }

  queueMetrics.immediatePassRate.add(false);

  // Step 3: Polling 대기 (Heartbeat 없음 — polling만)
  let polls = 0;
  while (polls < maxPolls) {
    sleep(pollInterval);
    polls++;

    const status = queueStatus(queueUrl, gameId, auth);
    if (!status) continue;

    if (queueNumber <= status.publishedRank) {
      // 순번 도달 → seat-enter
      const seatResult = queueSeatEnter(queueUrl, gameId, queueToken, auth);
      if (!seatResult || !seatResult.enterAllowed) {
        queueMetrics.passRate.add(false);
        return null;
      }

      const waitMs = Date.now() - waitStart;
      queueMetrics.passRate.add(true);
      queueMetrics.waitDuration.add(waitMs);
      queueMetrics.pollCount.add(polls);
      return { queueToken, waitMs, polls };
    }

    if (polls % 15 === 0) {
      console.log(
        `  queue: polling ${polls}/${maxPolls}, ` +
        `myNum=${queueNumber}, published=${status.publishedRank}, ` +
        `active=${status.activeCount}/${status.maxCapacity}`
      );
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

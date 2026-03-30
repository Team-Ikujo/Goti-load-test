import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { get, post, del } from './http-client.js';

/**
 * 대기열 액션 모듈 — PR #311 (구현 방식 2: sungjeon).
 *
 * Queue 서비스 API:
 *   POST   /api/v1/queues/enter              — 대기열 진입 (secureToken 발급)
 *   GET    /api/v1/queues/global-status      — 대기 순번 + 입장 가능 여부 (Polling)
 *   POST   /api/v1/queues/seat/enter         — 좌석 선택 진입 (순번 도달 시)
 *   POST   /api/v1/queues/heartbeat/waiting  — 대기 상태 Heartbeat (30초 TTL 갱신)
 *   DELETE /api/v1/queues/games/{gameId}     — 대기열 이탈 (결제 완료 또는 자발적)
 *
 * ┌──────────────────────────────────────────────────────────┐
 * │ 방식 2 타이밍 사양                                        │
 * │                                                          │
 * │  Polling 간격:    5초                                     │
 * │  Heartbeat 간격:  10초 (TTL 30초의 1/3)                   │
 * │  Waiting TTL:     30초 (heartbeat 안 하면 유령 제거)      │
 * │  Active TTL:      600초 (10분, heartbeat 불필요)          │
 * │  Enqueue 중복 TTL: 30초                                   │
 * │  Token:           AES-256 암호화 (secureToken query param)│
 * │  승격:            이벤트 기반 (Scheduler 없음)             │
 * │  수용:            maxCapacity (기본 100명)                 │
 * └──────────────────────────────────────────────────────────┘
 */

// Istio rewrite 경로: /api/v1/queue/sungjeon → /api/v1/queues
const queueBasePath = '/api/v1/queue/sungjeon';

// --- 커스텀 메트릭 (대기열 전용) ---
export const queueMetrics = {
  enterLatency: new Trend('queue_enter_ms', true),
  statusLatency: new Trend('queue_status_ms', true),
  seatEnterLatency: new Trend('queue_seat_enter_ms', true),
  heartbeatLatency: new Trend('queue_heartbeat_ms', true),
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
 * 대기열 초기화 (성전님 전용 — 수동 호출 필요).
 */
export function queueInit(queueUrl, gameId, maxCapacity, auth) {
  const res = post(
    `${queueUrl}${queueBasePath}/init?gameId=${gameId}&maxCapacity=${maxCapacity}`,
    null,
    { ...auth, tags: { name: 'POST /queues/init' } }
  );
  return res.status >= 200 && res.status < 300;
}

/**
 * 대기열 진입.
 * @returns {{ secureToken: string, myQueueNum: number, gameId: string } | null}
 */
export function queueEnter(queueUrl, gameId, auth) {
  const start = Date.now();
  const res = post(
    `${queueUrl}${queueBasePath}/enter?gameId=${gameId}`,
    null,
    { ...auth, tags: { name: 'POST /queues/enter' } }
  );
  queueMetrics.enterLatency.add(Date.now() - start);
  return extractData(res);
}

/**
 * 대기 상태 조회 (Polling).
 * @returns {{ myQueueNum: number, allowedQueueNum: number, waitingCount: number, isAllowed: boolean } | null}
 */
export function queueGlobalStatus(queueUrl, secureToken, auth) {
  const start = Date.now();
  const res = get(
    `${queueUrl}${queueBasePath}/global-status?secureToken=${encodeURIComponent(secureToken)}`,
    { ...auth, tags: { name: 'GET /queues/global-status' } }
  );
  queueMetrics.statusLatency.add(Date.now() - start);
  return extractData(res);
}

/**
 * 좌석 선택 진입 (순번 도달 후).
 */
export function queueSeatEnter(queueUrl, secureToken, auth) {
  const start = Date.now();
  const res = post(
    `${queueUrl}${queueBasePath}/seat/enter?secureToken=${encodeURIComponent(secureToken)}`,
    null,
    { ...auth, tags: { name: 'POST /queues/seat/enter' } }
  );
  queueMetrics.seatEnterLatency.add(Date.now() - start);
  return res.status >= 200 && res.status < 300;
}

/**
 * 대기 상태 Heartbeat (30초 TTL 갱신).
 */
export function queueHeartbeatWaiting(queueUrl, gameId, auth) {
  const start = Date.now();
  const res = post(
    `${queueUrl}${queueBasePath}/heartbeat/waiting?gameId=${gameId}`,
    null,
    { ...auth, tags: { name: 'POST /queues/heartbeat/waiting' } }
  );
  queueMetrics.heartbeatLatency.add(Date.now() - start);
  return res.status >= 200 && res.status < 300;
}

/**
 * 대기열 이탈 (결제 완료 또는 자발적).
 */
export function queueLeave(queueUrl, gameId, auth) {
  const res = del(
    `${queueUrl}${queueBasePath}/games/${gameId}`,
    { ...auth, tags: { name: 'DELETE /queues/games/:gameId' } }
  );
  return res.status >= 200 && res.status < 300;
}

/**
 * 대기열 진입 → Polling → 좌석 진입까지 대기.
 *
 * @param {number} [maxPolls=60]    최대 polling 횟수 (60 × 5초 = 5분)
 * @param {number} [pollInterval=5] polling 간격 (초)
 * @returns {{ secureToken: string, waitMs: number, polls: number } | null}
 */
export function waitForQueuePass(queueUrl, gameId, auth, maxPolls = 60, pollInterval = 5) {
  const waitStart = Date.now();

  // Step 1: 대기열 진입
  const enterResult = queueEnter(queueUrl, gameId, auth);
  if (!enterResult) return null;

  const { secureToken } = enterResult;

  // Step 2: 첫 상태 확인
  const firstStatus = queueGlobalStatus(queueUrl, secureToken, auth);
  if (firstStatus && firstStatus.isAllowed) {
    const entered = queueSeatEnter(queueUrl, secureToken, auth);
    if (!entered) return null;

    const waitMs = Date.now() - waitStart;
    queueMetrics.immediatePassRate.add(true);
    queueMetrics.passRate.add(true);
    queueMetrics.waitDuration.add(waitMs);
    queueMetrics.pollCount.add(0);
    return { secureToken, waitMs, polls: 0 };
  }

  queueMetrics.immediatePassRate.add(false);

  // Step 3: Polling 대기 + Heartbeat
  let polls = 0;
  let heartbeatCounter = 0;

  while (polls < maxPolls) {
    sleep(pollInterval);
    polls++;
    heartbeatCounter += pollInterval;

    // Heartbeat 갱신 (10초마다)
    if (heartbeatCounter >= 10) {
      queueHeartbeatWaiting(queueUrl, gameId, auth);
      heartbeatCounter = 0;
    }

    const status = queueGlobalStatus(queueUrl, secureToken, auth);
    if (!status) continue;

    if (status.isAllowed) {
      const entered = queueSeatEnter(queueUrl, secureToken, auth);
      if (!entered) {
        queueMetrics.passRate.add(false);
        return null;
      }

      const waitMs = Date.now() - waitStart;
      queueMetrics.passRate.add(true);
      queueMetrics.waitDuration.add(waitMs);
      queueMetrics.pollCount.add(polls);
      return { secureToken, waitMs, polls };
    }

    if (polls % 10 === 0) {
      console.log(
        `  queue: polling ${polls}/${maxPolls}, ` +
        `myNum=${status.myQueueNum}, allowed=${status.allowedQueueNum}, ` +
        `ahead=${status.waitingCount}`
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

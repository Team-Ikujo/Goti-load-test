import http from 'k6/http';
import { sleep, check, group } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { authHeaders } from '../helpers/auth.js';
import { browseSeatStatus } from '../helpers/ticketing-actions.js';

/**
 * 좌석 경합 부하 시나리오 (SDD Step 8 / S6.3, Rev post-review)
 *
 * 목적:
 *   - Go 마이그레이션 후 좌석 hold 락 경합 회복력 직접 측정
 *   - Java 측정에서 scenarioSeatContention이 runMixedScenario 내 15%만 호출됨.
 *     queue-suyeon-saturation 시나리오는 이를 미사용 → 경합 자체 측정 부족.
 *
 * 설계:
 *   - 100 VU × 10석 집중 (10:1 경합)
 *   - queue 우회 (순수 hold 경합만 측정)
 *   - 각 iteration마다 VU·ITER 기반 토큰 로테이션 → "동일 유저 중복 hold" 400 회피
 *   - 성공 시 즉시 release하여 경합 재현 지속
 *
 * 지표:
 *   - hold_success_rate: 200/201 성공률
 *   - hold_409_rate: 정상 경합 결과 (락 설계가 제대로 되어있다면 대부분이 여기)
 *   - hold_latency_ms: 성공 케이스 p95 (서버 응답시간)
 *   - hold_reject_latency_ms: 409 케이스 p95 (락 대기 없이 즉시 거절되어야)
 *   - hold_5xx_rate: 서버 오류 (락 구현 버그 징후)
 *
 * SDD G2 게이트:
 *   - hold_success_rate: "좌석 수만큼은 성공" (10/100 ≈ 10% 지점 이상)
 *   - hold_409_rate > 50% (경합이 정상적으로 드러남)
 *   - 성공/409 p95 < 500ms (락 대기가 숨지 않음)
 *   - hold_5xx_rate < 1%
 *
 * 실행:
 *   VUS=100 HOT_SEAT_COUNT=10 DURATION_SEC=180 ./run.sh seat-contention
 */

const vus = parseInt(__ENV.VUS || '100', 10);
const hotSeatCount = parseInt(__ENV.HOT_SEAT_COUNT || '10', 10);
const durationSec = parseInt(__ENV.DURATION_SEC || '180', 10);

const holdSuccessRate = new Rate('hold_success_rate');
const hold409Rate = new Rate('hold_409_rate');
const hold5xxRate = new Rate('hold_5xx_rate');
const holdLatency = new Trend('hold_latency_ms', true);
const holdRejectLatency = new Trend('hold_reject_latency_ms', true);
const holdAttempts = new Counter('hold_attempts_total');

export const options = {
  setupTimeout: '180s',
  scenarios: {
    seat_contention: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: vus },
        { duration: `${durationSec}s`, target: vus },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    ...thresholds,
    'hold_success_rate': ['rate>0.001'],   // 최소 성공 (10석 ≤ 성공, rampup+warmup 구간 집계 고려)
    'hold_409_rate': ['rate>0.5'],         // 경합 대부분이 409로 드러나야 정상
    'hold_5xx_rate': ['rate<0.01'],        // 서버 버그 < 1%
    'hold_latency_ms': ['p(95)<500'],      // 성공 p95 < 500ms
    'hold_reject_latency_ms': ['p(95)<500'], // 409도 즉시 거절돼야 (락 대기 숨지 않음)
  },
};

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  console.log(`=== 좌석 경합 — ${vus} VU × ${hotSeatCount}석 집중 ===`);
  const testData = setupTestData(baseUrl, runnerId, gameId);
  if (!testData) { console.error('setupTestData failed'); return null; }

  const firstToken = testData.tokens && testData.tokens[1];
  if (!firstToken) { console.error('No setup token available'); return null; }
  const auth = authHeaders(firstToken);

  const hotSection = testData.sections[0];
  const seats = browseSeatStatus(baseUrl, testData.gameId, hotSection, auth);
  if (!Array.isArray(seats)) { console.error('browseSeatStatus failed'); return null; }

  const candidates = seats.filter((s) => s.status === 'AVAILABLE').slice(0, hotSeatCount);
  console.log(`Hot pool: section=${hotSection}, candidates=${candidates.length}`);
  if (candidates.length === 0) { console.error('No AVAILABLE seats in hot section'); return null; }

  return {
    ...testData,
    hotSection,
    hotSeatIds: candidates.map((s) => s.seatId),
  };
}

export default function (data) {
  if (!data) { sleep(5); return; }
  const { baseUrl } = getEnv();

  // 동일 VU = 동일 유저 중복 hold 에러 회피: VU × ITER 기반 토큰 로테이션
  const tokenIdx = ((__VU * 7 + __ITER) % Math.max(1, (data.tokens.length - 1))) + 1;
  const token = data.tokens && data.tokens[tokenIdx];
  if (!token) { sleep(5); return; }
  const auth = authHeaders(token);

  const seatId = pickRandom(data.hotSeatIds);
  const queueTokenJti = `k6-${__VU}-${__ITER}-${Date.now()}`;

  group('hold', function () {
    const t0 = Date.now();
    holdAttempts.add(1);

    const res = http.post(
      `${baseUrl}/api/v1/seat-reservations/seats/${seatId}`,
      JSON.stringify({ gameId: data.gameId, queueTokenJti }),
      { ...auth, tags: { name: 'POST /seat-reservations' } },
    );
    const elapsed = Date.now() - t0;
    const status = res.status;

    const isSuccess = status >= 200 && status < 300;
    const is409 = status === 409;
    const is5xx = status >= 500;
    const isBusinessReject =
      status === 400 && typeof res.body === 'string' && res.body.includes('점유'); // 이미 점유

    holdSuccessRate.add(isSuccess);
    hold409Rate.add(is409 || isBusinessReject);
    hold5xxRate.add(is5xx);

    if (isSuccess) {
      holdLatency.add(elapsed);
    } else if (is409 || isBusinessReject) {
      holdRejectLatency.add(elapsed);
    }

    check(res, {
      'status is 200/201/409/400-점유': (r) => isSuccess || is409 || isBusinessReject,
    });

    // 성공 시 즉시 release → 경합 재현 지속
    if (isSuccess) {
      try {
        const body = res.json();
        const holdId = body && body.data && body.data.holdId;
        if (holdId) {
          http.del(`${baseUrl}/api/v1/seat-reservations/holds/${holdId}`, null,
            { ...auth, tags: { name: 'DELETE /seat-reservations' } });
        }
      } catch (_) {
        // release 실패는 TTL로 해결
      }
    }
  });

  // 경합 상황에서 사람들은 빠르게 재시도
  sleep(0.3 + Math.random() * 0.5);
}

export function teardown(data) {
  if (!data) return;
  console.log(`=== 경합 테스트 종료 — hotSeatIds ${data.hotSeatIds.length}석 ===`);
}

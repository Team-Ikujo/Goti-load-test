import { sleep } from 'k6';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { runMixedScenario, metrics } from '../helpers/ticketing-actions.js';

/**
 * Soak/Stability Test — 장시간 안정성 검증.
 * 1시간 동안 일정 부하를 유지하며 메모리 누수, 커넥션 누수 감지.
 *
 * 실행:
 *   k6 run scenarios/soak-stability.js -e RUNNER_ID=0 -e GAME_ID=...
 *   DURATION 환경변수로 시간 조절 (기본: 1h)
 */

const duration = __ENV.DURATION || '1h';

export const options = {
  scenarios: {
    soak: {
      executor: 'ramping-vus',
      stages: [
        { duration: '2m', target: 30 },
        { duration: duration, target: 30 },
        { duration: '2m', target: 0 },
      ],
    },
  },
  thresholds: {
    ...thresholds,
    http_req_duration: ['p(95)<2000', 'p(99)<5000'],
  },
};

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  console.log(`=== Soak Test Runner ${runnerId} | duration=${duration} ===`);
  return setupTestData(baseUrl, runnerId, gameId);
}

export default function (testData) {
  if (!testData) return;

  const { baseUrl, runnerId } = getEnv();
  runMixedScenario(baseUrl, testData, __VU, __ITER, runnerId);

  sleep(Math.random() * 3 + 2);
}

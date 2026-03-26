import { sleep } from 'k6';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { runMixedScenario, metrics } from '../helpers/ticketing-actions.js';

/**
 * Normal Load Test — 예상 평시 트래픽 시뮬레이션.
 * 10분간 점진 증가 후 유지. 조회/예매/취소/경합 혼합.
 *
 * 실행:
 *   k6 run scenarios/normal-load.js -e RUNNER_ID=0 -e GAME_ID=...
 */

export const options = {
  scenarios: {
    normal_traffic: {
      executor: 'ramping-vus',
      stages: [
        { duration: '1m', target: 30 },
        { duration: '3m', target: 80 },
        { duration: '5m', target: 80 },
        { duration: '2m', target: 30 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds,
};

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  console.log(`=== Normal Load Runner ${runnerId} ===`);
  return setupTestData(baseUrl, runnerId, gameId);
}

export default function (testData) {
  if (!testData) return;

  const { baseUrl, runnerId } = getEnv();
  runMixedScenario(baseUrl, testData, __VU, __ITER, runnerId);

  sleep(Math.random() * 2 + 1);
}

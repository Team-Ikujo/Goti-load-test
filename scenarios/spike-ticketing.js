import { sleep } from 'k6';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { runMixedScenario, metrics } from '../helpers/ticketing-actions.js';

/**
 * Spike Test — 티켓 오픈 순간 급증 시뮬레이션.
 * ramping-arrival-rate: 초당 요청 수 기반으로 실제 트래픽 패턴 재현.
 *
 * 패턴: 평시(10rps) → 급증(200rps) → 유지(100rps) → 감소(20rps)
 *
 * 실행 (4명 동시):
 *   k6 run scenarios/spike-ticketing.js -e RUNNER_ID=0 -e GAME_ID=...
 *   k6 run scenarios/spike-ticketing.js -e RUNNER_ID=1 -e GAME_ID=...
 *   k6 run scenarios/spike-ticketing.js -e RUNNER_ID=2 -e GAME_ID=...
 *   k6 run scenarios/spike-ticketing.js -e RUNNER_ID=3 -e GAME_ID=...
 */

const maxRate = parseInt(__ENV.MAX_RATE || '200', 10);

export const options = {
  scenarios: {
    ticket_open: {
      executor: 'ramping-arrival-rate',
      preAllocatedVUs: 100,
      maxVUs: 500,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '10s', target: maxRate },
        { duration: '2m', target: Math.floor(maxRate / 2) },
        { duration: '3m', target: Math.floor(maxRate / 5) },
        { duration: '30s', target: 5 },
      ],
    },
  },
  thresholds: {
    ...thresholds,
    goti_ticket_success_rate: ['rate>0.2'],
  },
};

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  console.log(`=== Spike Runner ${runnerId} | maxRate=${maxRate} rps ===`);
  return setupTestData(baseUrl, runnerId, gameId);
}

export default function (testData) {
  if (!testData) return;

  const { baseUrl, runnerId } = getEnv();
  runMixedScenario(baseUrl, testData, __VU, __ITER, runnerId);
}

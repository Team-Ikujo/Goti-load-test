import { sleep } from 'k6';
import { getEnv, thresholds } from '../config/environments.js';
import { setupTestData } from '../helpers/data-setup.js';
import { runMixedScenario, metrics } from '../helpers/ticketing-actions.js';

/**
 * E2E Ticketing Load Test — 혼합 시나리오 부하 테스트.
 *
 * 7가지 시나리오가 가중치 기반으로 혼합 실행:
 *   35% 조회 브라우징 (일정, 등급, 구역, 좌석상태, 가격정책, 팀상세)
 *   25% 정상 예매 (점유→주문→결제)
 *   10% 예매 후 취소 (점유→주문→결제→취소)
 *   10% 좌석 경합 (인기 구역 집중 → 409)
 *    5% 점유된 좌석 재시도 (실패 기대)
 *    5% HOLD 후 해제 (포기)
 *   10% 좌석 상태 반복 조회 (실시간 새로고침)
 *
 * 실행 (4명 각자 PC):
 *   k6 run scenarios/e2e-ticketing.js -e RUNNER_ID=0   # 1번 사람
 *   k6 run scenarios/e2e-ticketing.js -e RUNNER_ID=1   # 2번 사람
 *   k6 run scenarios/e2e-ticketing.js -e RUNNER_ID=2   # 3번 사람
 *   k6 run scenarios/e2e-ticketing.js -e RUNNER_ID=3   # 4번 사람
 *
 * 특정 경기 지정:
 *   k6 run scenarios/e2e-ticketing.js -e RUNNER_ID=0 -e GAME_ID=b8b9550a-...
 *
 * VU 수 조정:
 *   k6 run scenarios/e2e-ticketing.js -e RUNNER_ID=0 -e VUS=50
 */

export const options = {
  scenarios: {
    e2e_mixed: {
      executor: 'ramping-vus',
      stages: [
        { duration: '30s', target: parseInt(__ENV.VUS || '20', 10) },
        { duration: '3m', target: parseInt(__ENV.VUS || '20', 10) },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    ...thresholds,
    goti_ticket_success_rate: ['rate>0.3'],
  },
};

export function setup() {
  const { baseUrl, runnerId, gameId } = getEnv();
  console.log(`=== Runner ${runnerId} 시작 ===`);
  return setupTestData(baseUrl, runnerId, gameId);
}

export default function (testData) {
  if (!testData) return;

  const { baseUrl, runnerId } = getEnv();
  runMixedScenario(baseUrl, testData, __VU, __ITER, runnerId);

  // 다음 행동까지 대기 (페이지 이동, 스크롤 등)
  sleep(Math.random() * 5 + 3);
}

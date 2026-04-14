import { check } from 'k6';
import { getEnv } from '../config/environments.js';
import { get, post, checkStatus } from '../helpers/http-client.js';
import { signup, authHeaders } from '../helpers/auth.js';

/**
 * Smoke Test — 라우팅 가능한 API 개별 호출 확인.
 * 1 VU, 1 iteration. 각 서비스 API가 정상 응답하는지 확인.
 *
 * 대기열/좌석 플로우는 별도 시나리오에서 테스트 (queue → seat-grades → seat-sections).
 * - queue: VirtualService 라우팅 미설정 (/api/v1/queue)
 * - seat-grades: Turnstile 토큰 필수 (Cloudflare 검증)
 * - seat-sections: 예약세션 필요 (seat-grades 이후 생성)
 *
 * 실행: k6 run scenarios/smoke.js -e RUNNER_ID=0
 */

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    http_req_failed: ['rate<0.1'],
  },
};

export default function () {
  const { baseUrl, runnerId } = getEnv();

  // 1. 경기 일정 조회 (인증 불필요)
  const gamesRes = get(`${baseUrl}/api/v1/games/schedules?today=true`);
  checkStatus(gamesRes, 200, 'schedules');

  // 2. 회원가입 (테스트 유저)
  const authResult = signup(baseUrl, 99999, runnerId);
  check(authResult, {
    'signup returned token': (r) => r !== null && r.token && r.token.length > 0,
  });
  if (!authResult) {
    console.error('smoke: signup failed — skipping authenticated APIs');
    return;
  }
  const auth = authHeaders(authResult.token);

  // 3. 경기 데이터 추출 (좌석 데이터가 있는 기아/삼성 홈구장만)
  let gameId = null;
  let stadiumId = null;
  let homeTeamId = null;
  if (gamesRes.status === 200) {
    const gamesBody = JSON.parse(gamesRes.body);
    const gameList = gamesBody.data || gamesBody;
    if (Array.isArray(gameList) && gameList.length > 0) {
      const validTeams = ['기아', '삼성'];
      const game = gameList.find(
        (g) => g.ticketingStatus === 'AVAILABLE' && validTeams.includes(g.homeTeamDisplayName)
      ) || gameList.find((g) => validTeams.includes(g.homeTeamDisplayName)) || gameList[0];
      gameId = game.gameId;
      stadiumId = game.stadiumId;
      homeTeamId = game.homeTeamId;
    }
  }

  if (!gameId) {
    console.warn('smoke: 경기/구장 데이터 없음');
    return;
  }

  // 4. 가격 정책 조회
  if (homeTeamId) {
    checkStatus(
      get(`${baseUrl}/api/v1/teams/${homeTeamId}/ticket-pricing-policies`, auth),
      200, 'pricing policy'
    );
  }

  // 5. 팀 상세 조회
  if (homeTeamId) {
    checkStatus(
      get(`${baseUrl}/api/v1/baseball-teams/${homeTeamId}`, auth),
      200, 'team detail'
    );
  }

  // 6. 구매 내역 조회 — 실제 프론트 마이페이지가 호출하는 경로 (payment → ticketing 체인 검증)
  checkStatus(
    get(`${baseUrl}/api/v1/payments/purchases?months=3`, auth),
    200, 'purchases'
  );

  // 7. 오늘 경기 조회
  checkStatus(get(`${baseUrl}/api/v1/games/schedules?today=true`), 200, 'today games');

  console.log('smoke test completed');
}

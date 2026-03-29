import { check } from 'k6';
import { getEnv } from '../config/environments.js';
import { get, checkStatus } from '../helpers/http-client.js';
import { signup, authHeaders } from '../helpers/auth.js';

/**
 * Smoke Test — 각 API 개별 호출 확인.
 * 1 VU, 1 iteration. 모든 API가 정상 응답하는지만 확인.
 *
 * 실행: k6 run scenarios/smoke.js -e RUNNER_ID=0
 */

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    http_req_failed: ['rate<0.2'],
  },
};

export default function () {
  const { baseUrl, runnerId } = getEnv();

  // 1. 경기 일정 조회 (인증 불필요)
  const gamesRes = get(`${baseUrl}/api/v1/games/schedules?today=false`);
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

  // 3. 경기 데이터 추출
  let gameId = null;
  let stadiumId = null;
  let homeTeamId = null;
  if (gamesRes.status === 200) {
    const gamesBody = JSON.parse(gamesRes.body);
    const gameList = gamesBody.data || gamesBody;
    if (Array.isArray(gameList) && gameList.length > 0) {
      const game = gameList.find((g) => g.ticketingStatus === 'AVAILABLE') || gameList[0];
      gameId = game.gameId;
      stadiumId = game.stadiumId;
      homeTeamId = game.homeTeamId;
    }
  }

  if (!stadiumId) {
    console.warn('smoke: 경기/구장 데이터 없음');
    return;
  }

  // 4. 좌석 등급 조회
  checkStatus(
    get(`${baseUrl}/api/v1/stadium-seats/stadiums/${stadiumId}/games/${gameId}/seat-grades`, auth),
    200, 'seat grades'
  );

  // 5. 좌석 구역 조회
  const sectionsRes = get(`${baseUrl}/api/v1/stadium-seats/stadiums/${stadiumId}/seat-sections?gameId=${gameId}`, auth);
  checkStatus(sectionsRes, 200, 'seat sections');

  let sectionId = null;
  if (sectionsRes.status === 200) {
    const sectionsBody = JSON.parse(sectionsRes.body);
    const sectionList = sectionsBody.data || sectionsBody;
    if (Array.isArray(sectionList) && sectionList.length > 0) {
      sectionId = sectionList[0].sectionId;
    }
  }

  // 6. 좌석 상태 조회
  if (sectionId && gameId) {
    checkStatus(
      get(`${baseUrl}/api/v1/game-seats/${gameId}/sections/${sectionId}/seat-statuses`, auth),
      200, 'seat statuses'
    );
  }

  // 7. 가격 정책 조회
  if (homeTeamId) {
    checkStatus(
      get(`${baseUrl}/api/v1/teams/${homeTeamId}/ticket-pricing-policies`, auth),
      200, 'pricing policy'
    );
  }

  // 8. 팀 상세 조회
  if (homeTeamId) {
    checkStatus(
      get(`${baseUrl}/api/v1/baseball-teams/${homeTeamId}`, auth),
      200, 'team detail'
    );
  }

  // 9. 주문 목록 조회
  checkStatus(get(`${baseUrl}/api/v1/orders`, auth), 200, 'orders');

  // 10. 오늘 경기 조회
  checkStatus(get(`${baseUrl}/api/v1/games/schedules?today=true`), 200, 'today games');

  console.log('smoke test completed');
}

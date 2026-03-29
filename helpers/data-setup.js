import { get, checkStatus } from './http-client.js';
import { signup, authHeaders } from './auth.js';

/**
 * K6 setup() 함수에서 한 번만 실행.
 * 시드 데이터를 조회하여 부하테스트에 필요한 ID를 수집한다.
 *
 * 환경변수:
 *   GAME_ID — 특정 경기 지정 (미지정 시 AVAILABLE 경기 자동 선택)
 *
 * 전제: seed-kbo-data.sh + seed-kbo-games.sh 실행 완료
 */
export function setupTestData(baseUrl, runnerId = 0, gameIdOverride = null) {
  // 1. 관리자 유저 생성 + JWT
  const authResult = signup(baseUrl, 1, runnerId);
  if (!authResult) {
    console.error('setup: admin signup failed — aborting');
    return null;
  }
  const auth = authHeaders(authResult.token);

  // 2. 경기 일정 조회
  const gamesRes = get(`${baseUrl}/api/v1/games/schedules?today=false`, auth);
  if (!checkStatus(gamesRes, 200, 'list game schedules')) {
    console.error('setup: game schedules query failed');
    return null;
  }

  const games = JSON.parse(gamesRes.body);
  const gameList = games.data || games;

  if (!Array.isArray(gameList) || gameList.length === 0) {
    console.error('setup: 경기 일정이 없습니다 — seed-kbo-games.sh를 먼저 실행하세요');
    return null;
  }

  // 3. 경기 선택: GAME_ID 환경변수 > AVAILABLE 경기 > 첫 번째 경기
  let targetGame = null;

  if (gameIdOverride) {
    targetGame = gameList.find((g) => String(g.gameId) === gameIdOverride);
    if (!targetGame) {
      console.error(`setup: GAME_ID=${gameIdOverride} 경기를 찾을 수 없습니다`);
      return null;
    }
    console.log(`setup: 지정 경기 사용 — ${targetGame.homeTeamDisplayName} vs ${targetGame.awayTeamDisplayName}`);
  } else {
    targetGame = gameList.find((g) => g.ticketingStatus === 'AVAILABLE');
    if (!targetGame) {
      console.warn('setup: AVAILABLE 경기 없음 — 첫 번째 경기 사용 (점유/주문 실패 가능)');
      targetGame = gameList[0];
    } else {
      console.log(`setup: AVAILABLE 경기 선택 — ${targetGame.homeTeamDisplayName} vs ${targetGame.awayTeamDisplayName}`);
    }
  }

  const gameId = String(targetGame.gameId);
  const stadiumId = String(targetGame.stadiumId);
  const homeTeamId = String(targetGame.homeTeamId);

  // 4. 팀 ID 수집 (가격 정책/팀 조회용)
  const teamIds = [...new Set(
    gameList.slice(0, 20).flatMap((g) => [g.homeTeamId, g.awayTeamId]).filter(Boolean)
  )].slice(0, 10).map(String);

  // NOTE: seat-grades, seat-sections는 queue 통과 + ReservationSession이 필요하므로
  //       setup()에서 호출하지 않는다. VU의 default function에서 queue 통과 후 동적으로 조회.

  const testData = {
    gameId,
    stadiumId,
    homeTeamId,
    teamIds,
    ticketingStatus: targetGame.ticketingStatus,
    adminToken: authResult.token,
    adminUserId: authResult.userId,
  };

  console.log(
    `setup: gameId=${gameId}, stadium=${stadiumId}, ` +
    `teams=${teamIds.length}개, status=${targetGame.ticketingStatus}`
  );
  return testData;
}

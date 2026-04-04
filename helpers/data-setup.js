import { sleep } from 'k6';
import http from 'k6/http';
import { get, post, checkStatus } from './http-client.js';
import { signup, login, authHeaders } from './auth.js';

/**
 * K6 setup() 함수에서 한 번만 실행.
 * 시드 데이터를 조회하여 부하테스트에 필요한 ID를 수집한다.
 *
 * 환경변수:
 *   GAME_ID — 특정 경기 지정 (미지정 시 AVAILABLE 경기 자동 선택)
 *   VUS     — VU 수 (bulk 유저 사전 생성용)
 *
 * 전제: seed-kbo-data.sh + seed-kbo-games.sh 실행 완료
 */
export function setupTestData(baseUrl, runnerId = 0, gameIdOverride = null) {
  // 1. 관리자 유저 생성 + JWT (retry 3회 — pod cold start 대응)
  let authResult = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    authResult = signup(baseUrl, 1, runnerId);
    if (authResult) break;
    console.warn(`setup: admin signup attempt ${attempt}/3 failed — retrying in 5s`);
    sleep(5);
  }
  if (!authResult) {
    console.error('setup: admin signup failed after 3 attempts — aborting');
    return null;
  }
  const auth = authHeaders(authResult.token);

  // 1.5. VU용 테스트 유저 bulk 사전 생성 (이미 존재하면 skip)
  const vus = parseInt(__ENV.VUS || '100', 10);
  const startIndex = runnerId * 10000000 + 1;
  const bulkRes = post(`${baseUrl}/api/v1/test/users/bulk`, {
    startIndex: startIndex,
    count: Math.min(vus + 10, 10000),
  });
  if (bulkRes.status === 200) {
    const bulkData = JSON.parse(bulkRes.body);
    const d = bulkData.data || bulkData;
    console.log(`setup: bulk 유저 생성 — created=${d.createdCount}, skipped=${d.skippedCount}`);
  } else {
    console.warn(`setup: bulk 유저 생성 실패 (status=${bulkRes.status}) — VU에서 개별 signup fallback`);
  }

  // 2. 경기 선택
  let gameId, stadiumId, homeTeamId, teamIds, ticketingStatus;

  if (gameIdOverride && __ENV.STADIUM_ID && __ENV.HOME_TEAM_ID) {
    // GAME_ID + STADIUM_ID + HOME_TEAM_ID 모두 지정 시 경기 목록 조회 스킵 (47초 절약)
    gameId = gameIdOverride;
    stadiumId = __ENV.STADIUM_ID;
    homeTeamId = __ENV.HOME_TEAM_ID;
    teamIds = [homeTeamId];
    ticketingStatus = 'AVAILABLE';
    console.log(`setup: 환경변수 직접 지정 — gameId=${gameId}, stadium=${stadiumId}`);
  } else {
    // 경기 목록에서 조회 (auth 없이 — 공개 API)
    const gamesRes = get(`${baseUrl}/api/v1/games/schedules?today=false`);
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

    gameId = String(targetGame.gameId);
    stadiumId = String(targetGame.stadiumId);
    homeTeamId = String(targetGame.homeTeamId);
    ticketingStatus = targetGame.ticketingStatus;

    teamIds = [...new Set(
      gameList.slice(0, 20).flatMap((g) => [g.homeTeamId, g.awayTeamId]).filter(Boolean)
    )].slice(0, 10).map(String);
  }

  // NOTE: seat-grades, seat-sections는 queue 통과 + ReservationSession이 필요하므로
  //       setup()에서 호출하지 않는다. VU의 default function에서 queue 통과 후 동적으로 조회.

  // 5. VU용 토큰 사전 발급 (http.batch로 병렬 login → user 서비스 부하 분산)
  const tokens = {};
  const batchSize = 100;
  const totalVus = vus;
  let loginSuccess = 0;
  let loginFail = 0;

  for (let start = 1; start <= totalVus; start += batchSize) {
    const end = Math.min(start + batchSize, totalVus + 1);
    const requests = [];
    for (let i = start; i < end; i++) {
      const suffix = String(runnerId * 10000000 + i).padStart(8, '0');
      const mobile = `000${suffix}`;
      requests.push({
        method: 'POST',
        url: `${baseUrl}/api/v1/test/users/login`,
        body: JSON.stringify({ mobile }),
        params: { headers: { 'Content-Type': 'application/json' }, tags: { name: 'POST /test/users/login (batch)' } },
      });
    }

    const responses = http.batch(requests);
    for (let idx = 0; idx < responses.length; idx++) {
      const vuNum = start + idx;
      if (responses[idx].status === 200) {
        try {
          const body = JSON.parse(responses[idx].body);
          const token = (body.data || body).accessToken;
          if (token) { tokens[vuNum] = token; loginSuccess++; }
        } catch { loginFail++; }
      } else {
        loginFail++;
      }
    }
    if (start + batchSize <= totalVus) sleep(0.5);
  }

  console.log(`setup: 토큰 사전 발급 — success=${loginSuccess}, fail=${loginFail}/${totalVus}`);

  const testData = {
    gameId,
    stadiumId,
    homeTeamId,
    teamIds,
    ticketingStatus: ticketingStatus,
    adminToken: authResult.token,
    adminUserId: authResult.userId,
    tokens,
  };

  console.log(
    `setup: gameId=${gameId}, stadium=${stadiumId}, ` +
    `teams=${teamIds.length}개, status=${ticketingStatus}`
  );
  return testData;
}

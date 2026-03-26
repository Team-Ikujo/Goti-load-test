import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

/**
 * Synthetic Traffic — 상시 합성 트래픽.
 * 프론트엔드 실제 사용 패턴 기반, GET 위주.
 * Kind 클러스터 내부 CronJob으로 5분마다 실행.
 *
 * 로컬 실행:
 *   k6 run scenarios/synthetic-traffic.js -e BASE_URL=https://your-domain
 *
 * K8s 내부 실행 (CronJob):
 *   ENV=k8s-internal (자동 설정)
 *   → http://istio-ingressgateway.istio-system.svc:80 + Host: your-domain
 */

// ---------------------------------------------------------------------------
// 메트릭
// ---------------------------------------------------------------------------
const apiSuccessRate = new Rate('synthetic_api_success_rate');
const apiDuration = new Trend('synthetic_api_duration', true);
const apiCalls = new Counter('synthetic_api_calls');

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    synthetic: {
      executor: 'constant-vus',
      vus: 3,
      duration: '4m',
    },
  },
  thresholds: {
    synthetic_api_success_rate: ['rate>0.95'],
    synthetic_api_duration: ['p(95)<2000'],
  },
  noConnectionReuse: false,
};

// ---------------------------------------------------------------------------
// 환경 설정
// ---------------------------------------------------------------------------
function getConfig() {
  const envName = __ENV.ENV || 'external';

  if (envName === 'k8s-internal') {
    return {
      baseUrl: __ENV.BASE_URL || 'http://istio-gateway.istio-system.svc:80',
      hostHeader: __ENV.HOST_HEADER || 'your-domain',
    };
  }

  return {
    baseUrl: __ENV.BASE_URL || 'https://your-domain',
    hostHeader: null,
  };
}

const CONFIG = getConfig();

// ---------------------------------------------------------------------------
// HTTP 헬퍼 (self-contained)
// ---------------------------------------------------------------------------
function buildHeaders(extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (CONFIG.hostHeader) {
    headers['Host'] = CONFIG.hostHeader;
  }
  return headers;
}

function apiGet(path, extraHeaders = {}) {
  const url = `${CONFIG.baseUrl}${path}`;
  const res = http.get(url, { headers: buildHeaders(extraHeaders) });
  apiCalls.add(1);
  apiDuration.add(res.timings.duration);
  apiSuccessRate.add(res.status >= 200 && res.status < 400);

  if (res.status >= 400) {
    console.warn(`GET ${path} → ${res.status}`);
  }
  return res;
}

function apiPost(path, body, extraHeaders = {}) {
  const url = `${CONFIG.baseUrl}${path}`;
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const res = http.post(url, payload, { headers: buildHeaders(extraHeaders) });
  apiCalls.add(1);
  apiDuration.add(res.timings.duration);
  apiSuccessRate.add(res.status >= 200 && res.status < 400);

  if (res.status >= 400) {
    console.warn(`POST ${path} → ${res.status}`);
  }
  return res;
}

function extractData(res) {
  if (res.status !== 200) return null;
  try {
    const body = JSON.parse(res.body);
    return body.data || body;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Setup: 시드 데이터 수집 + 인증 토큰 발급
// ---------------------------------------------------------------------------
export function setup() {
  // 1. 테스트 유저 생성 + JWT
  const signupRes = apiPost('/api/v1/test/users', {
    name: 'K6-Synthetic',
    mobile: '00099990001',
    gender: 'MALE',
    birthDate: '1990-01-01',
  });
  const signupData = extractData(signupRes);
  if (!signupData || !signupData.accessToken) {
    console.error('setup: 유저 생성 실패');
    return null;
  }

  const token = signupData.accessToken;
  const authHeader = { Authorization: `Bearer ${token}` };

  // 2. 경기 일정 조회
  const gamesRes = apiGet('/api/v1/games/schedules?today=false');
  const games = extractData(gamesRes);
  if (!Array.isArray(games) || games.length === 0) {
    console.error('setup: 경기 일정 없음 — 시드 데이터 필요');
    return null;
  }

  // AVAILABLE 경기 우선
  const game = games.find((g) => g.ticketingStatus === 'AVAILABLE') || games[0];
  const gameId = String(game.gameId);
  const stadiumId = String(game.stadiumId);
  const homeTeamId = String(game.homeTeamId);

  // 3. 좌석 구역 조회
  const sectionsRes = apiGet(
    `/api/v1/stadium-seats/stadiums/${stadiumId}/seat-sections`
  );
  const sections = extractData(sectionsRes);
  const sectionIds = Array.isArray(sections)
    ? sections.map((s) => String(s.sectionId))
    : [];

  // 4. 팀 목록 (첫 3팀 ID)
  const teamIds = [...new Set(
    games.slice(0, 10).flatMap((g) => [g.homeTeamId, g.awayTeamId]).filter(Boolean)
  )].slice(0, 5).map(String);

  const testData = {
    token,
    gameId,
    stadiumId,
    homeTeamId,
    sectionIds,
    teamIds,
  };

  console.log(
    `setup: gameId=${gameId}, stadiumId=${stadiumId}, sections=${sectionIds.length}, teams=${teamIds.length}`
  );
  return testData;
}

// ---------------------------------------------------------------------------
// API 호출 함수들 (프론트엔드 페이지 매핑)
// ---------------------------------------------------------------------------

// 홈/티켓목록: 경기 일정 조회 (25%)
function browseSchedules() {
  apiGet('/api/v1/games/schedules?today=false');
}

// 홈: 오늘 경기 조회 (5%)
function browseTodayGames() {
  apiGet('/api/v1/games/schedules?today=true');
}

// 홈: 팀 상세 조회 (10%)
function browseTeam(teamIds) {
  if (teamIds.length === 0) return;
  const teamId = teamIds[Math.floor(Math.random() * teamIds.length)];
  apiGet(`/api/v1/baseball-teams/${teamId}`);
}

// 구역 선택: 좌석 등급 + 잔여석 (15%)
function browseSeatGrades(stadiumId, gameId) {
  apiGet(`/api/v1/stadium-seats/stadiums/${stadiumId}/games/${gameId}/seat-grades`);
}

// 구역 선택: 구역 목록 (10%)
function browseSeatSections(stadiumId) {
  apiGet(`/api/v1/stadium-seats/stadiums/${stadiumId}/seat-sections`);
}

// 구역 선택: 가격 정책 (5%)
function browsePricingPolicy(homeTeamId) {
  apiGet(`/api/v1/teams/${homeTeamId}/ticket-pricing-policies`);
}

// 좌석맵: 좌석 목록 (10%)
function browseSeatList(sectionIds) {
  if (sectionIds.length === 0) return;
  const sectionId = sectionIds[Math.floor(Math.random() * sectionIds.length)];
  apiGet(`/api/v1/seats/seat-sections/${sectionId}/seats`);
}

// 좌석 상태: 실시간 좌석 현황 (15%)
function browseSeatStatus(gameId, sectionIds) {
  if (sectionIds.length === 0) return;
  const sectionId = sectionIds[Math.floor(Math.random() * sectionIds.length)];
  apiGet(`/api/v1/game-seats/${gameId}/sections/${sectionId}/seat-statuses`);
}

// 마이페이지: 주문 목록 (5%, 인증 필요)
function browseOrders(token) {
  apiGet('/api/v1/orders', { Authorization: `Bearer ${token}` });
}

// ---------------------------------------------------------------------------
// 메인 루프: 가중치 기반 랜덤 API 호출
// ---------------------------------------------------------------------------
export default function (testData) {
  if (!testData) return;

  const { token, gameId, stadiumId, homeTeamId, sectionIds, teamIds } = testData;
  const roll = Math.random() * 100;

  if (roll < 25) {
    browseSchedules();
  } else if (roll < 35) {
    browseTeam(teamIds);
  } else if (roll < 50) {
    browseSeatGrades(stadiumId, gameId);
  } else if (roll < 60) {
    browseSeatSections(stadiumId);
  } else if (roll < 65) {
    browsePricingPolicy(homeTeamId);
  } else if (roll < 75) {
    browseSeatList(sectionIds);
  } else if (roll < 90) {
    browseSeatStatus(gameId, sectionIds);
  } else if (roll < 95) {
    browseOrders(token);
  } else {
    browseTodayGames();
  }

  // 실제 사용자 브라우징 패턴: 2~5초 대기
  sleep(Math.random() * 3 + 2);
}

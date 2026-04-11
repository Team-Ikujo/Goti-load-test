/**
 * K6 환경별 설정.
 *
 * 환경변수:
 *   ENV          — 환경 선택 (기본: external)
 *   BASE_URL     — 직접 URL 지정 (ENV보다 우선)
 *   RUNNER_ID    — 러너 식별자 0~3 (mobile 충돌 방지)
 *   RUNNER_NAME  — 러너 이름 (대시보드 표시용)
 *   TEST_NAME    — 테스트 세션명 (대시보드 필터용)
 *   GAME_ID      — 타겟 경기 ID (미지정 시 AVAILABLE 자동 선택)
 */

// 삼성/기아 홈구장 — 좌석 시드 데이터 있는 구장
const STADIUMS = {
  samsung: { stadiumId: '49f8dfd8-ee9c-439b-bd6e-b31f01252d47', homeTeamId: '412cfc77-2c5d-4583-8e79-968339223864' },
  kia:     { stadiumId: '4553f1c7-f5c1-468f-8ac9-f4883eb59ebc', homeTeamId: 'e5f58f8c-fcde-4017-8033-d8deb34fd4a2' },
};

export const environments = {
  // 외부 접근 (기본 — 각자 PC에서 실행)
  external: {
    baseUrl: __ENV.BASE_URL || '',
  },
  // EKS prod ALB 직접 접근 (Cloudflare 우회)
  'prod-alb': {
    baseUrl: 'https://goti-prod-alb-1464541669.ap-northeast-2.elb.amazonaws.com',
    hostHeader: 'api.go-ti.shop',
    insecureSkipTLSVerify: true,
    ...STADIUMS[__ENV.TEAM || 'samsung'],
  },
  // K8s 클러스터 내부 (CronJob/K6 Operator용)
  'k8s-internal': {
    baseUrl: __ENV.BASE_URL || 'http://istio-ingressgateway.istio-system.svc:80',
    hostHeader: __ENV.HOST_HEADER || '',
  },
};

export const thresholds = {
  http_req_duration: ['p(95)<2000', 'p(99)<5000'],
  http_req_failed: ['rate<0.10'],
};

export function getEnv() {
  const envName = __ENV.ENV || 'external';
  const env = environments[envName];
  if (!env) {
    throw new Error(`Unknown environment: ${envName}. Available: ${Object.keys(environments).join(', ')}`);
  }

  // HOST_HEADER 자동 설정 (env에 hostHeader가 있으면)
  if (env.hostHeader && !__ENV.HOST_HEADER) {
    __ENV.HOST_HEADER = env.hostHeader;
  }

  // STADIUM_ID / HOME_TEAM_ID 자동 설정
  if (env.stadiumId && !__ENV.STADIUM_ID) {
    __ENV.STADIUM_ID = env.stadiumId;
  }
  if (env.homeTeamId && !__ENV.HOME_TEAM_ID) {
    __ENV.HOME_TEAM_ID = env.homeTeamId;
  }

  return {
    ...env,
    baseUrl: __ENV.BASE_URL || env.baseUrl,
    runnerId: parseInt(__ENV.RUNNER_ID || '0', 10),
    runnerName: __ENV.RUNNER_NAME || `runner-${__ENV.RUNNER_ID || '0'}`,
    testName: __ENV.TEST_NAME || 'unnamed',
    gameId: __ENV.GAME_ID || null,
  };
}

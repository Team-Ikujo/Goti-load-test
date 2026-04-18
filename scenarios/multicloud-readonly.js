import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

/**
 * 멀티클라우드 read-only 부하 시나리오 (ADR-0018 Phase B 관측용).
 *
 * 목적:
 *   - CF Worker 가 팀코드 기반으로 AWS EKS / GCP GKE 양쪽에 트래픽 분배
 *   - 읽기 전용 endpoint 만 호출 → AWS RDS `default_transaction_read_only=on`
 *     상태에서도 에러 없이 동작 (subscriber 모드)
 *   - Grafana `multi-cloud-compare` 대시보드에서 cluster 별 p95/rps/cpu 비교
 *
 * 프론트 실제 호출 경로 기반 (Goti-front/src/entities/*):
 *   1. GET /api/v1/games/schedules?today=true    (메인 페이지 진입)
 *   2. GET /api/v1/games/schedules?teamId={uuid} (팀별 일정 필터)
 *   3. GET /api/v1/baseball-teams/{uuid}         (팀 상세)
 *   4. GET /api/v1/stadiums/{uuid}               (구장 상세)
 *
 * 모두 public (인증 불필요). 401/403 발생 불가.
 *
 * 실행: ./run.sh multicloud-readonly
 * 기본: VUS=5, DURATION=2m. CF Worker 를 거치도록 BASE_URL=https://go-ti.shop 권장.
 */

const vus = parseInt(__ENV.VUS || '5', 10);
const duration = __ENV.DURATION || '2m';
const BASE_URL = __ENV.BASE_URL || 'https://go-ti.shop';

// 팀코드 기반 라우팅 분배를 위해 여러 팀 UUID rotate
// (config/environments.js 의 STADIUMS 와 동일)
const TEAM_IDS = [
  '412cfc77-2c5d-4583-8e79-968339223864',  // 삼성
  'e5f58f8c-fcde-4017-8033-d8deb34fd4a2',  // 기아
];

const STADIUM_IDS = [
  '49f8dfd8-ee9c-439b-bd6e-b31f01252d47',  // 삼성 홈
  '4553f1c7-f5c1-468f-8ac9-f4883eb59ebc',  // 기아 홈
];

export const options = {
  insecureSkipTLSVerify: true,
  scenarios: {
    multicloud_readonly: {
      executor: 'constant-vus',
      vus: vus,
      duration: duration,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],                   // read-only 라 실패율 1% 미만
    http_req_duration: ['p(95)<2000', 'p(99)<5000'],
    'http_req_duration{endpoint:schedules-today}':  ['p(95)<1500'],
    'http_req_duration{endpoint:schedules-team}':   ['p(95)<1500'],
    'http_req_duration{endpoint:team-detail}':      ['p(95)<1000'],
    'http_req_duration{endpoint:stadium-detail}':   ['p(95)<1000'],
  },
  tags: { test: 'multicloud-readonly', adr: '0018-phase-b' },
};

const schedulesTodayTrend = new Trend('schedules_today_duration', true);
const schedulesTeamTrend  = new Trend('schedules_team_duration', true);
const teamDetailTrend     = new Trend('team_detail_duration', true);
const stadiumDetailTrend  = new Trend('stadium_detail_duration', true);

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function thinkTime() { sleep(0.5 + Math.random() * 1.5); }  // 0.5~2초

export default function () {
  const teamId = rand(TEAM_IDS);
  const stadiumId = rand(STADIUM_IDS);

  // 1) 메인 페이지 진입 — 오늘 경기 일정
  const r1 = http.get(`${BASE_URL}/api/v1/games/schedules?today=true`,
    { tags: { endpoint: 'schedules-today' } });
  schedulesTodayTrend.add(r1.timings.duration);
  check(r1, {
    'schedules-today 200': (r) => r.status === 200,
    'schedules-today has gameId': (r) => r.body && r.body.includes('gameId'),
  });
  thinkTime();

  // 2) 팀별 일정 필터
  const r2 = http.get(`${BASE_URL}/api/v1/games/schedules?teamId=${teamId}`,
    { tags: { endpoint: 'schedules-team' } });
  schedulesTeamTrend.add(r2.timings.duration);
  check(r2, { 'schedules-team 200': (r) => r.status === 200 });
  thinkTime();

  // 3) 팀 상세
  const r3 = http.get(`${BASE_URL}/api/v1/baseball-teams/${teamId}`,
    { tags: { endpoint: 'team-detail' } });
  teamDetailTrend.add(r3.timings.duration);
  check(r3, { 'team-detail 200': (r) => r.status === 200 });
  thinkTime();

  // 4) 구장 상세
  const r4 = http.get(`${BASE_URL}/api/v1/stadiums/${stadiumId}`,
    { tags: { endpoint: 'stadium-detail' } });
  stadiumDetailTrend.add(r4.timings.duration);
  check(r4, { 'stadium-detail 200': (r) => r.status === 200 });
  thinkTime();
}

export function handleSummary(data) {
  const m = data.metrics;
  const summary = {
    duration_sec: (data.state.testRunDurationMs / 1000).toFixed(1),
    vus: vus,
    total_requests: m.http_reqs?.values?.count || 0,
    rps: m.http_reqs?.values?.rate?.toFixed(1),
    failed_rate: m.http_req_failed?.values?.rate,
    overall: {
      p95_ms: m.http_req_duration?.values?.['p(95)']?.toFixed(0),
      p99_ms: m.http_req_duration?.values?.['p(99)']?.toFixed(0),
    },
    by_endpoint: {
      'schedules-today': { p95_ms: m.schedules_today_duration?.values?.['p(95)']?.toFixed(0) },
      'schedules-team':  { p95_ms: m.schedules_team_duration?.values?.['p(95)']?.toFixed(0) },
      'team-detail':     { p95_ms: m.team_detail_duration?.values?.['p(95)']?.toFixed(0) },
      'stadium-detail':  { p95_ms: m.stadium_detail_duration?.values?.['p(95)']?.toFixed(0) },
    },
  };
  return {
    stdout: '\n' + JSON.stringify(summary, null, 2) + '\n',
  };
}

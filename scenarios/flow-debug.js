import { sleep } from 'k6';
import { getEnv } from '../config/environments.js';
import { signup, authHeaders } from '../helpers/auth.js';
import { get, post, checkStatus } from '../helpers/http-client.js';

/**
 * 플로우 디버그 — 1명이 전체 예매 플로우를 단계별로 실행하며 각 단계 결과를 출력.
 *
 * 실행:
 *   k6 run scenarios/flow-debug.js \
 *     -e BASE_URL=https://... -e HOST_HEADER=api.go-ti.shop \
 *     -e GAME_ID=... -e STADIUM_ID=... -e HOME_TEAM_ID=... \
 *     --insecure-skip-tls-verify
 */

export const options = {
  vus: 1,
  iterations: 1,
  insecureSkipTLSVerify: true,
  thresholds: {
    http_req_failed: ['rate<1'],
  },
};

export default function () {
  const { baseUrl } = getEnv();
  const gameId = __ENV.GAME_ID;
  const stadiumId = __ENV.STADIUM_ID;
  const homeTeamId = __ENV.HOME_TEAM_ID;

  console.log(`=== 플로우 디버그 시작 ===`);
  console.log(`  gameId: ${gameId}`);
  console.log(`  stadiumId: ${stadiumId}`);
  console.log(`  homeTeamId: ${homeTeamId}`);

  // 1. 회원가입
  console.log(`\n--- Step 1: 회원가입 ---`);
  const authResult = signup(baseUrl, 88888, 0);
  if (!authResult) { console.error('FAIL: signup'); return; }
  console.log(`OK: userId=${authResult.userId}, token=${authResult.token.substring(0, 20)}...`);
  const auth = authHeaders(authResult.token);

  // 2. 대기열 진입
  console.log(`\n--- Step 2: 대기열 진입 ---`);
  const enterRes = post(`${baseUrl}/api/v1/queue/enter`, { gameId }, { ...auth, tags: { name: 'queue-enter' } });
  console.log(`  status=${enterRes.status} body=${enterRes.body ? enterRes.body.substring(0, 300) : 'empty'}`);
  if (enterRes.status !== 200) { console.error('FAIL: queue enter'); return; }
  const enterData = JSON.parse(enterRes.body);
  const queueToken = (enterData.data || enterData).queueToken;
  const queueNumber = (enterData.data || enterData).queueNumber;
  console.log(`OK: queueNumber=${queueNumber}`);

  // 3. 대기열 상태 확인
  console.log(`\n--- Step 3: 대기열 상태 확인 ---`);
  const statusRes = get(`${baseUrl}/api/v1/queue/${gameId}/global-status`, { tags: { name: 'queue-status' } });
  console.log(`  status=${statusRes.status} body=${statusRes.body ? statusRes.body.substring(0, 300) : 'empty'}`);

  // 4. 좌석 진입 (seat-enter)
  console.log(`\n--- Step 4: 좌석 진입 ---`);
  const seatEnterRes = post(`${baseUrl}/api/v1/queue/${gameId}/seat-enter`, { queueToken }, { ...auth, tags: { name: 'seat-enter' } });
  console.log(`  status=${seatEnterRes.status} body=${seatEnterRes.body ? seatEnterRes.body.substring(0, 300) : 'empty'}`);
  if (seatEnterRes.status !== 200) { console.error('FAIL: seat-enter'); return; }

  // 5. 좌석 등급 조회 (forceNewSession=true)
  console.log(`\n--- Step 5: 좌석 등급 조회 (seat-grades) ---`);
  const gradesRes = get(`${baseUrl}/api/v1/stadium-seats/games/${gameId}/seat-grades?forceNewSession=true`, { ...auth, tags: { name: 'seat-grades' } });
  console.log(`  status=${gradesRes.status} body=${gradesRes.body ? gradesRes.body.substring(0, 500) : 'empty'}`);
  if (gradesRes.status !== 200) { console.error('FAIL: seat-grades'); return; }

  // 6. 좌석 구역 조회 (seat-sections)
  console.log(`\n--- Step 6: 좌석 구역 조회 (seat-sections) ---`);
  const sectionsRes = get(`${baseUrl}/api/v1/stadium-seats/stadiums/${stadiumId}/seat-sections?gameId=${gameId}`, { ...auth, tags: { name: 'seat-sections' } });
  console.log(`  status=${sectionsRes.status} body=${sectionsRes.body ? sectionsRes.body.substring(0, 500) : 'empty'}`);
  if (sectionsRes.status !== 200) { console.error('FAIL: seat-sections'); return; }
  const sectionsData = JSON.parse(sectionsRes.body);
  const sections = (sectionsData.data || sectionsData);
  if (!Array.isArray(sections) || sections.length === 0) { console.error('FAIL: no sections'); return; }
  const sectionId = sections[0].sectionId || sections[0].id;
  console.log(`OK: ${sections.length}개 구역, 첫번째=${sectionId}`);

  // 7. 좌석 상태 조회
  console.log(`\n--- Step 7: 좌석 상태 조회 ---`);
  const seatsRes = get(`${baseUrl}/api/v1/game-seats/${gameId}/sections/${sectionId}/seat-statuses`, { ...auth, tags: { name: 'seat-statuses' } });
  console.log(`  status=${seatsRes.status} body=${seatsRes.body ? seatsRes.body.substring(0, 500) : 'empty'}`);
  if (seatsRes.status !== 200) { console.error('FAIL: seat-status'); return; }
  const seatsData = JSON.parse(seatsRes.body);
  const seats = seatsData.data || seatsData;
  const available = Array.isArray(seats) ? seats.filter(s => s.status === 'AVAILABLE') : [];
  console.log(`OK: 전체=${Array.isArray(seats) ? seats.length : 0}, AVAILABLE=${available.length}`);
  if (available.length === 0) { console.error('FAIL: no available seats'); return; }

  // 8. 좌석 점유 (hold)
  console.log(`\n--- Step 8: 좌석 점유 (hold) ---`);
  const seat = available[0];
  const holdRes = post(`${baseUrl}/api/v1/seat-reservations/seats/${seat.seatId}`, { gameId, queueTokenJti: `debug-${Date.now()}` }, { ...auth, tags: { name: 'seat-hold' } });
  console.log(`  status=${holdRes.status} body=${holdRes.body ? holdRes.body.substring(0, 300) : 'empty'}`);
  if (holdRes.status !== 200) { console.error('FAIL: seat-hold'); return; }
  const holdData = JSON.parse(holdRes.body);
  const holdId = (holdData.data || holdData).holdId || (holdData.data || holdData).id;
  console.log(`OK: holdId=${holdId}`);

  // 9. 주문 생성
  console.log(`\n--- Step 9: 주문 생성 ---`);
  const orderRes = post(`${baseUrl}/api/v1/orders`, {
    gameId,
    holdIds: [String(holdId)],
    ordererName: 'K6-Debug',
    ordererPhone: '01012340001',
    ordererEmail: 'k6-debug@goti.test',
  }, { ...auth, tags: { name: 'create-order' } });
  console.log(`  status=${orderRes.status} body=${orderRes.body ? orderRes.body.substring(0, 500) : 'empty'}`);
  if (orderRes.status !== 200 && orderRes.status !== 201) { console.error('FAIL: create-order'); return; }
  const orderData = JSON.parse(orderRes.body);
  const orderId = (orderData.data || orderData).orderId || (orderData.data || orderData).id;
  console.log(`OK: orderId=${orderId}`);

  // 10. 결제
  console.log(`\n--- Step 10: 결제 ---`);
  const payRes = post(`${baseUrl}/api/v1/payments/orders/${orderId}`, { paymentMethod: 'CARD', idempotencyKey: `debug-pay-${Date.now()}` }, { ...auth, tags: { name: 'pay-order' } });
  console.log(`  status=${payRes.status} body=${payRes.body ? payRes.body.substring(0, 500) : 'empty'}`);
  if (payRes.status !== 200 && payRes.status !== 201) { console.error('FAIL: payment'); return; }

  // 11. 대기열 이탈
  console.log(`\n--- Step 11: 대기열 이탈 (leave) ---`);
  const leaveRes = post(`${baseUrl}/api/v1/queue/${gameId}/leave`, {}, { ...auth, tags: { name: 'queue-leave' } });
  console.log(`  status=${leaveRes.status} body=${leaveRes.body ? leaveRes.body.substring(0, 200) : 'empty'}`);

  console.log(`\n=== 전체 플로우 성공! ===`);
}

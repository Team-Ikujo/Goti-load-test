import { sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { get, post, checkStatus } from './http-client.js';
import { signup, authHeaders } from './auth.js';

/**
 * 부하테스트 공통 액션 모듈.
 * 각 시나리오(e2e, spike, normal, soak)에서 재사용.
 *
 * 시나리오 비율 (가중치):
 *   35% 조회 (브라우징 — 일정, 등급, 구역, 좌석상태, 가격정책, 팀상세)
 *   25% 정상 예매 (점유→주문→결제)
 *   10% 예매 후 취소 (점유→주문→결제→취소)
 *   10% 좌석 경합 (인기 구역 집중 → 409 기대)
 *    5% 이미 점유된 좌석 재시도 (실패 기대)
 *    5% HOLD 후 해제 (점유→해제)
 *   10% 조회 집중 (좌석 상태만 반복 — 실시간 갱신 시뮬레이션)
 *
 * Think Time (티켓 오픈 직후 — 급하게 구매):
 *   페이지 탐색:       1~3초
 *   좌석 선택 고민:    2~5초
 *   주문 정보 입력:    3~6초
 *   결제 진행:         2~4초
 *   결제 후 확인:      1~2초
 *
 * 1 VU = 1 실제 사용자. 1인당 최대 4석 예매.
 */

// --- Think Time 헬퍼 (티켓 오픈 모드) ---
function thinkBrowse() { sleep(Math.random() * 2 + 1); }      // 1~3초
function thinkSeatSelect() { sleep(Math.random() * 3 + 2); }  // 2~5초
function thinkOrderForm() { sleep(Math.random() * 3 + 3); }   // 3~6초
function thinkPayment() { sleep(Math.random() * 2 + 2); }     // 2~4초
function thinkConfirm() { sleep(Math.random() * 1 + 1); }     // 1~2초

// 1인당 예매 좌석 수 (1~4석 랜덤)
const MAX_SEATS_PER_USER = 4;
function randomSeatCount() { return Math.floor(Math.random() * MAX_SEATS_PER_USER) + 1; }

// --- 커스텀 메트릭 ---
export const metrics = {
  seatSelection: new Trend('goti_seat_selection_ms', true),
  orderCreation: new Trend('goti_order_creation_ms', true),
  payment: new Trend('goti_payment_ms', true),
  orderCancel: new Trend('goti_order_cancel_ms', true),
  ticketSuccess: new Rate('goti_ticket_success_rate'),
  seatConflict: new Counter('goti_seat_conflicts'),
  orderCancelCount: new Counter('goti_order_cancels'),
  holdReleaseCount: new Counter('goti_hold_releases'),
};

// --- 헬퍼 ---
function extractData(res) {
  if (res.status < 200 || res.status >= 300) return null;
  try {
    const body = JSON.parse(res.body);
    return body.data || body;
  } catch {
    return null;
  }
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// --- 조회 액션들 (URL Grouping으로 시리즈 폭발 방지) ---
export function browseSchedules(baseUrl) {
  get(`${baseUrl}/api/v1/games/schedules?today=false`, { tags: { name: 'GET /schedules' } });
}

export function browseTodayGames(baseUrl) {
  get(`${baseUrl}/api/v1/games/schedules?today=true`, { tags: { name: 'GET /schedules?today' } });
}

export function browseTeam(baseUrl, teamIds, auth) {
  if (teamIds.length === 0) return;
  get(`${baseUrl}/api/v1/baseball-teams/${pickRandom(teamIds)}`, {
    ...auth, tags: { name: 'GET /baseball-teams/:id' },
  });
}

export function browseSeatGrades(baseUrl, stadiumId, gameId, auth) {
  get(`${baseUrl}/api/v1/stadium-seats/stadiums/${stadiumId}/games/${gameId}/seat-grades`, {
    ...auth, tags: { name: 'GET /seat-grades' },
  });
}

export function browseSeatSections(baseUrl, stadiumId, gameId, auth) {
  const res = get(`${baseUrl}/api/v1/stadium-seats/stadiums/${stadiumId}/seat-sections?gameId=${gameId}`, {
    ...auth, tags: { name: 'GET /seat-sections' },
  });
  if (res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      const list = body.data || body;
      if (Array.isArray(list)) {
        return list.map((s) => String(s.sectionId));
      }
    } catch { /* ignore */ }
  }
  return null;
}

export function browsePricingPolicy(baseUrl, homeTeamId, auth) {
  get(`${baseUrl}/api/v1/teams/${homeTeamId}/ticket-pricing-policies`, {
    ...auth, tags: { name: 'GET /pricing-policies' },
  });
}

export function browseSeatStatus(baseUrl, gameId, sectionId, auth) {
  const start = Date.now();
  const res = get(
    `${baseUrl}/api/v1/game-seats/${gameId}/sections/${sectionId}/seat-statuses`,
    { ...auth, tags: { name: 'GET /seat-statuses' } }
  );
  metrics.seatSelection.add(Date.now() - start);
  return extractData(res);
}

// --- 좌석 점유 ---
export function holdSeat(baseUrl, seatId, gameId, vuId, iterId, auth) {
  const queueTokenJti = `k6-${vuId}-${iterId}-${Date.now()}`;
  const res = post(
    `${baseUrl}/api/v1/seat-reservations/seats/${seatId}`,
    { gameId, queueTokenJti },
    { ...auth, tags: { name: 'POST /seat-reservations' } }
  );

  if (res.status === 409) {
    metrics.seatConflict.add(1);
    return null;
  }
  if (res.status === 400 && res.body && res.body.includes('점유')) {
    metrics.seatConflict.add(1);
    return null;
  }

  const data = extractData(res);
  return data ? data.holdId : null;
}

// --- HOLD 해제 ---
export function releaseHold(baseUrl, holdId, auth) {
  const res = post(
    `${baseUrl}/api/v1/seat-reservations/${holdId}`,
    {},
    { ...auth, tags: { name: 'POST /seat-reservations/release' } }
  );
  metrics.holdReleaseCount.add(1);
  return res.status >= 200 && res.status < 300;
}

// --- 주문 생성 ---
export function createOrder(baseUrl, gameId, holdIds, vuId, auth) {
  const start = Date.now();
  const res = post(
    `${baseUrl}/api/v1/orders`,
    {
      gameId,
      holdIds: holdIds.map(String),
      ordererName: `K6-User-${vuId}`,
      ordererPhone: '01012340001',
      ordererEmail: `k6-${vuId}@goti.test`,
    },
    { ...auth, tags: { name: 'POST /orders' } }
  );
  metrics.orderCreation.add(Date.now() - start);

  const data = extractData(res);
  return data ? { orderId: data.orderId, orderNumber: data.orderNumber } : null;
}

// --- 결제 ---
export function payOrder(baseUrl, orderId, vuId, auth) {
  const start = Date.now();
  const idempotencyKey = `k6-pay-${vuId}-${Date.now()}`;
  const res = post(
    `${baseUrl}/api/v1/payments/orders/${orderId}`,
    { paymentMethod: 'CARD', idempotencyKey },
    { ...auth, tags: { name: 'POST /payments' } }
  );
  metrics.payment.add(Date.now() - start);

  const data = extractData(res);
  if (!data) return null;
  return {
    paymentId: data.paymentId,
    paymentStatus: data.paymentStatus,
    pgTid: data.pgTid,
  };
}

// --- 주문 취소 ---
export function cancelOrder(baseUrl, orderId, auth) {
  const start = Date.now();
  const res = post(
    `${baseUrl}/api/v1/orders/${orderId}/cancellations`,
    { cancelReason: 'K6 부하테스트 취소' },
    auth
  );
  metrics.orderCancel.add(Date.now() - start);
  metrics.orderCancelCount.add(1);
  return res.status >= 200 && res.status < 300;
}

// --- 복합 시나리오 ---

/**
 * 시나리오 A: 조회 브라우징
 */
export function scenarioBrowse(baseUrl, testData, auth) {
  const roll = Math.random();
  if (roll < 0.25) {
    browseSchedules(baseUrl);
  } else if (roll < 0.40) {
    browseSeatGrades(baseUrl, testData.stadiumId, testData.gameId, auth);
  } else if (roll < 0.55) {
    browseSeatSections(baseUrl, testData.stadiumId, testData.gameId, auth);
  } else if (roll < 0.70) {
    browseSeatStatus(baseUrl, testData.gameId, pickRandom(testData.sections), auth);
  } else if (roll < 0.80) {
    browsePricingPolicy(baseUrl, testData.homeTeamId, auth);
  } else if (roll < 0.90) {
    browseTeam(baseUrl, testData.teamIds, auth);
  } else {
    browseTodayGames(baseUrl);
  }
}

/**
 * 시나리오 B: 정상 예매 플로우 (점유→주문→결제)
 */
export function scenarioFullBooking(baseUrl, testData, vuId, iterId, auth) {
  // 좌석 조회
  const sectionId = pickRandom(testData.sections);
  const seats = browseSeatStatus(baseUrl, testData.gameId, sectionId, auth);

  if (!Array.isArray(seats)) return false;
  const available = seats.filter((s) => s.status === 'AVAILABLE');
  if (available.length === 0) return false;

  thinkSeatSelect();

  // 1~4석 점유
  const wantCount = randomSeatCount();
  const holdIds = [];
  const shuffled = available.sort(() => Math.random() - 0.5);
  for (let i = 0; i < Math.min(wantCount, shuffled.length); i++) {
    const hid = holdSeat(baseUrl, shuffled[i].seatId, testData.gameId, vuId, iterId, auth);
    if (hid) holdIds.push(hid);
  }
  if (holdIds.length === 0) return false;

  thinkOrderForm();

  // 주문 생성 (확보한 좌석 전부)
  const order = createOrder(baseUrl, testData.gameId, holdIds, vuId, auth);
  if (!order) return false;

  thinkPayment();

  // 결제
  const payment = payOrder(baseUrl, order.orderId, vuId, auth);
  return !!payment;
}

/**
 * 시나리오 C: 예매 후 취소
 */
export function scenarioBookAndCancel(baseUrl, testData, vuId, iterId, auth) {
  const sectionId = pickRandom(testData.sections);
  const seats = browseSeatStatus(baseUrl, testData.gameId, sectionId, auth);

  if (!Array.isArray(seats)) return false;
  const available = seats.filter((s) => s.status === 'AVAILABLE');
  if (available.length === 0) return false;

  thinkSeatSelect();

  // 1~4석 점유
  const wantCount = randomSeatCount();
  const holdIds = [];
  const shuffled = available.sort(() => Math.random() - 0.5);
  for (let i = 0; i < Math.min(wantCount, shuffled.length); i++) {
    const hid = holdSeat(baseUrl, shuffled[i].seatId, testData.gameId, vuId, iterId, auth);
    if (hid) holdIds.push(hid);
  }
  if (holdIds.length === 0) return false;

  thinkOrderForm();

  const order = createOrder(baseUrl, testData.gameId, holdIds, vuId, auth);
  if (!order) return false;

  thinkPayment(); // 10~20초: 결제

  const payment = payOrder(baseUrl, order.orderId, vuId, auth);
  if (!payment) return false;

  thinkConfirm(); // 5~15초: 결제 확인 후 마음 바꿈

  return cancelOrder(baseUrl, order.orderId, auth);
}

/**
 * 시나리오 D: 좌석 경합 (인기 구역 첫 번째 섹션에 집중)
 */
export function scenarioSeatContention(baseUrl, testData, vuId, iterId, auth) {
  // 모든 러너가 첫 번째 구역에 집중 → 경합 발생
  const hotSection = testData.sections[0];
  const seats = browseSeatStatus(baseUrl, testData.gameId, hotSection, auth);

  if (!Array.isArray(seats)) return;
  const available = seats.filter((s) => s.status === 'AVAILABLE');
  if (available.length === 0) return;

  // 좌석맵 보면서 빠르게 클릭 (경합 상황에서 사람들은 빨리 누름)
  sleep(Math.random() * 1 + 0.5); // 0.5~1.5초: 경합 시 즉시 클릭

  // 첫 번째 좌석 1개에 전원 집중 → 극한 경합
  const seat = available[0];

  holdSeat(baseUrl, seat.seatId, testData.gameId, vuId, iterId, auth);
}

/**
 * 시나리오 E: 이미 점유된 좌석 재시도 (실패 기대)
 */
export function scenarioHoldOccupied(baseUrl, testData, vuId, iterId, auth) {
  const sectionId = pickRandom(testData.sections);
  const seats = browseSeatStatus(baseUrl, testData.gameId, sectionId, auth);

  if (!Array.isArray(seats)) return;

  // HELD 또는 RESERVED 좌석을 의도적으로 시도
  const occupied = seats.filter((s) => s.status === 'HELD' || s.status === 'RESERVED');
  if (occupied.length > 0) {
    const seat = pickRandom(occupied);
    holdSeat(baseUrl, seat.seatId, testData.gameId, vuId, iterId, auth);
  } else {
    // 점유된 좌석 없으면 정상 조회로 fallback
    scenarioBrowse(baseUrl, testData, auth);
  }
}

/**
 * 시나리오 F: HOLD 후 해제 (포기 시뮬레이션)
 */
export function scenarioHoldAndRelease(baseUrl, testData, vuId, iterId, auth) {
  const sectionId = pickRandom(testData.sections);
  const seats = browseSeatStatus(baseUrl, testData.gameId, sectionId, auth);

  if (!Array.isArray(seats)) return;
  const available = seats.filter((s) => s.status === 'AVAILABLE');
  if (available.length === 0) return;

  // 1~4석 점유 후 전부 포기
  const wantCount = randomSeatCount();
  const holdIds = [];
  const shuffled = available.sort(() => Math.random() - 0.5);
  for (let i = 0; i < Math.min(wantCount, shuffled.length); i++) {
    const hid = holdSeat(baseUrl, shuffled[i].seatId, testData.gameId, vuId, iterId, auth);
    if (hid) holdIds.push(hid);
  }
  if (holdIds.length === 0) return;

  // 좌석 고민하다 포기
  thinkSeatSelect();
  for (const hid of holdIds) {
    releaseHold(baseUrl, hid, auth);
  }
}

/**
 * 시나리오 G: 좌석 상태 반복 조회 (실시간 갱신 시뮬레이션)
 */
export function scenarioSeatPolling(baseUrl, testData, auth) {
  const sectionId = pickRandom(testData.sections);
  // 같은 구역 2~3회 조회 (실시간 새로고침 — 다른 사람이 좌석 잡는지 확인)
  const count = Math.floor(Math.random() * 2) + 2;
  for (let i = 0; i < count; i++) {
    browseSeatStatus(baseUrl, testData.gameId, sectionId, auth);
    sleep(Math.random() * 2 + 1); // 1~3초: 새로고침 간격
  }
}

/**
 * 가중치 기반 혼합 시나리오 실행.
 * 하나의 VU iteration에서 랜덤으로 하나의 시나리오를 실행한다.
 */
export function runMixedScenario(baseUrl, testData, vuId, iterId, runnerId) {
  const uniqueId = runnerId * 1000000 + vuId * 10000 + iterId;
  const authResult = signup(baseUrl, uniqueId, runnerId);
  if (!authResult) {
    metrics.ticketSuccess.add(false);
    return;
  }
  const auth = authHeaders(authResult.token);

  const roll = Math.random() * 100;

  // 비율 합계 100% — 예매 성공률 90%+ 목표, 경합 데이터 확보
  if (roll < 25) {
    // 25% 조회 브라우징
    scenarioBrowse(baseUrl, testData, auth);
  } else if (roll < 60) {
    // 35% 정상 예매
    const success = scenarioFullBooking(baseUrl, testData, vuId, iterId, auth);
    metrics.ticketSuccess.add(success);
  } else if (roll < 75) {
    // 15% 좌석 경합 (같은 좌석 1개에 집중 → 극한 경합)
    scenarioSeatContention(baseUrl, testData, vuId, iterId, auth);
  } else if (roll < 80) {
    // 5% 점유된 좌석 재시도
    scenarioHoldOccupied(baseUrl, testData, vuId, iterId, auth);
  } else if (roll < 85) {
    // 5% HOLD 후 해제 (포기)
    scenarioHoldAndRelease(baseUrl, testData, vuId, iterId, auth);
  } else {
    // 15% 좌석 상태 반복 조회 (새로고침)
    scenarioSeatPolling(baseUrl, testData, auth);
  }
  // TODO: 주문 취소 시나리오 — ticketing cancellations 엔드포인트 구현 후 활성화
}

import { post, checkStatus } from './http-client.js';

const tokenCache = {};

/**
 * 테스트 유저 간편 회원가입 + JWT 발급.
 * RUNNER_ID(0~3) × VU ID 조합으로 4명 동시 실행 시 mobile 충돌 방지.
 *
 * mobile 형식: {runnerId:3자리}{uniqueId:8자리} = 11자리
 *   Runner 0: 000XXXXXXXX
 *   Runner 1: 001XXXXXXXX
 *   Runner 2: 002XXXXXXXX
 *   Runner 3: 003XXXXXXXX
 *
 * @returns {{ token: string, userId: string } | null}
 */
export function signup(baseUrl, uniqueId, runnerId = 0) {
  const prefix = String(runnerId).padStart(3, '0');
  const suffix = String(uniqueId).padStart(8, '0');
  const mobile = `${prefix}${suffix}`;

  if (tokenCache[mobile]) {
    return tokenCache[mobile];
  }

  const res = post(`${baseUrl}/api/v1/test/users`, {
    name: `K6-R${runnerId}-${uniqueId}`,
    mobile: mobile,
    gender: 'MALE',
    birthDate: '1990-01-01',
  }, { tags: { name: 'POST /test/users' } });

  if (!checkStatus(res, 200, 'signup')) {
    return null;
  }

  const body = JSON.parse(res.body);
  const data = body.data || body;
  const token = data.accessToken;
  const userId = data.userId;

  if (token) {
    const result = { token, userId: String(userId) };
    tokenCache[mobile] = result;
    return result;
  }
  return null;
}

export function authHeaders(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  };
}

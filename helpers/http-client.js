import http from 'k6/http';
import { check } from 'k6';

const DEFAULT_HEADERS = {
  'Content-Type': 'application/json',
  'Host': 'api.go-ti.shop',
};

function mergeHeaders(extra) {
  return Object.assign({}, DEFAULT_HEADERS, extra);
}

function logFailure(method, url, res) {
  if (res.status >= 400) {
    console.warn(
      `${method} ${url} status=${res.status} body=${res.body ? res.body.substring(0, 200) : 'empty'}`
    );
  }
}

export function get(url, params = {}) {
  const headers = mergeHeaders(params.headers);
  const res = http.get(url, { headers, tags: params.tags });
  logFailure('GET', url, res);
  return res;
}

export function post(url, body, params = {}) {
  const headers = mergeHeaders(params.headers);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const res = http.post(url, payload, { headers, tags: params.tags });
  logFailure('POST', url, res);
  return res;
}

export function put(url, body, params = {}) {
  const headers = mergeHeaders(params.headers);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const res = http.put(url, payload, { headers, tags: params.tags });
  logFailure('PUT', url, res);
  return res;
}

export function patch(url, body, params = {}) {
  const headers = mergeHeaders(params.headers);
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const res = http.patch(url, payload, { headers, tags: params.tags });
  logFailure('PATCH', url, res);
  return res;
}

export function del(url, params = {}) {
  const headers = mergeHeaders(params.headers);
  const res = http.del(url, null, { headers, tags: params.tags });
  logFailure('DELETE', url, res);
  return res;
}

export function checkStatus(res, expectedStatus, name) {
  return check(res, {
    [`${name || 'response'} status is ${expectedStatus}`]: (r) =>
      r.status === expectedStatus,
  });
}

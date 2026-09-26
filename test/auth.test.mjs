import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  timingSafeEqualStr,
  checkCredentials,
  createSession,
  isValidSession,
  destroySession,
  parseCookies,
  isSessionAuthorized,
  SESSION_COOKIE_NAME,
  _resetSessions,
} = require('../server/auth.js');

// --- timingSafeEqualStr ---------------------------------------------------------

test('timingSafeEqualStr: 같은 문자열이면 true', () => {
  assert.equal(timingSafeEqualStr('hunter2', 'hunter2'), true);
});

test('timingSafeEqualStr: 다른 문자열이면 false(길이가 같아도)', () => {
  assert.equal(timingSafeEqualStr('hunter2', 'hunter3'), false);
});

test('timingSafeEqualStr: 길이가 다른 문자열도 안전하게 false(에러 안 던짐)', () => {
  assert.equal(timingSafeEqualStr('short', 'a-much-longer-string'), false);
});

test('timingSafeEqualStr: null/undefined도 빈 문자열처럼 안전하게 처리한다', () => {
  assert.equal(timingSafeEqualStr(null, ''), true);
  assert.equal(timingSafeEqualStr(undefined, 'x'), false);
});

// --- checkCredentials -----------------------------------------------------------

test('checkCredentials: DASHBOARD_PASSWORD가 없으면(설정 안 함) 의도적으로 막는다(fail-closed)', () => {
  const prev = process.env.DASHBOARD_PASSWORD;
  delete process.env.DASHBOARD_PASSWORD;
  try {
    assert.equal(checkCredentials('admin', 'whatever'), false);
  } finally {
    if (prev !== undefined) process.env.DASHBOARD_PASSWORD = prev;
  }
});

test('checkCredentials: 정확한 user/pass면 true', () => {
  process.env.DASHBOARD_USER = 'admin';
  process.env.DASHBOARD_PASSWORD = 'hunter2';
  assert.equal(checkCredentials('admin', 'hunter2'), true);
});

test('checkCredentials: 비밀번호가 틀리면 false', () => {
  process.env.DASHBOARD_USER = 'admin';
  process.env.DASHBOARD_PASSWORD = 'hunter2';
  assert.equal(checkCredentials('admin', 'wrong'), false);
});

test('checkCredentials: DASHBOARD_USER를 안 정해두면 기본값 "admin"을 쓴다', () => {
  delete process.env.DASHBOARD_USER;
  process.env.DASHBOARD_PASSWORD = 'hunter2';
  assert.equal(checkCredentials('admin', 'hunter2'), true);
  assert.equal(checkCredentials('someoneelse', 'hunter2'), false);
});

// --- 세션 -----------------------------------------------------------------------

test('createSession → isValidSession: 방금 만든 세션은 유효하다', () => {
  _resetSessions();
  const id = createSession();
  assert.equal(typeof id, 'string');
  assert.ok(id.length >= 32);
  assert.equal(isValidSession(id), true);
});

test('isValidSession: 존재하지 않는 세션은 false', () => {
  _resetSessions();
  assert.equal(isValidSession('nope-not-a-real-session'), false);
});

test('isValidSession: null/undefined도 안전하게 false', () => {
  assert.equal(isValidSession(null), false);
  assert.equal(isValidSession(undefined), false);
});

test('createSession: 매번 서로 다른(추측 불가능한) 토큰을 만든다', () => {
  _resetSessions();
  const a = createSession();
  const b = createSession();
  assert.notEqual(a, b);
});

test('destroySession: 지운 세션은 더 이상 유효하지 않다', () => {
  _resetSessions();
  const id = createSession();
  assert.equal(isValidSession(id), true);
  destroySession(id);
  assert.equal(isValidSession(id), false);
});

test('destroySession: 없는 세션을 지워도 에러 안 던짐', () => {
  _resetSessions();
  assert.doesNotThrow(() => destroySession('nope'));
  assert.doesNotThrow(() => destroySession(null));
});

// --- parseCookies -----------------------------------------------------------------

test('parseCookies: 여러 쿠키를 정확히 분해한다', () => {
  const r = parseCookies('a=1; b=2; c=3');
  assert.deepEqual(r, { a: '1', b: '2', c: '3' });
});

test('parseCookies: URL 인코딩된 값을 디코딩한다', () => {
  const r = parseCookies(`${SESSION_COOKIE_NAME}=abc%2Ddef`);
  assert.equal(r[SESSION_COOKIE_NAME], 'abc-def');
});

test('parseCookies: 헤더 자체가 없으면 빈 객체', () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(''), {});
});

test('parseCookies: 디코딩 실패해도(깨진 % 시퀀스) 에러 없이 원본값을 쓴다', () => {
  const r = parseCookies('a=%zz');
  assert.equal(r.a, '%zz');
});

// --- isSessionAuthorized (req 객체 기반) --------------------------------------

test('isSessionAuthorized: 유효한 세션 쿠키가 있으면 true', () => {
  _resetSessions();
  const id = createSession();
  const req = { headers: { cookie: `${SESSION_COOKIE_NAME}=${id}` } };
  assert.equal(isSessionAuthorized(req), true);
});

test('isSessionAuthorized: 쿠키 자체가 없으면 false', () => {
  _resetSessions();
  const req = { headers: {} };
  assert.equal(isSessionAuthorized(req), false);
});

test('isSessionAuthorized: 잘못된(존재하지 않는) 세션 값이면 false', () => {
  _resetSessions();
  const req = { headers: { cookie: `${SESSION_COOKIE_NAME}=fake-session-id` } };
  assert.equal(isSessionAuthorized(req), false);
});

test('isSessionAuthorized: 다른 쿠키들 사이에 세션 쿠키가 섞여 있어도 정확히 찾는다', () => {
  _resetSessions();
  const id = createSession();
  const req = { headers: { cookie: `theme=dark; ${SESSION_COOKIE_NAME}=${id}; lang=ko` } };
  assert.equal(isSessionAuthorized(req), true);
});

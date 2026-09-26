'use strict';

// auth.js — 웹 대시보드 접근 제어. 브라우저 기본 Basic Auth 팝업(스타일을 전혀 못
// 바꾸는 허술한 그 창) 대신, 직접 만든 로그인 페이지 + 세션 쿠키 방식을 쓴다.
//
// 흐름: /login에서 아이디·비밀번호를 폼으로 받는다 → 맞으면 무작위 세션 토큰을
// 만들어 메모리에 저장하고 쿠키로 내려준다 → 이후 요청은 그 쿠키만 확인한다.
//
// DASHBOARD_PASSWORD는 .env에 둔다 — 다른 비밀값(BINANCE_API_KEY 등)과 같은 이유다.
// config.json은 HTTP POST로 고칠 수 있는 파일이라, 그 안에 진짜 비밀번호를 두면
// 그 자체가 유출 경로가 된다.
//
// 세션은 서버 메모리에만 둔다(별도 DB 없이) — 개인용 대시보드 하나가 쓰는 거라 이
// 정도로 충분하고, 서버가 재시작되면 다시 로그인해야 하는 정도의 불편은 감수할 만하다.

const crypto = require('crypto');

// 타이밍 공격 방지를 위해 crypto.timingSafeEqual을 쓴다. 두 문자열 길이가 다르면
// (아주 흔한 경우 — 틀린 비밀번호는 길이부터 다를 때가 많다) 그 자체가 타이밍
// 정보로 새지 않도록, 실패하기 전에 같은 길이의 더미 비교를 한 번 거친다.
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bufB = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// user/pass가 DASHBOARD_USER/DASHBOARD_PASSWORD와 일치하는지 확인한다.
// DASHBOARD_PASSWORD가 아예 설정 안 돼 있으면 의도적으로 막는다(fail-closed) —
// "비밀번호를 깜빡 설정 안 해서 보안 기능이 조용히 무력화되는" 상황을 막기 위해서다.
function checkCredentials(user, pass) {
  const expectedUser = process.env.DASHBOARD_USER || 'admin';
  const expectedPass = process.env.DASHBOARD_PASSWORD;
  if (!expectedPass) return false;
  return timingSafeEqualStr(user, expectedUser) && timingSafeEqualStr(pass, expectedPass);
}

// --- 세션 ---------------------------------------------------------------------

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7일 — 매번 다시 로그인하지 않도록 넉넉하게
let sessions = new Map(); // sessionId(무작위 문자열) -> 만료시각(ms)

// 새 세션을 만들고 토큰을 돌려준다. 추측 불가능하도록 32바이트 무작위값을 쓴다.
function createSession() {
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, Date.now() + SESSION_TTL_MS);
  return id;
}

// 세션이 유효한지(존재하고 만료 안 됐는지) 확인한다. 만료됐으면 그 자리에서 지운다.
function isValidSession(sessionId) {
  if (!sessionId) return false;
  const exp = sessions.get(sessionId);
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

function destroySession(sessionId) {
  if (sessionId) sessions.delete(sessionId);
}

// 테스트 전용 — 세션 저장소를 비운다(테스트 간 상태가 새지 않게).
function _resetSessions() {
  sessions = new Map();
}

// Cookie 헤더("a=1; b=2")를 { a:'1', b:'2' } 형태로 파싱한다.
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  String(header)
    .split(';')
    .forEach((part) => {
      const idx = part.indexOf('=');
      if (idx === -1) return;
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (!k) return;
      try {
        out[k] = decodeURIComponent(v);
      } catch (e) {
        out[k] = v;
      }
    });
  return out;
}

const SESSION_COOKIE_NAME = 'ptf_session';

// req의 세션 쿠키가 유효한지 확인한다 — server.js가 라우팅 전에 이걸로 문을 잠근다.
function isSessionAuthorized(req) {
  const cookies = parseCookies(req && req.headers && req.headers.cookie);
  return isValidSession(cookies[SESSION_COOKIE_NAME]);
}

module.exports = {
  SESSION_COOKIE_NAME,
  timingSafeEqualStr,
  checkCredentials,
  createSession,
  isValidSession,
  destroySession,
  parseCookies,
  isSessionAuthorized,
  _resetSessions,
};

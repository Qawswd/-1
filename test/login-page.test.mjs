import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderLoginPage } = require('../server/login-page.js');

test('renderLoginPage: 기본적으로 로그인 폼(user·pass 입력창, 접속 버튼)을 포함한다', () => {
  const html = renderLoginPage({});
  assert.match(html, /<form method="POST" action="\/login">/);
  assert.match(html, /name="username"/);
  assert.match(html, /name="password"/);
  assert.match(html, /접속<\/button>/);
});

test('renderLoginPage: error를 안 주면 에러 메시지 블록이 없다', () => {
  const html = renderLoginPage({});
  assert.ok(!html.includes('class="error"'));
});

test('renderLoginPage: error를 주면 그 메시지가 화면에 나온다', () => {
  const html = renderLoginPage({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  assert.match(html, /class="error"/);
  assert.match(html, /아이디 또는 비밀번호가 올바르지 않습니다\./);
});

test('renderLoginPage: error 메시지에 HTML 특수문자가 있어도 이스케이프된다(XSS 방지)', () => {
  const html = renderLoginPage({ error: '<script>alert(1)</script>' });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('renderLoginPage: redirect 값이 "/"로 시작하면 숨은 필드에 그대로 들어간다', () => {
  const html = renderLoginPage({ redirect: '/stats' });
  assert.match(html, /name="redirect" value="\/stats"/);
});

test('renderLoginPage: redirect가 "/"로 시작하지 않으면(외부 URL 등) 안전하게 "/"로 대체한다', () => {
  const html = renderLoginPage({ redirect: 'https://evil.example.com' });
  assert.match(html, /name="redirect" value="\/"/);
  assert.ok(!html.includes('evil.example.com'));
});

test('renderLoginPage: redirect가 없으면 기본값 "/"를 쓴다', () => {
  const html = renderLoginPage({});
  assert.match(html, /name="redirect" value="\/"/);
});

test('renderLoginPage: 유효한 HTML 문서 골격을 갖춘다', () => {
  const html = renderLoginPage({});
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<html lang="ko">/);
  assert.match(html, /PIXEL TRADING FLOOR/);
});

'use strict';

// login-page.js — 로그인 페이지 HTML을 만든다. "고층 트레이딩 데스크 통유리창 너머로
// 보이는 밤 도시 야경"을 배경으로 하고, 로그인 폼은 그 유리에 비친 듯한 반투명
// 패널(frosted glass)로 띄운다.
//
// 배경은 그림(SVG 일러스트)이 아니라 실제 서울 야경 사진이다 — Unsplash에서
// "Free to use under the Unsplash License"로 명시된 사진(Yohan Cho, 서울)을 쓴다:
// https://unsplash.com/photos/lighted-city-skyline-at-night-Mwvhyd22Lyw
// Unsplash License는 출처 표시 없이 상업적 이용까지 허용한다.
//
// 순수 함수라 서버를 안 띄우고도(에러 문구가 제대로 들어가는지 등) 테스트할 수 있다.

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// error: 로그인 실패 시 보여줄 메시지(없으면 안 보임). redirect: 로그인 성공 후
// 돌아갈 경로(원래 가려던 페이지) — 폼의 숨은 필드로 같이 넘긴다.
function renderLoginPage({ error, redirect } = {}) {
  const safeRedirect = typeof redirect === 'string' && redirect.startsWith('/') ? redirect : '/';
  const errorBlock = error ? `<p class="error" role="alert">${esc(error)}</p>` : '';

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>로그인 · PIXEL TRADING FLOOR</title>
<style>
  :root {
    --glass: rgba(10, 14, 22, 0.42);
    --glass-border: rgba(255, 255, 255, 0.12);
    --text: #eef1f6;
    --text-dim: #c3c9d4;
    --accent: #e0b06a;
    --error: #ff9a90;
  }
  * { box-sizing: border-box; }
  html, body {
    height: 100%;
    margin: 0;
    background: #05070b;
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Pretendard, sans-serif;
  }
  .scene {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 100vh;
    background-image:
      linear-gradient(180deg, rgba(4, 6, 10, 0.35) 0%, rgba(4, 6, 10, 0.15) 35%, rgba(4, 6, 10, 0.75) 100%),
      url('https://images.unsplash.com/photo-1546874177-9e664107314e?auto=format&fit=crop&w=1600&q=75');
    background-size: cover;
    background-position: center 65%;
    background-repeat: no-repeat;
  }
  .frame {
    position: relative;
    height: 100%;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    padding-top: calc(24px + env(safe-area-inset-top, 0px));
    padding-bottom: calc(24px + env(safe-area-inset-bottom, 0px));
  }
  .panel {
    width: 100%;
    max-width: 360px;
    padding: 32px 28px 28px;
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: 16px;
    backdrop-filter: blur(18px) saturate(150%);
    -webkit-backdrop-filter: blur(18px) saturate(150%);
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
  }
  .eyebrow {
    margin: 0 0 6px;
    font-family: 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
    font-size: 11px;
    letter-spacing: 0.08em;
    color: var(--accent);
  }
  h1 {
    margin: 0 0 26px;
    font-size: 21px;
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.3;
    text-shadow: 0 1px 12px rgba(0, 0, 0, 0.4);
  }
  .cursor {
    display: inline-block;
    width: 7px;
    height: 16px;
    margin-left: 3px;
    background: var(--accent);
    vertical-align: -3px;
    animation: blink 1.1s steps(1) infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
  .field { margin-bottom: 16px; }
  label {
    display: block;
    margin-bottom: 7px;
    font-size: 12.5px;
    color: var(--text-dim);
  }
  input {
    width: 100%;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.14);
    border-radius: 8px;
    color: var(--text);
    font-family: inherit;
    font-size: 15px;
    padding: 11px 13px;
  }
  input::placeholder { color: rgba(195, 201, 212, 0.55); }
  input:focus {
    outline: none;
    border-color: var(--accent);
    background: rgba(0, 0, 0, 0.42);
  }
  button {
    width: 100%;
    margin-top: 10px;
    padding: 12px;
    background: var(--accent);
    color: #241a08;
    border: none;
    border-radius: 8px;
    font-family: inherit;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: filter 0.15s ease;
  }
  button:hover { filter: brightness(1.08); }
  button:active { filter: brightness(0.94); }
  .meta {
    margin: 18px 0 0;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--text-dim);
  }
  .meta .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); opacity: 0.85; }
  .error {
    margin: 16px 0 0;
    padding: 10px 12px;
    background: rgba(255, 154, 144, 0.14);
    border: 1px solid rgba(255, 154, 144, 0.4);
    border-radius: 8px;
    color: var(--error);
    font-size: 13px;
  }
  @media (prefers-reduced-motion: reduce) {
    .cursor { animation: none; }
  }
</style>
</head>
<body>
  <div class="scene">
    <div class="frame">
      <div class="panel">
        <p class="eyebrow">PIXEL TRADING FLOOR</p>
        <h1>보안 접속<span class="cursor"></span></h1>
        <form method="POST" action="/login">
          <input type="hidden" name="redirect" value="${esc(safeRedirect)}">
          <div class="field">
            <label for="username">아이디</label>
            <input id="username" name="username" type="text" autocomplete="username" autofocus required>
          </div>
          <div class="field">
            <label for="password">비밀번호</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required>
          </div>
          <button type="submit">접속</button>
        </form>
        ${errorBlock}
        <p class="meta"><span class="dot"></span>암호화된 세션으로 연결됩니다</p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

module.exports = { renderLoginPage };

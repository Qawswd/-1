#!/usr/bin/env node
// 뉴스 소스 후보가 서버에서 실제로 열리는지 확인한다(읽기 전용, 10/13 안건 ③).
// CLAUDE.md: 새 소스를 붙이기 전에 실제 응답을 확인한다. 주소가 틀렸으면 그대로 실패로 찍힌다.
//   node ops/news-probe.js
'use strict';

const CANDIDATES = [
  ['코인니스', 'https://coinness.com/rss'],
  ['코인니스', 'https://coinness.com/feed'],
  ['코인니스', 'https://api.coinness.com/feed/v1/news'],
  ['코인니스', 'https://coinness.com/'],
  ['블록미디어', 'https://www.blockmedia.co.kr/feed'],
  ['토큰포스트', 'https://www.tokenpost.kr/rss'],
  ['코인데스크', 'https://www.coindesk.com/arc/outboundfeeds/rss/'],
  ['코인텔레그래프', 'https://cointelegraph.com/rss'],
];

function firstTitle(body) {
  const m = body.match(/<item[\s\S]*?<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
  return m ? m[1].trim().slice(0, 60) : null;
}

async function probe(name, url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; trading-floor-probe)' },
    });
    const type = (res.headers.get('content-type') || '').split(';')[0];
    const body = await res.text();
    const items = (body.match(/<item[\s>]/gi) || []).length;
    let kind = '';
    if (items) kind = `RSS ${items}건 · 첫 제목: ${firstTitle(body) || '-'}`;
    else if (/json/.test(type)) kind = `JSON ${body.length}자`;
    else if (/<rss|<feed/i.test(body)) kind = 'RSS(항목 0)';
    else kind = `${body.length}자 · 피드 아님`;
    console.log(`${res.ok ? 'OK ' : 'NO '} ${res.status} ${name.padEnd(7)} ${url}\n      ${type || '-'} · ${kind}`);
  } catch (e) {
    console.log(`ERR ${name.padEnd(7)} ${url}\n      ${e.name === 'AbortError' ? '10초 시간 초과' : e.message}`);
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  console.log('── 뉴스 소스 점검 ──');
  for (const [name, url] of CANDIDATES) await probe(name, url);
})();

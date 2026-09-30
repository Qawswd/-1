import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// agents.js는 CommonJS(module.exports)이므로 ESM 테스트에서 createRequire로 로드한다.
const require = createRequire(import.meta.url);
const { AGENTS, extractJson, runAgent, buildPrompt, resolvePositionConflict, buildConflictPrompt, reviewPositionForExit, buildPositionReviewPrompt, parseSessionLimitResetTime, isSessionLimitOutput, isSessionLimitResponse, diagnose, parseClaudeCliOutput, _setSpawnImpl } = require('../server/agents.js');

// ---------------------------------------------------------------------------
// AGENTS 메타
// ---------------------------------------------------------------------------
test('AGENTS: 12종 id·순서·필드 존재', () => {
  const ids = AGENTS.map((a) => a.id);
  assert.deepEqual(ids, [
    'taro',
    'diana',
    'nova',
    'vibe',
    'research',
    'bull',
    'bear',
    'risky',
    'neutral',
    'safe',
    'ace',
    'pm',
  ]);
  for (const a of AGENTS) {
    assert.ok(typeof a.name === 'string' && a.name === a.name.toUpperCase(), `${a.id} name 대문자`);
    assert.ok(typeof a.nameKo === 'string' && a.nameKo.length > 0, `${a.id} nameKo`);
    assert.ok(typeof a.role === 'string' && a.role.length > 0, `${a.id} role`);
    assert.ok(typeof a.roomKo === 'string' && a.roomKo.length > 0, `${a.id} roomKo`);
  }
});

// ---------------------------------------------------------------------------
// extractJson 3케이스
// ---------------------------------------------------------------------------
test('extractJson: 정상 JSON', () => {
  const r = extractJson('{"bubble":"안녕하세요","report":"상세 리포트"}');
  assert.equal(r.bubble, '안녕하세요');
  assert.equal(r.report, '상세 리포트');
});

test('extractJson: 앞뒤 잡문 섞임', () => {
  const raw = '분석 결과입니다:\n```json\n{"action":"BUY","confidence":80,"bubble":"매수"}\n```\n이상입니다.';
  const r = extractJson(raw);
  assert.equal(r.action, 'BUY');
  assert.equal(r.confidence, 80);
  assert.equal(r.bubble, '매수');
});

test('extractJson: 불량 → null', () => {
  assert.equal(extractJson('그냥 평문이고 JSON은 없습니다'), null);
  assert.equal(extractJson('{망가진 json 없음'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
});

// ---------------------------------------------------------------------------
// mock runAgent — 9개 id 전부 bubble·report 반환
// ---------------------------------------------------------------------------
const mockContext = {
  market: {
    kind: 'crypto',
    symbol: 'BTCUSDT',
    display: 'BTC',
    candles: [],
    indicators: { price: 60000, summaryLines: ['가격 60000', 'RSI 55'] },
    fundamentals: { lines: ['시총 1위'] },
    news: { headlines: [{ title: 'BTC 관련 뉴스', age: '1시간 전' }] },
    sentiment: { lines: ['공포탐욕지수 70'] },
    priceLine: 'BTC $60,000 (+1.2%)',
  },
  analystReports: {
    taro: '기술적으로 지지 확인',
    diana: '펀더멘털 양호',
    nova: '뉴스 혼조',
    vibe: '심리 과열',
  },
  debateLog: [{ id: 'bull', bubble: '매수 유효', report: '상방 여력 큼' }],
};

test('mock runAgent: 12개 id 전부 bubble·긴 report 존재', async () => {
  for (const a of AGENTS) {
    const res = await runAgent(a.id, mockContext, { mock: true });
    assert.ok(typeof res.bubble === 'string' && res.bubble.length > 0, `${a.id} bubble`);
    assert.ok(typeof res.report === 'string' && res.report.length > 0, `${a.id} report`);
    // 데모가 실제 연출의 기준이므로 브리핑 분량(200자 이상)을 강제한다
    assert.ok(res.report.length >= 200, `${a.id} report 분량(${res.report.length}자)`);
  }
});

test('mock runAgent: pm에 verdict·sizing 존재', async () => {
  const res = await runAgent('pm', { ...mockContext, traderPlan: { action: 'BUY', confidence: 60 } }, { mock: true });
  assert.ok(['APPROVE', 'AMEND', 'REJECT'].includes(res.verdict), 'verdict 값');
  assert.ok(['BUY', 'SELL', 'HOLD'].includes(res.action), 'action 값');
  assert.equal(typeof res.confidence, 'number');
  assert.ok(typeof res.sizing === 'string' && res.sizing.length > 0, 'sizing');
  assert.ok(typeof res.rationale === 'string' && res.rationale.length > 0, 'rationale');
});

// ---------------------------------------------------------------------------
// buildPrompt — 신규 역할에 traderPlan·riskReports·memory가 실제로 주입되는지
// ---------------------------------------------------------------------------
test('buildPrompt: risky에 traderPlan과 앞선 리스크 의견이 주입된다', () => {
  const p = buildPrompt('risky', {
    ...mockContext,
    traderPlan: { action: 'BUY', confidence: 61, entry: '지지 확인 후', stop: '저점 이탈', target: '저항' },
    riskReports: { safe: '비중을 줄여야 한다' },
  });
  assert.ok(p.includes('1차 계획'), 'traderPlan 섹션');
  assert.ok(p.includes('확신도: 61%'), '계획 수치');
  assert.ok(p.includes('앞선 리스크 심사 의견'), '앞선 의견 섹션');
  assert.ok(p.includes('비중을 줄여야 한다'), 'safe 의견 본문');
  assert.ok(p.includes('청산'), '청산 경고 지시');
});

test('buildPrompt: pm에 riskReports 3인과 memory가 주입되고 PM 출력 규칙이 붙는다', () => {
  const p = buildPrompt('pm', {
    ...mockContext,
    traderPlan: { action: 'HOLD', confidence: 55 },
    riskReports: { risky: '더 실어라', safe: '줄여라', neutral: '조건부' },
    memory: ['2026-07-28 HOLD(62%) → 이후 3일간 -4.1%'],
  });
  assert.ok(p.includes('리스크 위원회 심사 의견'), '리스크 섹션');
  assert.ok(p.includes('더 실어라') && p.includes('줄여라') && p.includes('조건부'), '3인 의견 본문');
  assert.ok(p.includes('과거 판정 회고'), 'memory 섹션');
  assert.ok(p.includes('이후 3일간 -4.1%'), 'memory 본문');
  assert.ok(p.includes('APPROVE|AMEND|REJECT'), 'PM 출력 규칙');
  assert.ok(p.includes('sizing'), 'sizing 요구');
});

test('buildPrompt: memory가 없으면 회고 섹션을 넣지 않는다', () => {
  const p = buildPrompt('ace', mockContext);
  assert.ok(!p.includes('과거 판정 회고'), '회고 섹션 없음');
});

test('buildPrompt: 뒷단계가 report를 읽는 역할(애널리스트·토론·리스크위원회)은 150~250자 브리핑 규칙을 받는다', () => {
  for (const id of ['taro', 'diana', 'nova', 'vibe', 'bull', 'bear', 'risky', 'safe', 'neutral']) {
    const p = buildPrompt(id, { ...mockContext, traderPlan: { action: 'BUY' } });
    assert.ok(p.includes('3~5문장'), `${id} 브리핑 분량 규칙`);
    assert.ok(p.includes('150~250자'), `${id} 브리핑 글자수 상한`);
    assert.ok(!p.includes('40자 이내'), `${id}는 최소 리포트 규칙을 받으면 안 된다`);
  }
});

test('buildPrompt: report를 아무도 안 읽는 역할(ACE·PM)은 최소 리포트 규칙을 받는다', () => {
  for (const id of ['ace', 'pm']) {
    const p = buildPrompt(id, { ...mockContext, traderPlan: { action: 'BUY' } });
    assert.ok(p.includes('40자 이내'), `${id} 최소 리포트 규칙`);
    assert.ok(!p.includes('150~250자'), `${id}는 긴 브리핑 규칙을 받으면 안 된다`);
  }
});

test('buildPrompt: ACE·PM은 리포트가 짧아져도 판단 필드(entry·stop·target·rationale)는 그대로 요구된다(분석 유지)', () => {
  for (const id of ['ace', 'pm']) {
    const p = buildPrompt(id, { ...mockContext, traderPlan: { action: 'BUY' } });
    for (const field of ['"action"', '"confidence"', '"entry"', '"stop"', '"target"', '"rationale"']) {
      assert.ok(p.includes(field), `${id} ${field} 요구`);
    }
    assert.match(p, /분석 자체를 생략하지 마라/);
  }
});

test('buildPrompt: PM 근거에는 판단이 바뀌는 트리거를 반드시 포함하라고 요구한다(익절 검토 AI가 참고하는 값)', () => {
  const p = buildPrompt('pm', { ...mockContext, traderPlan: { action: 'BUY' } });
  assert.match(p, /판단이 바뀌는 트리거\(가격 레벨\)를 반드시 포함/);
});

test('buildPrompt: 어떤 역할에도 옛 "8~14문장" 지시가 남아있지 않다(회귀 방지)', () => {
  for (const a of AGENTS) {
    const p = buildPrompt(a.id, { ...mockContext, traderPlan: { action: 'BUY' } });
    assert.ok(!p.includes('8~14문장'), `${a.id}에 옛 분량 지시가 남아있음`);
  }
});

test('mock runAgent: ace에 action·부가 필드 존재 (scalp 필드는 1배 고정 이후 폐지)', async () => {
  const res = await runAgent('ace', mockContext, { mock: true });
  assert.ok(['BUY', 'SELL', 'HOLD'].includes(res.action), 'action 값');
  assert.equal(typeof res.confidence, 'number');
  assert.ok(typeof res.entry === 'string' && res.entry.length > 0, 'entry');
  assert.ok(typeof res.stop === 'string' && res.stop.length > 0, 'stop');
  assert.ok(typeof res.target === 'string' && res.target.length > 0, 'target');
  assert.ok(typeof res.rationale === 'string' && res.rationale.length > 0, 'rationale');
  assert.equal(res.scalp, undefined, '레버리지 1배 고정 이후 scalp 필드는 더 이상 없어야 한다');
});

// ---------------------------------------------------------------------------
// resolvePositionConflict — 12명 로스터와 별개의 경량 판단. AGENTS 배열에는 없다.
// ---------------------------------------------------------------------------

test('AGENTS 목록에 conflict-resolver는 없다(화면에 13번째 캐릭터가 생기면 안 됨)', () => {
  assert.ok(!AGENTS.some((a) => a.id === 'conflict-resolver' || a.id === 'conflict'));
});

test('buildConflictPrompt: 기존 포지션·새 판정 정보가 프롬프트에 다 들어간다', () => {
  const prompt = buildConflictPrompt({
    symbol: 'BTCUSDT',
    display: 'BTC',
    existing: { side: 'SHORT', entry: 76500, markPrice: 77000, unrealizedPct: -0.65, confidence: 58 },
    incoming: { side: 'BUY', entry: 77000, stop: 75500, target: 79500, confidence: 62, rationale: '지지선 반등' },
  });
  assert.match(prompt, /SHORT/);
  assert.match(prompt, /76500/);
  assert.match(prompt, /BUY/);
  assert.match(prompt, /지지선 반등/);
  assert.match(prompt, /SWITCH/);
  assert.match(prompt, /KEEP/);
});

test('resolvePositionConflict(mock): 같은 방향이면 항상 KEEP', async () => {
  const res = await resolvePositionConflict(
    {
      symbol: 'BTCUSDT',
      existing: { side: 'LONG', entry: 100, confidence: 55 },
      incoming: { side: 'BUY', entry: 105, stop: 100, target: 115, confidence: 60 },
    },
    { mock: true }
  );
  assert.equal(res.action, 'KEEP');
  assert.ok(typeof res.reasoning === 'string' && res.reasoning.length > 0);
});

test('resolvePositionConflict(mock): 반대 방향이어도 mock 기본값은 KEEP(보수적 기본값 확인)', async () => {
  const res = await resolvePositionConflict(
    {
      symbol: 'BTCUSDT',
      existing: { side: 'SHORT', entry: 100, confidence: 55 },
      incoming: { side: 'BUY', entry: 95, stop: 90, target: 110, confidence: 58 },
    },
    { mock: true }
  );
  assert.equal(res.action, 'KEEP');
});

test('resolvePositionConflict(mock): bubble/report 필드도 정상 채워진다(normalizeResult 경유 확인)', async () => {
  const res = await resolvePositionConflict(
    { symbol: 'BTCUSDT', existing: { side: 'LONG', entry: 100 }, incoming: { side: 'BUY', entry: 105, stop: 100, target: 115, confidence: 60 } },
    { mock: true }
  );
  assert.equal(typeof res.bubble, 'string');
  assert.equal(typeof res.report, 'string');
});

// ---------------------------------------------------------------------------
// reviewPositionForExit — 포지션 청산 검토(익절/손절선 조정). AGENTS 배열에는 없다.
// ---------------------------------------------------------------------------

test('AGENTS 목록에 position-review도 없다(화면에 캐릭터가 늘어나면 안 됨)', () => {
  assert.ok(!AGENTS.some((a) => a.id === 'position-review'));
});

test('buildPositionReviewPrompt: 포지션 정보·트리거가 프롬프트에 다 들어간다', () => {
  const prompt = buildPositionReviewPrompt({
    symbol: 'BTCUSDT',
    display: 'BTC',
    existing: { side: 'LONG', entry: 76500, markPrice: 81000, unrealizedPct: 5.9, originalTarget: 84000, originalStop: 74000 },
    trigger: '15분 +2.1% 급등',
  });
  assert.match(prompt, /LONG/);
  assert.match(prompt, /76500/);
  assert.match(prompt, /84000/);
  assert.match(prompt, /15분 \+2\.1% 급등/);
  assert.match(prompt, /KEEP/);
  assert.match(prompt, /EXIT/);
  assert.match(prompt, /TIGHTEN_STOP/);
});

test('buildPositionReviewPrompt: 원래 판정 근거(originalRationale)가 있으면 프롬프트에 그대로 들어간다', () => {
  const prompt = buildPositionReviewPrompt({
    symbol: 'BTCUSDT',
    display: 'BTC',
    existing: { side: 'LONG', entry: 76500, originalRationale: '82,300 종가 돌파 시 상승 재개, 80,000 반납 시 강세 철회' },
    trigger: 'x',
  });
  assert.match(prompt, /82,300 종가 돌파 시 상승 재개/);
  assert.match(prompt, /아직 유효한가/);
});

test('buildPositionReviewPrompt: originalRationale이 없으면 그 섹션 자체를 안 넣는다(없는 걸 지어내지 않음)', () => {
  const prompt = buildPositionReviewPrompt({
    symbol: 'BTCUSDT',
    existing: { side: 'LONG', entry: 100 },
    trigger: 'x',
  });
  assert.ok(!prompt.includes('원래 이 포지션에 들어간 근거'));
});

test('buildPositionReviewPrompt: indicatorLines가 있으면 기술 지표 섹션이 들어간다', () => {
  const prompt = buildPositionReviewPrompt({
    symbol: 'BTCUSDT',
    existing: { side: 'LONG', entry: 100 },
    trigger: 'x',
    indicatorLines: ['SMA20 78,344 — 가격은 SMA20 위(강세)', 'RSI14 64.4 (중립)'],
  });
  assert.match(prompt, /SMA20 78,344/);
  assert.match(prompt, /RSI14 64\.4/);
});

test('reviewPositionForExit(mock): 기본값은 KEEP', async () => {
  const res = await reviewPositionForExit(
    { symbol: 'BTCUSDT', existing: { side: 'LONG', entry: 100, unrealizedPct: 5 }, trigger: 'x' },
    { mock: true }
  );
  assert.equal(res.action, 'KEEP');
  assert.equal(res.newStopPrice, null);
  assert.ok(typeof res.reasoning === 'string' && res.reasoning.length > 0);
});

test('reviewPositionForExit(mock): bubble/report 필드도 채워진다(normalizeResult 경유 확인)', async () => {
  const res = await reviewPositionForExit(
    { symbol: 'BTCUSDT', existing: { side: 'LONG', entry: 100 }, trigger: 'x' },
    { mock: true }
  );
  assert.equal(typeof res.bubble, 'string');
  assert.equal(typeof res.report, 'string');
});

// --- NOVA 프롬프트에 경제지표 발표 일정(FRED) 포함 여부 -----------------------------

test('buildPrompt: nova에 economicCalendar가 있으면 프롬프트에 포함된다', () => {
  const p = buildPrompt('nova', {
    ...mockContext,
    market: { ...mockContext.market, economicCalendar: { lines: ['2026-09-25(4일 후) — FOMC 금리결정'] } },
  });
  assert.match(p, /앞으로 예정된 주요 경제지표 발표/);
  assert.match(p, /FOMC 금리결정/);
});

test('buildPrompt: nova에 economicCalendar가 없으면(설정 전 등) 그 섹션 자체를 안 넣는다', () => {
  const p = buildPrompt('nova', mockContext); // mockContext엔 economicCalendar 없음
  assert.ok(!p.includes('앞으로 예정된 주요 경제지표 발표'));
});

// --- parseSessionLimitResetTime (한도 소진 리셋 시각 파싱) --------------------------

test('parseSessionLimitResetTime: "6:30pm (UTC)"을 오늘 18:30 UTC로 정확히 파싱한다', () => {
  const now = Date.parse('2026-09-22T14:00:00Z');
  const r = parseSessionLimitResetTime("You've hit your session limit · resets 6:30pm (UTC)", now);
  assert.equal(new Date(r).toISOString(), '2026-09-22T18:30:00.000Z');
});

test('parseSessionLimitResetTime: 리셋 시각이 이미 지났으면(예: 자정 넘어 리셋) 내일로 해석한다', () => {
  const now = Date.parse('2026-09-22T14:00:00Z');
  const r = parseSessionLimitResetTime('resets 1:00am (UTC)', now);
  assert.equal(new Date(r).toISOString(), '2026-09-23T01:00:00.000Z');
});

test('parseSessionLimitResetTime: 12:00pm(정오)·12:00am(자정) 12시간제 경계를 정확히 처리한다', () => {
  const noon = parseSessionLimitResetTime('resets 12:00pm (UTC)', Date.parse('2026-09-22T14:00:00Z'));
  assert.equal(new Date(noon).toISOString(), '2026-09-23T12:00:00.000Z'); // 이미 지났으니 내일 정오
  const midnight = parseSessionLimitResetTime('resets 12:00am (UTC)', Date.parse('2026-09-22T01:00:00Z'));
  assert.equal(new Date(midnight).toISOString(), '2026-09-23T00:00:00.000Z');
});

test('parseSessionLimitResetTime: 패턴이 안 맞으면(다른 종류의 에러 등) null — 지어내지 않는다', () => {
  assert.equal(parseSessionLimitResetTime('아무 상관 없는 에러 메시지', Date.now()), null);
  assert.equal(parseSessionLimitResetTime('', Date.now()), null);
  assert.equal(parseSessionLimitResetTime(null, Date.now()), null);
});

// --- diagnose: "session limit" 문구 수정 회귀 방지 ---------------------------------

test('diagnose: "session limit" 문구를 정확히 한도 문제로 진단한다(실전 2026-09-22 발견 버그 회귀 방지)', () => {
  const hint = diagnose({ stdout: "You've hit your session limit · resets 6:30pm (UTC)", stderr: '', code: 1, timedOut: false });
  assert.match(hint, /사용량 한도/);
  assert.ok(!hint.includes('JSON 형식')); // 예전엔 이 엉뚱한 진단으로 빠졌었다
});

test('diagnose: 기존 "usage limit"·"rate limit"·"한도" 문구도 여전히 정확히 감지한다(회귀 방지)', () => {
  assert.match(diagnose({ stdout: 'usage limit exceeded', code: 1 }), /사용량 한도/);
  assert.match(diagnose({ stdout: 'rate limit hit', code: 1 }), /사용량 한도/);
  assert.match(diagnose({ stdout: '한도를 초과했습니다', code: 1 }), /사용량 한도/);
});

// --- parseClaudeCliOutput (--output-format json 겉포장 벗기기, 토큰 사용량 추적용) ----

test('parseClaudeCliOutput: 정상적인 겉포장 JSON에서 result·사용량·비용을 정확히 분리한다', () => {
  const stdout = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: '{"action":"BUY","bubble":"매수"}',
    total_cost_usd: 0.0123,
    usage: { input_tokens: 1500, output_tokens: 800 },
  });
  const r = parseClaudeCliOutput(stdout);
  assert.equal(r.isWrapperFormat, true);
  assert.equal(r.innerText, '{"action":"BUY","bubble":"매수"}');
  assert.equal(r.costUsd, 0.0123);
  assert.equal(r.usage.inputTokens, 1500);
  assert.equal(r.usage.outputTokens, 800);
});

test('parseClaudeCliOutput: 겉포장 파싱 자체가 안 되면(구버전 CLI 등) 원본을 innerText로 그대로 돌려준다(핵심 파이프라인이 안 끊기게)', () => {
  const rawText = '어쩌다 텍스트 모드로 나온 순수 응답 {"action":"HOLD"}';
  const r = parseClaudeCliOutput(rawText);
  assert.equal(r.isWrapperFormat, false);
  assert.equal(r.innerText, rawText);
  assert.equal(r.costUsd, null);
  assert.equal(r.usage, null);
});

test('parseClaudeCliOutput: JSON이긴 한데 result 필드가 없으면(다른 종류의 JSON) 원본을 그대로 쓴다', () => {
  const stdout = JSON.stringify({ foo: 'bar' });
  const r = parseClaudeCliOutput(stdout);
  assert.equal(r.isWrapperFormat, false);
  assert.equal(r.innerText, stdout);
});

test('parseClaudeCliOutput: usage 필드가 없어도 에러 없이 usage:null, costUsd는 있으면 그대로', () => {
  const stdout = JSON.stringify({ result: '{"action":"HOLD"}', total_cost_usd: 0.05 });
  const r = parseClaudeCliOutput(stdout);
  assert.equal(r.usage, null);
  assert.equal(r.costUsd, 0.05);
});

test('parseClaudeCliOutput: 빈 문자열/null도 에러 없이 안전하게 처리한다', () => {
  assert.equal(parseClaudeCliOutput('').isWrapperFormat, false);
  assert.equal(parseClaudeCliOutput(null).innerText, '');
});

test('parseClaudeCliOutput: 입력 토큰은 캐시 항목(cache_read·cache_creation)까지 합산한다(실측 32개 버그 회귀 방지)', () => {
  const stdout = JSON.stringify({
    result: '{"action":"HOLD"}',
    total_cost_usd: 0.3,
    usage: { input_tokens: 32, cache_read_input_tokens: 15000, cache_creation_input_tokens: 5000, output_tokens: 900 },
  });
  const r = parseClaudeCliOutput(stdout);
  assert.equal(r.usage.inputTokens, 20032);
  assert.equal(r.usage.outputTokens, 900);
});

// --- 한도 실패 재시도 금지 · 리셋 시각 문구 확장 (docs/03-POSTMORTEM.md 원인 1) --------

test('parseSessionLimitResetTime: 실측 문구 "resets 6:40pm (UTC)" · "11:30pm (UTC)" 를 읽는다', () => {
  const now = Date.parse('2026-09-22T14:00:00Z');
  assert.equal(
    new Date(parseSessionLimitResetTime("You've hit your session limit · resets 6:40pm (UTC)", now)).toISOString(),
    '2026-09-22T18:40:00.000Z'
  );
  assert.equal(
    new Date(parseSessionLimitResetTime("You've hit your session limit · resets 11:30pm (UTC)", now)).toISOString(),
    '2026-09-22T23:30:00.000Z'
  );
});

test('parseSessionLimitResetTime: 분 없는 "12am (Asia/Seoul)" 를 한국 자정 = 15:00 UTC 로 읽는다', () => {
  const now = Date.parse('2026-09-22T10:00:00Z'); // 한국 19:00
  const r = parseSessionLimitResetTime("You've hit your session limit · resets 12am (Asia/Seoul)", now);
  assert.equal(new Date(r).toISOString(), '2026-09-22T15:00:00.000Z');
  // 이미 한국 자정을 넘긴 시각이면 다음 자정
  const r2 = parseSessionLimitResetTime('resets 12am (Asia/Seoul)', Date.parse('2026-09-22T16:00:00Z'));
  assert.equal(new Date(r2).toISOString(), '2026-09-23T15:00:00.000Z');
});

test('isSessionLimitOutput: 한도 문구만 true', () => {
  assert.equal(isSessionLimitOutput("You've hit your session limit · resets 6:40pm (UTC)"), true);
  assert.equal(isSessionLimitOutput('usage limit exceeded'), true);
  assert.equal(isSessionLimitOutput('{"bubble":"ok","report":"..."}'), false);
  assert.equal(isSessionLimitOutput(''), false);
});

test('runAgent(실전): 한도 문구를 받으면 재시도하지 않고 1회로 끝내며 리셋 시각을 싣는다', async () => {
  let calls = 0;
  _setSpawnImpl(async () => {
    calls += 1;
    return { stdout: "You've hit your session limit · resets 6:40pm (UTC)", stderr: '', code: 1, timedOut: false };
  });
  try {
    const res = await runAgent('taro', mockContext, { mock: false });
    assert.equal(calls, 1, '한도 실패는 재시도하지 않는다');
    assert.match(res.report, /사용량 한도/);
    assert.ok(Number.isFinite(res.quotaExhaustedUntil), '리셋 시각(epoch ms)을 싣는다');
  } finally {
    _setSpawnImpl();
  }
});

test('runAgent(실전): 한도가 아닌 일반 파싱 실패는 기존대로 1회 재시도한다(최대 2회)', async () => {
  let calls = 0;
  _setSpawnImpl(async () => {
    calls += 1;
    return { stdout: 'not json at all', stderr: '', code: 0, timedOut: false };
  });
  try {
    const res = await runAgent('taro', mockContext, { mock: false });
    assert.equal(calls, 2);
    assert.equal(res.quotaExhaustedUntil, null);
  } finally {
    _setSpawnImpl();
  }
});

// --- 실측 한도 응답(2026-09-26 Lightsail): JSON 겉포장 · is_error · 429 · 종료코드 0 ---------

const LIMIT_WRAPPER_STDOUT =
  '{"duration_api_ms":0,"stop_reason":"stop_sequence","session_id":"7c9e646d","total_cost_usd":0,' +
  '"usage":{"input_tokens":0,"output_tokens":0},"modelUsage":{},"permission_denials":[],' +
  '"terminal_reason":"api_error","is_error":true,"num_turns":1,"subtype":"success","api_error_status":429,' +
  '"result":"You\'ve hit your session limit · resets 8pm (Asia/Seoul)","type":"result","duration_ms":1192}';

test('parseClaudeCliOutput: 실측 한도 겉포장에서 isError·apiErrorStatus 429·본문 문구를 뽑는다', () => {
  const p = parseClaudeCliOutput(LIMIT_WRAPPER_STDOUT);
  assert.equal(p.isWrapperFormat, true);
  assert.equal(p.isError, true);
  assert.equal(p.apiErrorStatus, 429);
  assert.match(p.innerText, /session limit/);
  // 정상 응답은 isError false · apiErrorStatus null
  const ok = parseClaudeCliOutput('{"result":"{\\"bubble\\":\\"x\\",\\"report\\":\\"y\\"}","total_cost_usd":0.01,"usage":{"output_tokens":5}}');
  assert.equal(ok.isError, false);
  assert.equal(ok.apiErrorStatus, null);
});

test('runAgent(실전): 실측 한도 겉포장(종료코드 0)도 재시도 없이 1회로 끝내고 한국 20:00 리셋 시각을 싣는다', async () => {
  let calls = 0;
  _setSpawnImpl(async () => {
    calls += 1;
    return { stdout: LIMIT_WRAPPER_STDOUT, stderr: '', code: 0, timedOut: false };
  });
  try {
    const res = await runAgent('taro', mockContext, { mock: false });
    assert.equal(calls, 1);
    assert.match(res.report, /사용량 한도/);
    assert.ok(res.quotaExhaustedUntil > Date.now(), '리셋 시각은 미래');
    const seoul = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hourCycle: 'h23', hour: '2-digit', minute: '2-digit' })
      .format(new Date(res.quotaExhaustedUntil));
    assert.equal(seoul, '20:00', '한국 시간 20:00 으로 해석');
  } finally {
    _setSpawnImpl();
  }
});

test('isSessionLimitResponse: 문구 없이 429 만 있어도 한도로 본다', () => {
  const p = { isError: true, apiErrorStatus: 429 };
  assert.equal(isSessionLimitResponse({ stdout: '{"result":""}', stderr: '' }, p), true);
  assert.equal(isSessionLimitResponse({ stdout: 'plain text', stderr: '' }, { isError: false, apiErrorStatus: null }), false);
});

test('buildPrompt(taro): market.mtf 가 있으면 상위 시간대 블록이 프롬프트에 들어간다', () => {
  const ctx = { ...mockContext, market: { ...mockContext.market, mtf: { lines: ['1시간봉: SMA20 위 · RSI 55', '추세 정렬: 전 시간대 상승 정렬'], trend: {} } } };
  const p = buildPrompt('taro', ctx);
  assert.match(p, /상위 시간대 — 1시간·4시간·일봉 정렬/);
  assert.match(p, /전 시간대 상승 정렬/);
  assert.doesNotMatch(buildPrompt('taro', mockContext), /상위 시간대/);
});

test('최종 판정 프롬프트: confidence 를 "익절이 손절보다 먼저 닿을 확률"로 정의한다', () => {
  const src = require('node:fs').readFileSync(new URL('../server/agents.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /"confidence":0-100 사이 정수/);
  assert.match(src, /\[확신도 정의\]/);
});

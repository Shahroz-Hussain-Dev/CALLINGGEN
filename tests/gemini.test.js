'use strict';
/** Unit tests for the Gemini provider using a fake HTTP layer (no network). */
process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'AIzaFAKEKEY000000000000000000000000000';
process.env.GEMINI_MODEL = 'gemini-test-pro';
process.env.GEMINI_FALLBACK_MODELS = 'gemini-test-flash,gemini-test-lite';
process.env.GEMINI_MAX_RETRIES = '1';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const gemini = require('../server/services/gemini.service');
const config = require('../server/config');
const apiKeys = require('../server/services/apiKeys.service');
require('../server/services/settings.service').getWebSearchKeys = async () => ({}); // no database in these unit tests

function textResponse(text, extra = {}) {
  return { candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP', ...extra }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 }, modelVersion: 'x' };
}
function fakeFetch(handler) {
  const calls = [];
  gemini.setFetchForTests(async (url, opts) => {
    const model = /models\/([^:]+):generateContent/.exec(url)[1];
    const body = JSON.parse(opts.body);
    calls.push({ model, body });
    const r = await handler({ model, body, n: calls.length });
    const status = r.status || 200;
    return { ok: status < 400, status, text: async () => JSON.stringify(r.json) };
  });
  return calls;
}
const serverKey = async () => ({ apiKey: 'k', source: 'server' });
beforeEach(() => gemini.resetQuotaMemoryForTests());

test('schema conversion turns anyOf-null into nullable and drops unsupported keywords', () => {
  const s = gemini.toGeminiSchema({ type: 'object', additionalProperties: false, required: ['a', 'b'], properties: { a: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'd' }, b: { type: 'array', items: { type: 'string', enum: ['x', 'y'] } } } });
  assert.deepEqual(s.properties.a, { type: 'string', description: 'd', nullable: true });
  assert.equal(s.additionalProperties, undefined);
  assert.deepEqual(s.propertyOrdering, ['a', 'b']);
  assert.deepEqual(s.properties.b.items.enum, ['x', 'y']);
  assert.ok(gemini.LEADS_SCHEMA.properties.leads.items.properties.phone.nullable);
});

test('lead generation runs research (grounded) then extraction (JSON), collects grounding sources and usage', async () => {
  const origResolve = apiKeys.resolveKeyForUser; apiKeys.resolveKeyForUser = serverKey;
  const calls = fakeFetch(async ({ body, n }) => {
    if (n === 1) {
      assert.ok(body.tools.some((t) => t.google_search), 'research call uses Google Search');
      assert.ok(body.tools.some((t) => t.url_context), 'research call uses URL context');
      assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'high');
      assert.match(body.systemInstruction.parts[0].text, /STRATEGY LEADS/);
      return { json: textResponse('SEARCH NOTES: found 1\n### Glow Studio\n- Phone: 0300-1234567 (https://instagram.com/glowstudio)\nEND OF REPORT', { groundingMetadata: { webSearchQueries: ['q1', 'q2'], groundingChunks: [{ web: { uri: 'https://vertexaisearch.example/redirect1', title: 'instagram.com' } }] } }) };
    }
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.ok(body.generationConfig.responseSchema.properties.leads);
    assert.match(body.contents[0].parts[0].text, /RESEARCH REPORT/);
    return { json: textResponse(JSON.stringify({ search_notes: 'found 1', leads: [{ business_name: 'Glow Studio', city: 'Lahore', phone: '0300-1234567', source_urls: ['https://instagram.com/glowstudio'] }] })) };
  });
  try {
    const r = await gemini.generateLeadCandidates({ userId: 'u', panel: 'strategy', niches: ['Bridal Makeup Studios'], city: 'Lahore', count: 3, excludeNames: ['Old Biz'], webSearch: true });
    assert.equal(calls.length, 2);
    assert.equal(r.leads.length, 1);
    assert.equal(r.leads[0].business_name, 'Glow Studio');
    assert.ok(r.sources.includes('https://instagram.com/glowstudio'));
    assert.ok(r.sources.includes('https://vertexaisearch.example/redirect1'));
    assert.equal(r.usage.web_search_requests, 2);
    assert.equal(r.usage.output_tokens, 16);
    assert.equal(r.webSearchUsed, true);
    assert.equal(r.model, 'gemini-test-pro');
    assert.match(calls[0].body.contents[0].parts[0].text, /Old Biz/);
  } finally { apiKeys.resolveKeyForUser = origResolve; gemini.setFetchForTests(null); }
});

test('falls back to the next model on quota (429) and retired (404) models, retries 503, negotiates thinking params', async () => {
  const origResolve = apiKeys.resolveKeyForUser; apiKeys.resolveKeyForUser = serverKey;
  const seen = [];
  fakeFetch(async ({ model, body }) => {
    seen.push(model + (body.generationConfig && body.generationConfig.thinkingConfig ? ':' + Object.keys(body.generationConfig.thinkingConfig)[0] : ''));
    if (model === 'gemini-test-pro') return { status: 429, json: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } } };
    if (model === 'gemini-test-flash' && seen.filter((x) => x.startsWith('gemini-test-flash')).length === 1) return { status: 503, json: { error: { code: 503, status: 'UNAVAILABLE', message: 'high demand' } } };
    if (model === 'gemini-test-flash' && body.generationConfig.thinkingConfig && body.generationConfig.thinkingConfig.thinkingLevel) return { status: 400, json: { error: { code: 400, message: 'thinking_level is not supported for this model' } } };
    return { json: textResponse('OK') };
  });
  try {
    const r = await gemini.testConnection('u');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.model, 'gemini-test-flash');
    assert.equal(r.fallback_used, true);
    assert.equal(seen[0], 'gemini-test-pro', 'primary tried first');
    assert.ok(seen.filter((x) => x.startsWith('gemini-test-flash')).length >= 2, 'retried after 503');
  } finally { apiKeys.resolveKeyForUser = origResolve; gemini.setFetchForTests(null); }
});

test('sweeps the whole model chain again after a pause when every model is overloaded', async () => {
  const origResolve = apiKeys.resolveKeyForUser; apiKeys.resolveKeyForUser = serverKey;
  const orig = { retries: config.ai.gemini.maxRetries, wait: config.ai.gemini.overloadRoundWaitMs, rounds: config.ai.gemini.overloadRounds };
  config.ai.gemini.maxRetries = 0; config.ai.gemini.overloadRoundWaitMs = 20; config.ai.gemini.overloadRounds = 2;
  const seen = [];
  fakeFetch(async ({ model }) => {
    seen.push(model);
    if (seen.length <= 3) return { status: 503, json: { error: { code: 503, status: 'UNAVAILABLE', message: 'high demand' } } }; // round 1: all three models busy
    if (model === 'gemini-test-pro') return { status: 503, json: { error: { code: 503, status: 'UNAVAILABLE', message: 'high demand' } } };
    return { json: textResponse('OK') };
  });
  try {
    const r = await gemini.testConnection('u');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.model, 'gemini-test-flash');
    assert.deepEqual(seen, ['gemini-test-pro', 'gemini-test-flash', 'gemini-test-lite', 'gemini-test-pro', 'gemini-test-flash']);
    gemini.resetQuotaMemoryForTests(); seen.length = 0;
    fakeFetch(async ({ model }) => { seen.push(model); return { status: 503, json: { error: { code: 503, status: 'UNAVAILABLE', message: 'high demand' } } }; });
    const bad = await gemini.testConnection('u');
    assert.equal(bad.ok, false);
    assert.equal(seen.length, 9, 'three rounds over three models, then give up');
    assert.equal(bad.error.code, 'ai_unavailable');
  } finally { apiKeys.resolveKeyForUser = origResolve; gemini.setFetchForTests(null); Object.assign(config.ai.gemini, { maxRetries: orig.retries, overloadRoundWaitMs: orig.wait, overloadRounds: orig.rounds }); }
});

test('maps API errors to clear user-facing messages', async () => {
  const origResolve = apiKeys.resolveKeyForUser; apiKeys.resolveKeyForUser = serverKey;
  try {
    fakeFetch(async () => ({ status: 429, json: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota' } } }));
    let r = await gemini.testConnection('u');
    assert.equal(r.ok, false); assert.equal(r.error.code, 'ai_rate_limited'); assert.match(r.error.message, /billing/i);
    fakeFetch(async () => ({ status: 400, json: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } } }));
    r = await gemini.testConnection('u');
    assert.equal(r.error.code, 'ai_auth_error');
    fakeFetch(async () => ({ status: 404, json: { error: { code: 404, message: 'not found' } } }));
    r = await gemini.testConnection('u');
    assert.equal(r.error.code, 'ai_model_unavailable');
  } finally { apiKeys.resolveKeyForUser = origResolve; gemini.setFetchForTests(null); }
});

test('reports a configuration error when no Gemini key exists', async () => {
  const origResolve = apiKeys.resolveKeyForUser; apiKeys.resolveKeyForUser = async () => ({ apiKey: null, source: 'none' });
  try { const r = await gemini.testConnection('u'); assert.equal(r.ok, false); assert.equal(r.error.code, 'ai_not_configured'); }
  finally { apiKeys.resolveKeyForUser = origResolve; }
});

test('switches to evidence mode when native grounding is quota-blocked', async () => {
  const origResolve = apiKeys.resolveKeyForUser; apiKeys.resolveKeyForUser = serverKey;
  const evidence = require('../server/services/evidence.service');
  const origGather = evidence.gather;
  evidence.gather = async () => ({ queries: ['q'], results: [{ title: 'Some Salon Karachi', snippet: 'call 0300-5556667', url: 'https://dir.example/some-salon', host: 'dir.example' }], pages: [], corpus: 'some salon karachi call 0300-5556667 https://dir.example/some-salon', phones: new Set(['923005556667']), urls: new Set(['https://dir.example/some-salon']), elapsed_ms: 1 });
  const calls = fakeFetch(async ({ body }) => {
    if (body.tools && body.tools.length) return { status: 429, json: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } } };
    if (!body.generationConfig.responseMimeType) return { json: textResponse('SEARCH NOTES: from memory\nEND OF REPORT') };
    return { json: textResponse(JSON.stringify({ search_notes: 'from evidence', leads: [{ business_name: 'Some Salon', city: 'Karachi', phone: '0300-5556667', social_profiles: {}, source_urls: ['https://dir.example/some-salon'] }] })) };
  });
  try {
    const r = await gemini.generateLeadCandidates({ userId: 'u', panel: 'service', niches: ['Travel Agencies'], city: 'Karachi', count: 2, webSearch: true });
    assert.equal(r.researchMode, 'evidence');
    assert.equal(r.webSearchUsed, true);
    assert.equal(r.leads.length, 1);
    assert.equal(r.leads[0].field_verification.phone, 'verified');
    assert.ok(calls.some((c) => c.body.tools), 'grounded attempt was made first');
    assert.ok(gemini.useEvidenceMode(true), 'grounding is now remembered as unavailable');
  } finally { apiKeys.resolveKeyForUser = origResolve; gemini.setFetchForTests(null); evidence.gather = origGather; }
});

test('retries extraction on a different model when the JSON output is unreadable', async () => {
  const origResolve = apiKeys.resolveKeyForUser; apiKeys.resolveKeyForUser = serverKey;
  const models = [];
  fakeFetch(async ({ model, body }) => {
    if (!body.generationConfig.responseMimeType) return { json: textResponse('### Biz\n- Phone: 0300-1111111 (https://x.example)\nEND OF REPORT') };
    models.push(model);
    if (models.length === 1) return { json: { candidates: [{ content: { parts: [{ text: '{"search_notes": "cut off', }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: {} } };
    return { json: textResponse(JSON.stringify({ search_notes: 'ok', leads: [{ business_name: 'Biz', city: 'Lahore', phone: '0300-1111111' }] })) };
  });
  try {
    const r = await gemini.generateLeadCandidates({ userId: 'u', panel: 'strategy', niches: ['X'], city: 'Lahore', count: 1, webSearch: false });
    assert.equal(r.leads.length, 1);
    assert.equal(models.length, 2);
    assert.notEqual(models[0], models[1]);
  } finally { apiKeys.resolveKeyForUser = origResolve; gemini.setFetchForTests(null); }
});

test('evidence mode: one JSON call grounded in server-gathered evidence, with server-side verification', async () => {
  const origResolve = apiKeys.resolveKeyForUser; apiKeys.resolveKeyForUser = serverKey;
  const evidence = require('../server/services/evidence.service');
  const origGather = evidence.gather;
  const config = require('../server/config');
  const origMode = config.ai.gemini.researchMode; config.ai.gemini.researchMode = 'evidence';
  evidence.gather = async () => ({ queries: ['q1', 'q2'], results: [{ title: 'Glow Studio Lahore', snippet: 'WhatsApp 0300-1234567', url: 'https://instagram.com/glowstudio.pk', host: 'instagram.com' }], pages: [], corpus: 'glow studio lahore whatsapp 0300-1234567 https://instagram.com/glowstudio.pk', phones: new Set(['923001234567']), urls: new Set(['https://instagram.com/glowstudio.pk']), elapsed_ms: 5 });
  const calls = fakeFetch(async ({ body }) => {
    assert.equal(body.tools, undefined, 'no native grounding tools in evidence mode');
    assert.match(body.contents[0].parts[0].text, /===== EVIDENCE =====/);
    assert.match(body.systemInstruction.parts[0].text, /EVIDENCE MODE/);
    return { json: textResponse(JSON.stringify({ search_notes: 'two candidates', leads: [
      { business_name: 'Glow Studio', city: 'Lahore', phone: '0300-9999999', social_profiles: { instagram: 'https://instagram.com/glowstudio.pk' }, source_urls: ['https://instagram.com/glowstudio.pk'] },
      { business_name: 'Imaginary Salon', city: 'Lahore', phone: '0300-0000000', social_profiles: {}, source_urls: [] },
    ] })) };
  });
  const origFind = evidence.findPhoneFor; const lookups = [];
  evidence.findPhoneFor = async ({ name, city }) => { lookups.push(`${name}|${city}`); return { phone: '0300-1234567', normalized: '923001234567', source_url: 'https://instagram.com/glowstudio.pk', snippet: 'WhatsApp 0300-1234567' }; };
  try {
    const r = await gemini.generateLeadCandidates({ userId: 'u', panel: 'strategy', niches: ['Bridal Makeup Studios'], city: 'Lahore', count: 5, webSearch: true });
    assert.equal(calls.length, 1, 'a single model call per batch');
    assert.equal(r.researchMode, 'evidence');
    assert.equal(r.webSearchUsed, true);
    assert.equal(r.leads.length, 1);
    assert.equal(r.leads[0].business_name, 'Glow Studio');
    assert.deepEqual(lookups, ['Glow Studio|Lahore'], 'the invented phone was stripped, then one follow-up lookup ran');
    assert.equal(r.leads[0].phone, '0300-1234567');
    assert.equal(r.leads[0].field_verification.phone, 'verified');
    assert.equal(r.leads[0].confidence, 'verified');
    assert.deepEqual(r.rejected, [{ business_name: 'Imaginary Salon', reason: 'not_in_evidence' }]);
    assert.equal(r.usage.web_search_requests, 3, "two evidence searches + one phone lookup");
  } finally { apiKeys.resolveKeyForUser = origResolve; gemini.setFetchForTests(null); evidence.gather = origGather; evidence.findPhoneFor = origFind; config.ai.gemini.researchMode = origMode; }
});

test('per-day quota errors cool a model down until the Pacific-time reset; per-minute ones for about a minute', () => {
  const day = gemini.cooldownFor({ details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] });
  assert.ok(day >= 60000 && day <= 24 * 3600 * 1000);
  const minute = gemini.cooldownFor({ details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }] });
  assert.equal(minute, require('../server/config').ai.gemini.quotaCooldownMs);
});

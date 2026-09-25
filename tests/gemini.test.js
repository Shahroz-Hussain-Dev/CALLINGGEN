'use strict';
/** Unit tests for the Gemini provider using a fake HTTP layer (no network). */
process.env.NODE_ENV = 'test';
process.env.GEMINI_API_KEY = 'AIzaFAKEKEY000000000000000000000000000';
process.env.GEMINI_MODEL = 'gemini-test-pro';
process.env.GEMINI_FALLBACK_MODELS = 'gemini-test-flash,gemini-test-lite';
process.env.GEMINI_MAX_RETRIES = '1';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const gemini = require('../server/services/gemini.service');
const apiKeys = require('../server/services/apiKeys.service');

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

test('falls back to ungrounded research when grounding is quota-blocked, and flags the results', async () => {
  const origResolve = apiKeys.resolveKeyForUser; apiKeys.resolveKeyForUser = serverKey;
  const calls = fakeFetch(async ({ body, n }) => {
    if (body.tools && body.tools.length) return { status: 429, json: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota' } } };
    if (!body.generationConfig.responseMimeType) return { json: textResponse('SEARCH NOTES: from memory\n### Some Salon\n- Phone: not found\nEND OF REPORT') };
    return { json: textResponse(JSON.stringify({ search_notes: 'from memory', leads: [{ business_name: 'Some Salon', city: 'Lahore', phone: null }] })) };
  });
  try {
    const r = await gemini.generateLeadCandidates({ userId: 'u', panel: 'service', niches: ['Travel Agencies'], city: 'Karachi', count: 2, webSearch: true });
    assert.equal(r.webSearchUsed, false);
    assert.ok(r.warnings.includes('grounding_unavailable'));
    assert.match(r.searchNotes, /Needs Verification/);
    assert.equal(r.leads.length, 1);
    assert.ok(calls.some((c) => c.body.tools), 'grounded attempt was made first');
  } finally { apiKeys.resolveKeyForUser = origResolve; gemini.setFetchForTests(null); }
});

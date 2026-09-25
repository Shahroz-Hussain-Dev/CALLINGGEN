'use strict';
/**
 * Claude API integration (server-side only). The API key never leaves the
 * server. Uses the official @anthropic-ai/sdk.
 */
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const logger = require('../logger');
const { AppError, ServiceUnavailableError } = require('../lib/errors');
const apiKeys = require('./apiKeys.service');
const { SUBMIT_LEADS_TOOL, SUBMIT_LEADS_TOOL_LOOSE } = require('../prompts/leadSchema');
const prompts = require('../prompts/leadGeneration');
const analysis = require('../prompts/analysis');

// Test hook: tests inject a fake client factory so no real API calls are made.
let clientFactory = (apiKey) => new Anthropic({ apiKey, timeout: config.claude.timeoutMs, maxRetries: 1 });
function setClientFactory(fn) { clientFactory = fn; }
function resetClientFactory() { clientFactory = (apiKey) => new Anthropic({ apiKey, timeout: config.claude.timeoutMs, maxRetries: 1 }); }

function supportsEffort(model) { return /opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|fable|mythos/i.test(model); }
function webSearchToolFor(model, city, maxUses) {
  const type = /opus-5|opus-4-[678]|sonnet-5|sonnet-4-6|fable|mythos/i.test(model) ? 'web_search_20260209' : 'web_search_20250305';
  const tool = { type, name: 'web_search', max_uses: maxUses };
  tool.user_location = { type: 'approximate', country: 'PK', city: city || undefined };
  return tool;
}

async function getClientForUser(userId) {
  const { apiKey, source } = await apiKeys.resolveKeyForUser(userId, 'anthropic');
  if (!apiKey) {
    throw new ServiceUnavailableError('No Claude API key is configured. Add your key in Settings, or set ANTHROPIC_API_KEY on the server.', 'claude_not_configured');
  }
  return { client: clientFactory(apiKey), source };
}

function mapError(err) {
  if (err instanceof AppError) return err;
  let mapped;
  if (err instanceof Anthropic.AuthenticationError) mapped = new AppError('The Claude API key was rejected (invalid or revoked). Update it in Settings.', 502, 'claude_auth_error');
  else if (err instanceof Anthropic.PermissionDeniedError) mapped = new AppError('The Claude API key does not have permission for this request.', 502, 'claude_permission_error');
  else if (err instanceof Anthropic.NotFoundError) mapped = new AppError(`The configured Claude model (${config.claude.model}) is not available to this API key.`, 502, 'claude_model_unavailable');
  else if (err instanceof Anthropic.RateLimitError) mapped = new AppError('The Claude API rate limit was reached. Wait a moment and try again.', 429, 'claude_rate_limited');
  else if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(String(err.message))) mapped = new AppError('The Anthropic account behind this API key has no credits. Add credits at console.anthropic.com (Plans & Billing), then try again.', 502, 'claude_billing');
  else if (err instanceof Anthropic.BadRequestError) mapped = new AppError(`Claude rejected the request: ${String(err.message).slice(0, 300)}`, 502, 'claude_bad_request');
  else if (err instanceof Anthropic.APIConnectionTimeoutError) mapped = new AppError('The Claude request timed out. Try again; long research runs are resumed automatically in batches.', 504, 'claude_timeout');
  else if (err instanceof Anthropic.APIConnectionError) mapped = new AppError('Could not connect to the Claude API. Check network access from the server.', 503, 'claude_unreachable');
  else if (err instanceof Anthropic.APIError) mapped = new AppError(`Claude API error (${err.status || 'unknown'}). Try again shortly.`, 503, 'claude_api_error');
  else mapped = new AppError('Unexpected error while calling Claude', 500, 'claude_error');
  mapped.expose = true;
  mapped.cause = err;
  return mapped;
}

/**
 * Creates a message with graceful degradation:
 *  1. beta endpoint with server-side refusal fallbacks (if enabled)
 *  2. standard endpoint
 * Streaming is used so long research runs do not hit HTTP timeouts.
 */
async function createMessage(client, params, { stream = true } = {}) {
  const modes = [];
  if (config.claude.fallbacks && client.beta && client.beta.messages) modes.push('beta');
  modes.push('standard');
  let lastErr;
  for (const mode of modes) {
    try {
      if (mode === 'beta') {
        const p = { ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
        if (stream) return await client.beta.messages.stream(p).finalMessage();
        return await client.beta.messages.create(p);
      }
      if (stream) return await client.messages.stream(params).finalMessage();
      return await client.messages.create(params);
    } catch (err) {
      lastErr = err;
      if (mode === 'beta' && err instanceof Anthropic.BadRequestError) {
        logger.warn('Claude beta fallback params rejected; retrying on the standard endpoint', { message: err.message });
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function baseParams(model, { effort } = {}) {
  const p = { model, max_tokens: 16000 };
  if (supportsEffort(model)) p.output_config = { effort: effort || config.claude.effort };
  return p;
}

function textOf(message) {
  return (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

function collectSources(message, into) {
  for (const b of message.content || []) {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r && r.type === 'web_search_result' && r.url) into.add(r.url);
    }
  }
}

function addUsage(total, msg) {
  const u = msg.usage || {};
  total.input_tokens += u.input_tokens || 0;
  total.output_tokens += u.output_tokens || 0;
  total.cache_read_input_tokens += u.cache_read_input_tokens || 0;
  const ws = u.server_tool_use && u.server_tool_use.web_search_requests;
  if (ws) total.web_search_requests += ws;
}

// ---------------------------------------------------------------------------
// Connection test
// ---------------------------------------------------------------------------
async function testConnection(userId) {
  const started = Date.now();
  let source = 'none';
  try {
    const resolved = await getClientForUser(userId);
    source = resolved.source;
    const params = { ...baseParams(config.claude.model, { effort: 'low' }), max_tokens: 256, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] };
    const msg = await createMessage(resolved.client, params, { stream: false });
    const result = { ok: true, provider: 'anthropic', model: msg.model || config.claude.model, latency_ms: Date.now() - started, key_source: source, reply: textOf(msg).trim().slice(0, 40), tested_at: new Date().toISOString() };
    if (source === 'user') await apiKeys.recordTestResult(userId, 'anthropic', true, { ok: true, model: result.model, latency_ms: result.latency_ms, tested_at: result.tested_at });
    return result;
  } catch (err) {
    const mapped = mapError(err);
    const result = { ok: false, provider: 'anthropic', error: { code: mapped.code, message: mapped.message }, key_source: source, latency_ms: Date.now() - started, tested_at: new Date().toISOString() };
    if (source === 'user') await apiKeys.recordTestResult(userId, 'anthropic', false, result).catch(() => {});
    return result;
  }
}

// ---------------------------------------------------------------------------
// Lead generation
// ---------------------------------------------------------------------------
function tryParseLeadsJson(text) {
  if (!text) return null;
  const m = /\{[\s\S]*"leads"[\s\S]*\}/.exec(text);
  if (!m) return null;
  try { const parsed = JSON.parse(m[0]); return Array.isArray(parsed.leads) ? parsed : null; } catch (_) { return null; }
}

/**
 * Asks Claude to research and submit lead candidates. Returns
 * { leads, searchNotes, sources, usage, model, webSearchUsed }.
 */
async function generateLeadCandidates({ userId, panel, niches, city, count, excludeNames = [], webSearch = config.claude.webSearch }) {
  const { client, source } = await getClientForUser(userId);
  const model = config.claude.model;
  const system = [{ type: 'text', text: panel === 'strategy' ? prompts.STRATEGY_SYSTEM : prompts.SERVICE_SYSTEM, cache_control: { type: 'ephemeral' } }];
  const userPrompt = prompts.buildUserPrompt({ panel, niches, city, count, excludeNames, searchEnabled: webSearch });
  const buildTools = (strict) => {
    const tools = [];
    if (webSearch) tools.push(webSearchToolFor(model, city, config.claude.webSearchMaxUses));
    tools.push(strict ? SUBMIT_LEADS_TOOL : SUBMIT_LEADS_TOOL_LOOSE);
    return tools;
  };

  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };
  const sources = new Set();
  let strict = true;
  const messages = [{ role: 'user', content: userPrompt }];

  try {
    for (let turn = 0; turn < 6; turn++) {
      let msg;
      try {
        msg = await createMessage(client, { ...baseParams(model), system, messages, tools: buildTools(strict), tool_choice: { type: 'auto' } });
      } catch (err) {
        if (strict && err instanceof Anthropic.BadRequestError) {
          logger.warn('Strict tool schema rejected; retrying without strict mode', { message: err.message });
          strict = false;
          msg = await createMessage(client, { ...baseParams(model), system, messages, tools: buildTools(strict), tool_choice: { type: 'auto' } });
        } else throw err;
      }
      addUsage(usage, msg);
      collectSources(msg, sources);
      if (msg.stop_reason === 'refusal') throw new AppError('Claude declined to process this lead research request.', 502, 'claude_refusal');
      const toolUse = (msg.content || []).find((b) => b.type === 'tool_use' && b.name === 'submit_leads');
      if (toolUse && toolUse.input && Array.isArray(toolUse.input.leads)) {
        return { leads: toolUse.input.leads, searchNotes: toolUse.input.search_notes || '', sources: [...sources], usage, model: msg.model || model, webSearchUsed: webSearch && usage.web_search_requests > 0, keySource: source };
      }
      if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); continue; }
      if (msg.stop_reason === 'max_tokens') throw new AppError('Claude ran out of output space before submitting leads. Reduce the batch size in Settings.', 502, 'claude_truncated');
      const parsed = tryParseLeadsJson(textOf(msg));
      if (parsed) return { leads: parsed.leads, searchNotes: parsed.search_notes || '', sources: [...sources], usage, model: msg.model || model, webSearchUsed: webSearch && usage.web_search_requests > 0, keySource: source };
      // Ended without calling the tool: ask explicitly once more.
      messages.push({ role: 'assistant', content: msg.content });
      messages.push({ role: 'user', content: 'Submit your findings now by calling the submit_leads tool exactly once. If you found no qualifying businesses, call it with an empty leads array and explain why in search_notes.' });
    }
    throw new AppError('Lead research did not finish within the allowed number of steps. Try again.', 502, 'claude_incomplete');
  } catch (err) {
    const mapped = mapError(err);
    mapped.usage = usage;
    throw mapped;
  }
}

// ---------------------------------------------------------------------------
// Structured analysis (meeting prep, automation analysis, booking analysis)
// ---------------------------------------------------------------------------
async function structuredAnalysis({ userId, system, userContent, schema, webSearch = false, city = null }) {
  const { client } = await getClientForUser(userId);
  const model = config.claude.model;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };
  const sources = new Set();
  const messages = [{ role: 'user', content: userContent }];
  const params = { ...baseParams(model), system, messages, output_config: { ...(baseParams(model).output_config || {}), format: { type: 'json_schema', schema } } };
  let tools = webSearch ? [webSearchToolFor(model, city, 5)] : undefined;
  try {
    for (let turn = 0; turn < 4; turn++) {
      let msg;
      try {
        msg = await createMessage(client, tools ? { ...params, tools } : params);
      } catch (err) {
        if (tools && err instanceof Anthropic.BadRequestError) { tools = undefined; msg = await createMessage(client, params); } else throw err;
      }
      addUsage(usage, msg);
      collectSources(msg, sources);
      if (msg.stop_reason === 'refusal') throw new AppError('Claude declined to analyse this record.', 502, 'claude_refusal');
      if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); continue; }
      const text = textOf(msg).trim();
      let data = null;
      try { data = JSON.parse(text); } catch (_) {
        const m = /\{[\s\S]*\}/.exec(text);
        if (m) { try { data = JSON.parse(m[0]); } catch (_e) { data = null; } }
      }
      if (!data) throw new AppError('Claude returned an unreadable analysis. Please try again.', 502, 'claude_bad_output');
      return { data, sources: [...sources], usage, model: msg.model || model };
    }
    throw new AppError('Analysis did not complete. Please try again.', 502, 'claude_incomplete');
  } catch (err) { throw mapError(err); }
}

async function generateBusinessProfile({ userId, contact, calls, previousResearch, webSearch }) {
  const system = [{ type: 'text', text: analysis.PROFILE_SYSTEM, cache_control: { type: 'ephemeral' } }];
  const userContent = `${analysis.contactContext(contact, calls, previousResearch)}\n\nProduce the business profile and customized automation proposal outline for the meeting. ${webSearch ? 'Use web search to confirm details where possible and list the URLs in sources_used.' : 'No web search is available; mark unverified information clearly.'}`;
  return structuredAnalysis({ userId, system, userContent, schema: analysis.BUSINESS_PROFILE_SCHEMA, webSearch, city: contact.city });
}

async function generateBookingAnalysis({ userId, contact, calls }) {
  const system = [{ type: 'text', text: analysis.BOOKING_SYSTEM, cache_control: { type: 'ephemeral' } }];
  const userContent = `${analysis.contactContext(contact, calls, null)}\n\nAnalyse the booking situation and prepare the employee for the next conversation.`;
  return structuredAnalysis({ userId, system, userContent, schema: analysis.BOOKING_ANALYSIS_SCHEMA, webSearch: false });
}

module.exports = { setClientFactory, resetClientFactory, testConnection, generateLeadCandidates, generateBusinessProfile, generateBookingAnalysis, mapError, getClientForUser };

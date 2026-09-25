'use strict';
/**
 * Google Gemini provider (Gemini Developer API, REST). Server-side only.
 *
 * Quality-first design:
 *  - Research phase: Google Search grounding + URL context tools, high thinking, low temperature,
 *    producing an evidence report with a URL for every fact.
 *  - Extraction phase: strict JSON (responseSchema) that may only restate facts from the report.
 *  - Model chain: the configured primary model with automatic fallback to the next model when a
 *    model is unavailable on the key's tier (quota / retired / high demand), plus retries with backoff.
 */
const config = require('../config');
const logger = require('../logger');
const { AppError, ServiceUnavailableError } = require('../lib/errors');
const apiKeys = require('./apiKeys.service');
const { SUBMIT_LEADS_TOOL } = require('../prompts/leadSchema');
const prompts = require('../prompts/leadGeneration');
const analysis = require('../prompts/analysis');
const evidence = require('./evidence.service');

let fetchImpl = (...args) => fetch(...args);
function setFetchForTests(fn) { fetchImpl = fn || ((...args) => fetch(...args)); }

class GeminiApiError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details; }
}

// ---------------------------------------------------------------------------
// Schema conversion (JSON Schema draft -> Gemini/OpenAPI subset)
// ---------------------------------------------------------------------------
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema.anyOf)) {
    const nonNull = schema.anyOf.filter((s) => s.type !== 'null');
    const hasNull = schema.anyOf.length !== nonNull.length;
    const base = nonNull.length === 1 ? toGeminiSchema({ ...nonNull[0], description: schema.description }) : { type: 'string', description: schema.description };
    return hasNull ? { ...base, nullable: true } : base;
  }
  const out = {};
  if (schema.type) out.type = schema.type;
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.nullable) out.nullable = true;
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = toGeminiSchema(v);
    out.propertyOrdering = Object.keys(schema.properties);
  }
  if (schema.required) out.required = schema.required;
  return out;
}
const LEADS_SCHEMA = toGeminiSchema(SUBMIT_LEADS_TOOL.input_schema);

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const thinkingSupport = new Map(); // model -> 'level' | 'budget' | 'none'
// Quota memory (per process): models that answered 429 recently are skipped for a cooldown so the
// chain does not burn the per-minute request quota on models the key cannot use; likewise for grounding.
const quotaBlockedUntil = new Map(); // model -> timestamp
let groundingBlockedUntil = 0;
function resetQuotaMemoryForTests() { quotaBlockedUntil.clear(); groundingBlockedUntil = 0; thinkingSupport.clear(); }
function quotaIds(err) { return ((err && err.details) || []).flatMap((d) => d.violations || []).map((v) => v.quotaId || '').join(','); }
/** Free-tier per-day quotas reset at midnight Pacific time; per-minute ones within a minute. */
function cooldownFor(err) {
  const ids = quotaIds(err);
  if (/PerDay/i.test(ids)) {
    const now = new Date();
    const pacific = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
    const msToMidnight = ((24 - pacific.getHours()) * 3600 - pacific.getMinutes() * 60 - pacific.getSeconds()) * 1000;
    return Math.max(60000, Math.min(msToMidnight + 60000, 24 * 3600 * 1000));
  }
  return config.ai.gemini.quotaCooldownMs;
}

/** thinking: true (configured level), 'low' (cheap mechanical tasks) or false (none). */
function thinkingConfigFor(model, mode, thinking) {
  const level = typeof thinking === 'string' ? thinking : config.ai.gemini.thinking;
  if (level === 'off' || thinking === false) return null;
  if (mode === 'level') return { thinkingLevel: ['low', 'medium', 'high'].includes(level) ? level : 'high' };
  if (mode === 'budget') return { thinkingBudget: level === 'low' ? 1024 : level === 'medium' ? 8192 : -1 };
  return null;
}

class GeminiClient {
  constructor(apiKey) { this.apiKey = apiKey; this.base = config.ai.gemini.baseUrl.replace(/\/$/, ''); }

  /** One HTTP call. Throws GeminiApiError on non-2xx. */
  async raw(model, body, { timeoutMs } = {}) {
    let res;
    try {
      res = await fetchImpl(`${this.base}/models/${model}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs || config.ai.gemini.timeoutMs),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new GeminiApiError(504, 'TIMEOUT', 'The Gemini request timed out');
      throw new GeminiApiError(503, 'NETWORK', `Could not reach the Gemini API: ${err.message}`);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (!res.ok) {
      const e = (json && json.error) || {};
      throw new GeminiApiError(res.status, e.status || String(res.status), e.message || `Gemini API error ${res.status}`, e.details || null);
    }
    return json;
  }

  /**
   * generateContent with: thinking-parameter negotiation, retry/backoff on 503,
   * and fallback across the model chain on quota (429) / retired (404) models.
   * Returns { response, model }.
   */
  /** Milliseconds left before this client's deadline (Infinity when none was set with setDeadline). */
  remainingMs() { return this.deadline ? this.deadline - Date.now() : Infinity; }
  setDeadline(ms) { this.deadline = Date.now() + ms; return this; }

  async generate(body, { models, timeoutMs, thinking = true, onModelSwitch } = {}) {
    const fullChain = models || [config.ai.gemini.model, ...config.ai.gemini.fallbackModels];
    const transient = new Set(); // models that failed with overload / network trouble during this call
    let lastErr = null;
    for (let round = 0; ; round++) {
      const now = Date.now();
      let chain = fullChain.filter((m) => transient.has(m) || (quotaBlockedUntil.get(m) || 0) <= now);
      if (!chain.length) chain = fullChain; // everything is cooling down: try anyway
      transient.clear();
      for (let mi = 0; mi < chain.length; mi++) {
        const model = chain[mi];
        let mode = thinkingSupport.get(model) || 'level';
        for (let attempt = 0; attempt <= config.ai.gemini.maxRetries; attempt++) {
          const left = this.remainingMs();
          if (left < 15000) throw lastErr || new GeminiApiError(504, 'DEADLINE', 'Out of time before any Gemini model answered');
          const req = JSON.parse(JSON.stringify(body));
          const tc = thinkingConfigFor(model, mode, thinking);
          if (tc) { req.generationConfig = { ...(req.generationConfig || {}), thinkingConfig: tc }; }
          try {
            const response = await this.raw(model, req, { timeoutMs: Math.max(10000, Math.min(timeoutMs || config.ai.gemini.timeoutMs, left - 3000)) });
            thinkingSupport.set(model, mode);
            if (model !== fullChain[0] && onModelSwitch) onModelSwitch(model, lastErr);
            return { response, model };
          } catch (err) {
            lastErr = err;
            if (err.status === 400 && /thinking/i.test(err.message) && mode !== 'none') { mode = mode === 'level' ? 'budget' : 'none'; attempt--; continue; }
            if (err.status === 503 || err.status === 500 || err.code === 'NETWORK' || err.status === 504) {
              if (attempt < config.ai.gemini.maxRetries && err.status !== 504 && this.remainingMs() > 30000) { await sleep(Math.min(15000, 2500 * (attempt + 1))); continue; }
              quotaBlockedUntil.set(model, Date.now() + config.ai.gemini.overloadCooldownMs); // overloaded / timing out: skip for a while
              transient.add(model);
              break;
            }
            if (err.status === 429) { const cd = cooldownFor(err); quotaBlockedUntil.set(model, Date.now() + cd); if (cd <= config.ai.gemini.quotaCooldownMs) transient.add(model); break; } // next model in the chain
            if (err.status === 404) { quotaBlockedUntil.set(model, Date.now() + 24 * 3600 * 1000); break; }
            throw err;
          }
        }
        logger.warn('Gemini model unavailable, trying next in chain', { model, status: lastErr && lastErr.status, message: lastErr && String(lastErr.message).slice(0, 160) });
      }
      // Every model failed. When the failures were transient (high demand, per-minute quota, network), wait and sweep the chain again.
      const wait = config.ai.gemini.overloadRoundWaitMs;
      if (!transient.size || round >= config.ai.gemini.overloadRounds || this.remainingMs() < wait + 25000) break;
      logger.warn('All Gemini models unavailable, waiting before another round', { round: round + 1, models: [...transient], wait_ms: wait });
      await sleep(wait);
    }
    throw lastErr || new GeminiApiError(503, 'UNAVAILABLE', 'No Gemini model responded');
  }
}

async function getClientForUser(userId) {
  const { apiKey, source } = await apiKeys.resolveKeyForUser(userId, 'gemini');
  if (!apiKey) throw new ServiceUnavailableError('No Gemini API key is configured. Add your key in Settings, or set GEMINI_API_KEY on the server.', 'ai_not_configured');
  return { client: new GeminiClient(apiKey), source };
}

function mapError(err) {
  if (err instanceof AppError) return err;
  let mapped;
  if (err instanceof GeminiApiError) {
    const msg = String(err.message || '');
    if (err.status === 400 && /api key/i.test(msg)) mapped = new AppError('The Gemini API key was rejected (invalid). Update it in Settings.', 502, 'ai_auth_error');
    else if (err.status === 401 || err.status === 403) mapped = new AppError(`The Gemini API refused the request: ${msg.split('\n')[0].slice(0, 200)}`, 502, 'ai_permission_error');
    else if (err.status === 404) mapped = new AppError('None of the configured Gemini models is available to this API key. Update GEMINI_MODEL / GEMINI_FALLBACK_MODELS.', 502, 'ai_model_unavailable');
    else if (err.status === 429) mapped = new AppError('The Gemini API quota for this key is exhausted (free-tier limits). Wait a minute and try again, or enable billing in Google AI Studio to unlock higher limits and Pro models.', 429, 'ai_rate_limited');
    else if (err.status === 504) mapped = new AppError('The Gemini request timed out. Try again; long research runs continue in batches.', 504, 'ai_timeout');
    else if (err.status === 503) mapped = new AppError('Gemini is temporarily overloaded (high demand). Please try again in a moment.', 503, 'ai_unavailable');
    else if (err.status === 400) mapped = new AppError(`Gemini rejected the request: ${msg.slice(0, 300)}`, 502, 'ai_bad_request');
    else mapped = new AppError(`Gemini API error (${err.status}): ${msg.slice(0, 200)}`, 503, 'ai_api_error');
  } else mapped = new AppError('Unexpected error while calling Gemini', 500, 'ai_error');
  mapped.expose = true;
  mapped.cause = err;
  return mapped;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
function candidateText(response) {
  const c = response && response.candidates && response.candidates[0];
  if (!c || !c.content || !Array.isArray(c.content.parts)) return '';
  return c.content.parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
}
function finishReason(response) { const c = response && response.candidates && response.candidates[0]; return c ? c.finishReason : null; }
function collectSources(response, into) {
  const c = response && response.candidates && response.candidates[0];
  if (!c) return;
  const gm = c.groundingMetadata || {};
  for (const ch of gm.groundingChunks || []) if (ch.web && ch.web.uri) into.add(ch.web.uri);
  const uc = c.urlContextMetadata || c.url_context_metadata || {};
  for (const m of uc.urlMetadata || uc.url_metadata || []) if (m.retrievedUrl || m.retrieved_url) into.add(m.retrievedUrl || m.retrieved_url);
}
function extractUrls(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/https?:\/\/[^\s)\]>"']+/g)) out.add(m[0].replace(/[.,;:!?]+$/, ''));
  return [...out];
}
function addUsage(total, response, searchQueries) {
  const u = (response && response.usageMetadata) || {};
  total.input_tokens += u.promptTokenCount || 0;
  total.output_tokens += (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0);
  total.cache_read_input_tokens += u.cachedContentTokenCount || 0;
  if (searchQueries) total.web_search_requests += searchQueries;
}
function searchQueryCount(response) { const c = response && response.candidates && response.candidates[0]; const gm = c && c.groundingMetadata; return gm && Array.isArray(gm.webSearchQueries) ? gm.webSearchQueries.length : 0; }
function parseJson(text) {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(t); } catch (_) { /* fall through */ }
  const m = /\{[\s\S]*\}/.exec(t);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { return null; } }
  return null;
}

function toolsFor({ webSearch }) {
  if (!webSearch) return [];
  const tools = [{ google_search: {} }];
  if (config.ai.gemini.urlContext) tools.push({ url_context: {} });
  return tools;
}

/**
 * Runs a grounded call. Degrades when the API refuses the tools: a 400 drops url_context and then
 * all tools; a 429 on every model with tools (grounding has its own quota, absent on free-tier keys)
 * retries once without tools and reports `grounding_unavailable` so callers can flag the results.
 */
async function groundedGenerate(client, { system, userText, webSearch, generationConfig, timeoutMs, models }) {
  let tools = toolsFor({ webSearch });
  const warnings = [];
  if (tools.length && groundingBlockedUntil > Date.now()) { warnings.push('grounding_unavailable'); tools = []; }
  for (;;) {
    const body = { systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: userText }] }], generationConfig: { temperature: config.ai.gemini.temperature, maxOutputTokens: config.ai.gemini.maxOutputTokens, ...(generationConfig || {}) } };
    if (tools.length) body.tools = tools;
    try {
      return { ...(await client.generate(body, { timeoutMs, models })), toolsUsed: tools.map((t) => Object.keys(t)[0]), warnings };
    } catch (err) {
      if (err instanceof GeminiApiError && err.status === 400 && tools.length) {
        if (tools.length > 1) { logger.warn('Gemini rejected url_context; retrying without it', { message: err.message.slice(0, 160) }); tools = tools.slice(0, 1); continue; }
        logger.warn('Gemini rejected grounding tools; retrying without tools', { message: err.message.slice(0, 160) });
        warnings.push('grounding_rejected');
        tools = [];
        continue;
      }
      if (err instanceof GeminiApiError && err.status === 429 && tools.length) {
        logger.warn('Gemini grounding quota exhausted on every model; retrying without web research', { message: err.message.slice(0, 160) });
        groundingBlockedUntil = Date.now() + config.ai.gemini.groundingCooldownMs;
        for (const m of quotaBlockedUntil.keys()) if (!/PerDay/i.test(quotaIds(err))) quotaBlockedUntil.delete(m); // per-minute 429s during grounding were about grounding, not the models
        warnings.push('grounding_unavailable');
        tools = [];
        continue;
      }
      throw err;
    }
  }
}

/** Two-phase: research (grounded, free text) then extraction (strict JSON). */
async function researchThenExtract(client, { system, researchPrompt, extractionSystem, extractionPrompt, schema, webSearch, usage, sources }) {
  const research = await groundedGenerate(client, { system, userText: researchPrompt, webSearch });
  const warnings = research.warnings || [];
  addUsage(usage, research.response, searchQueryCount(research.response));
  collectSources(research.response, sources);
  const report = candidateText(research.response);
  const rf = finishReason(research.response);
  if (rf === 'SAFETY' || rf === 'PROHIBITED_CONTENT') throw new AppError('Gemini declined this research request.', 502, 'ai_refusal');
  if (!report.trim()) {
    const cand = research.response && research.response.candidates && research.response.candidates[0];
    logger.warn('Gemini research returned no text', { model: research.model, finish: rf, promptFeedback: research.response && research.response.promptFeedback, parts: cand && cand.content ? (cand.content.parts || []).map((p) => Object.keys(p).join('+')) : null, usage: research.response && research.response.usageMetadata });
    throw new AppError(`Gemini returned an empty research result (${rf || 'no candidate'}). Please try again.`, 502, 'ai_bad_output');
  }
  for (const u of extractUrls(report)) sources.add(u);
  const extractionBody = {
    systemInstruction: { parts: [{ text: extractionSystem }] },
    contents: [{ role: 'user', parts: [{ text: `${extractionPrompt}\n\n===== RESEARCH REPORT =====\n${report}\n===== END OF REPORT =====` }] }],
    generationConfig: { temperature: 0, maxOutputTokens: config.ai.gemini.maxOutputTokens, responseMimeType: 'application/json', responseSchema: schema },
  };
  let models = [research.model, ...config.ai.gemini.fallbackModels.filter((m) => m !== research.model)];
  let extraction = null;
  let data = null;
  for (let attempt = 0; attempt < 2 && !data; attempt++) {
    extraction = await client.generate(extractionBody, { timeoutMs: Math.min(config.ai.gemini.timeoutMs, 150000), thinking: 'low', models });
    addUsage(usage, extraction.response, 0);
    const extractedText = candidateText(extraction.response);
    data = parseJson(extractedText);
    if (!data) {
      const cand = extraction.response && extraction.response.candidates && extraction.response.candidates[0];
      logger.warn('Gemini extraction returned unreadable JSON', { attempt, model: extraction.model, finish: finishReason(extraction.response), promptFeedback: extraction.response && extraction.response.promptFeedback, parts: cand && cand.content ? (cand.content.parts || []).map((p) => Object.keys(p).join('+')) : null, textHead: String(extractedText).slice(0, 400), textTail: String(extractedText).slice(-200), usage: extraction.response && extraction.response.usageMetadata });
      models = models.filter((m) => m !== extraction.model); // retry once on a different model
      if (!models.length) break;
    }
  }
  if (!data) throw new AppError(`Gemini returned unreadable JSON (${(extraction && finishReason(extraction.response)) || 'no candidate'}). Please try again.`, 502, 'ai_bad_output');
  return { data, report, model: research.model, extractionModel: extraction.model, toolsUsed: research.toolsUsed, warnings };
}

// ---------------------------------------------------------------------------
// Public API (same surface as claude.service)
// ---------------------------------------------------------------------------
async function testConnection(userId) {
  const started = Date.now();
  let source = 'none';
  try {
    const resolved = await getClientForUser(userId);
    source = resolved.source;
    const switches = [];
    const { response, model } = await resolved.client.generate({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }], generationConfig: { maxOutputTokens: 64 } }, { timeoutMs: 60000, thinking: false, onModelSwitch: (m, err) => switches.push({ model: m, reason: err ? `${err.status} ${String(err.message).split('\n')[0].slice(0, 120)}` : null }) });
    const result = { ok: true, provider: 'gemini', model, primary_model: config.ai.gemini.model, fallback_used: model !== config.ai.gemini.model, switches, latency_ms: Date.now() - started, key_source: source, reply: candidateText(response).trim().slice(0, 40), tested_at: new Date().toISOString() };
    if (source === 'user') await apiKeys.recordTestResult(userId, 'gemini', true, { ok: true, model, latency_ms: result.latency_ms, tested_at: result.tested_at });
    return result;
  } catch (err) {
    const mapped = mapError(err);
    const result = { ok: false, provider: 'gemini', error: { code: mapped.code, message: mapped.message }, key_source: source, latency_ms: Date.now() - started, tested_at: new Date().toISOString() };
    if (source === 'user') await apiKeys.recordTestResult(userId, 'gemini', false, result).catch(() => {});
    return result;
  }
}

const EXTRACTION_SYSTEM = `You convert a research report about businesses into strict JSON that follows the given schema exactly.
Rules: include ONLY businesses and facts that appear in the report; never add, guess or "complete" any phone number, email, website, address, name, handle or figure. Use null (or an empty array) for anything the report does not state. Set each field_verification entry to "verified" only when the report shows the value together with a URL where it was seen, "estimated" when the report marks it as an estimate or inference, otherwise "unknown". Copy every URL mentioned for a business into its source_urls. Set confidence to "verified" when name and phone are verified with URLs, "partially_verified" when the name is verified but contact details are only partly verified, "estimated" when most details are inferred, and "needs_verification" otherwise. If the report says no qualifying businesses were found, return an empty leads array and explain in search_notes.`;

const EVIDENCE_SYSTEM_SUFFIX = `

EVIDENCE MODE: You are given EVIDENCE gathered by our own web searches (search results, and extracts of pages we downloaded). Treat the evidence as the only source of truth for this task:
- Every business you return must appear in the evidence (by name), and every phone number, WhatsApp number, email, website, address, social profile URL and person name must be copied exactly from the evidence. If a value is not in the evidence, use null.
- Put the evidence URLs where each fact appears into source_urls. Set field_verification to "verified" for values copied from the evidence, "estimated" for inferences (size, opportunities), "unknown" otherwise.
- Directory pages (e.g. listing sites) often show many businesses with their phone numbers: extract each business separately.
- Prefer businesses that match the niche and city and the panel qualification rules; skip businesses that clearly fail them (for the Strategy panel: skip businesses whose own official website with online booking is in the evidence).
- Return up to the requested number of leads. Fewer is fine; never invent.`;

function useEvidenceMode(webSearch) {
  const mode = config.ai.gemini.researchMode;
  if (!webSearch) return false;
  if (mode === 'evidence') return true;
  if (mode === 'native') return false;
  return groundingBlockedUntil > Date.now();
}

/** Lead generation from server-gathered evidence: one JSON call per batch. */
async function generateFromEvidence(client, { panel, niches, city, count, excludeNames, system, usage }) {
  const niche = niches[0];
  const ev = await evidence.gather({ panel, niche, city, timeBudgetMs: Math.max(15000, Math.min(config.evidence.timeBudgetMs, client.remainingMs() - 90000)) });
  const rendered = evidence.render(ev);
  const userText = `${prompts.buildUserPrompt({ panel, niches, city, count, excludeNames, searchEnabled: true }).replace(/Return the leads by calling submit_leads once\./, '').replace(/Web search is available: use it to find and confirm each business before including it\./, 'Use ONLY the evidence below.')}

===== EVIDENCE =====
${rendered}
===== END OF EVIDENCE =====

Return the JSON now (search_notes: say how many distinct qualifying businesses the evidence supports and what was missing).`;
  const { response, model } = await client.generate({
    systemInstruction: { parts: [{ text: system + EVIDENCE_SYSTEM_SUFFIX }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: config.ai.gemini.maxOutputTokens, responseMimeType: 'application/json', responseSchema: LEADS_SCHEMA },
  }, { timeoutMs: config.ai.gemini.evidenceTimeoutMs, thinking: config.ai.gemini.evidenceThinking });
  addUsage(usage, response, 0);
  usage.web_search_requests += ev.queries.length;
  const data = parseJson(candidateText(response));
  if (!data) {
    logger.warn('Gemini evidence-mode extraction returned unreadable JSON', { model, finish: finishReason(response), usage: response && response.usageMetadata });
    throw new AppError(`Gemini returned unreadable JSON (${finishReason(response) || 'no candidate'}). Please try again.`, 502, 'ai_bad_output');
  }
  const leads = [];
  const rejected = [];
  const notes = [];
  for (const raw of Array.isArray(data.leads) ? data.leads : []) {
    const v = evidence.verifyLead(raw, ev);
    if (!v.ok) { rejected.push({ business_name: (raw && raw.business_name) || 'unknown', reason: v.reason }); continue; }
    if (v.changes.length) notes.push(`${v.lead.business_name}: ${v.changes.join('; ')}`);
    leads.push(v.lead);
  }
  return { leads, rejected, model, ev, notes, searchNotes: String(data.search_notes || '') };
}

async function generateLeadCandidates({ userId, panel, niches, city, count, excludeNames = [], webSearch = config.ai.gemini.webSearch, timeBudgetMs = config.ai.gemini.batchDeadlineMs }) {
  const { client, source } = await getClientForUser(userId);
  client.setDeadline(timeBudgetMs);
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };
  const sources = new Set();
  const system = (panel === 'strategy' ? prompts.STRATEGY_SYSTEM : prompts.SERVICE_SYSTEM).replace(/web search/gi, 'Google Search').replace(/call the submit_leads tool exactly once with all leads\. Do not write the leads as plain text\./i, 'write the findings report described in the task.');
  try {
    // ---- Evidence mode (free): our own web searches + page reading, one model call ----
    if (useEvidenceMode(webSearch)) {
      const r = await generateFromEvidence(client, { panel, niches, city, count, excludeNames, system, usage });
      for (const u of r.ev.urls) sources.add(u);
      const notes = [`${r.searchNotes}`.slice(0, 1200), `Evidence: ${r.ev.queries.length} searches, ${r.ev.results.length} results, ${r.ev.pages.length} pages read, ${r.ev.phones.size} phone numbers found.`, ...(r.notes.length ? ['Verification: ' + r.notes.join(' | ').slice(0, 800)] : [])];
      return { leads: r.leads, rejected: r.rejected, searchNotes: notes.filter(Boolean).join('\n'), sources: [...sources], usage, model: r.model, webSearchUsed: true, researchMode: 'evidence', warnings: [], keySource: source, report: evidence.render(r.ev, { maxChars: 6000 }) };
    }
    // ---- Native mode: Google Search grounding through the model ----
    const researchPrompt = `${prompts.buildUserPrompt({ panel, niches, city, count, excludeNames, searchEnabled: webSearch }).replace(/Return the leads by calling submit_leads once\./, '')}

OUTPUT FORMAT for this research step (plain text, not JSON): first a line "SEARCH NOTES:" with what you searched and how many real businesses you could confirm; then one section per business:
### <Business name>
- Niche: ...
- City / address: ... (URL where seen, or "not found")
- Phone: <exact digits as seen> (URL where seen) | WhatsApp: ... (URL) | Email: ... (URL) — write "not found" instead of guessing
- Official website: <URL> or "none found after searching" — social pages are NOT websites
- Social profiles: Instagram <URL>, Facebook <URL>, TikTok <URL>, LinkedIn <URL> (only if seen)
- Description and services (from the sources)
- Size / employees / locations / departments: <evidence or "estimated: ..." or "unknown">
- Owners / management / decision-makers: <only names published on a source, with the URL> or "not published"
- ${panel === 'strategy' ? 'Booking method today, online booking status, booking problems observed, and why a website / online booking would (or would not) help this business' : 'Repetitive processes observed, existing software if mentioned, operational challenges, and 2-4 specific automation opportunities (process -> automation -> LATechS service)'}
- Evidence: list of every URL used for this business
- Verification summary: which of name / phone / website / address / socials / people you saw on a source vs estimated
Finish with "END OF REPORT".`;
    const { data, report, model, extractionModel, toolsUsed, warnings } = await researchThenExtract(client, {
      system, researchPrompt, extractionSystem: EXTRACTION_SYSTEM,
      extractionPrompt: `Convert the research report into JSON for the ${panel === 'strategy' ? 'STRATEGY LEADS' : 'SERVICE SALES LEADS'} panel. Requested niches: ${niches.join('; ')}. City: ${city}. Return at most ${count} leads.`,
      schema: LEADS_SCHEMA, webSearch, usage, sources,
    });
    if (warnings.includes('grounding_unavailable') && config.ai.gemini.researchMode === 'auto') {
      // Grounding was refused mid-way: redo this batch in evidence mode rather than trusting memory.
      const r = await generateFromEvidence(client, { panel, niches, city, count, excludeNames, system, usage });
      for (const u of r.ev.urls) sources.add(u);
      const notes = [`${r.searchNotes}`.slice(0, 1200), `Evidence: ${r.ev.queries.length} searches, ${r.ev.results.length} results, ${r.ev.pages.length} pages read, ${r.ev.phones.size} phone numbers found.`, ...(r.notes.length ? ['Verification: ' + r.notes.join(' | ').slice(0, 800)] : [])];
      return { leads: r.leads, rejected: r.rejected, searchNotes: notes.filter(Boolean).join('\n'), sources: [...sources], usage, model: r.model, webSearchUsed: true, researchMode: 'evidence', warnings: [], keySource: source, report: evidence.render(r.ev, { maxChars: 6000 }) };
    }
    const leads = Array.isArray(data.leads) ? data.leads : [];
    const webSearchUsed = webSearch && toolsUsed.includes('google_search');
    const notes = [String(data.search_notes || '').slice(0, 1800)];
    if (warnings.includes('grounding_unavailable')) notes.push('WARNING: web research was not available for this batch; these leads come from the model\'s own knowledge and are saved as "Needs Verification".');
    return { leads, rejected: [], searchNotes: notes.filter(Boolean).join('\n'), sources: [...sources], usage, model: extractionModel === model ? model : `${model} (+${extractionModel})`, webSearchUsed, researchMode: 'native', warnings, keySource: source, report };
  } catch (err) {
    const mapped = mapError(err); mapped.usage = usage; throw mapped;
  }
}

async function generateBusinessProfile({ userId, contact, calls, previousResearch, webSearch }) {
  const { client } = await getClientForUser(userId);
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };
  const sources = new Set();
  const context = analysis.contactContext(contact, calls, previousResearch);
  try {
    if (webSearch && useEvidenceMode(true)) {
      const ev = await evidence.gatherForBusiness({ name: contact.business_name, city: contact.city });
      const { response, model } = await client.generate({
        systemInstruction: { parts: [{ text: analysis.PROFILE_SYSTEM + '\nEVIDENCE MODE: use only the business record, its call history and the evidence provided; copy facts exactly, mark everything else as estimated, and list every evidence URL you relied on in sources_used.' }] },
        contents: [{ role: 'user', parts: [{ text: `${context}\n\n===== EVIDENCE (our own web searches) =====\n${evidence.render(ev)}\n===== END OF EVIDENCE =====\n\nProduce the business profile and customized automation proposal outline for the meeting.` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: config.ai.gemini.maxOutputTokens, responseMimeType: 'application/json', responseSchema: toGeminiSchema(analysis.BUSINESS_PROFILE_SCHEMA) },
      });
      addUsage(usage, response, 0);
      const data = parseJson(candidateText(response));
      if (!data) throw new AppError('Gemini returned an unreadable analysis. Please try again.', 502, 'ai_bad_output');
      for (const u of ev.urls) sources.add(u);
      return { data, sources: [...sources].slice(0, 40), usage, model, researchMode: 'evidence' };
    }
    if (webSearch) {
      const { data, model } = await researchThenExtract(client, {
        system: analysis.PROFILE_SYSTEM.replace(/web search/gi, 'Google Search'),
        researchPrompt: `${context}\n\nResearch this business with Google Search (and open its pages when useful) to confirm services, size, branches, management names that are publicly published, how customers contact it, and its repetitive processes. Write a detailed findings report with a URL for every confirmed fact, clearly marking estimates, and end with a customized automation proposal outline for the meeting.`,
        extractionSystem: 'You convert a research report into strict JSON following the schema. Only use facts from the report; mark estimates; list every URL from the report in sources_used.',
        extractionPrompt: 'Convert the report into the business profile JSON.',
        schema: toGeminiSchema(analysis.BUSINESS_PROFILE_SCHEMA), webSearch: true, usage, sources,
      });
      return { data, sources: [...sources], usage, model };
    }
    const { response, model } = await client.generate({
      systemInstruction: { parts: [{ text: analysis.PROFILE_SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: `${context}\n\nProduce the business profile and customized automation proposal outline for the meeting. No web research is available; mark unverified information clearly.` }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: config.ai.gemini.maxOutputTokens, responseMimeType: 'application/json', responseSchema: toGeminiSchema(analysis.BUSINESS_PROFILE_SCHEMA) },
    });
    addUsage(usage, response, 0);
    const data = parseJson(candidateText(response));
    if (!data) throw new AppError('Gemini returned an unreadable analysis. Please try again.', 502, 'ai_bad_output');
    return { data, sources: [], usage, model };
  } catch (err) { throw mapError(err); }
}

async function generateBookingAnalysis({ userId, contact, calls }) {
  const { client } = await getClientForUser(userId);
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };
  try {
    const { response, model } = await client.generate({
      systemInstruction: { parts: [{ text: analysis.BOOKING_SYSTEM }] },
      contents: [{ role: 'user', parts: [{ text: `${analysis.contactContext(contact, calls, null)}\n\nAnalyse the booking situation and prepare the employee for the next conversation.` }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: config.ai.gemini.maxOutputTokens, responseMimeType: 'application/json', responseSchema: toGeminiSchema(analysis.BOOKING_ANALYSIS_SCHEMA) },
    });
    addUsage(usage, response, 0);
    const data = parseJson(candidateText(response));
    if (!data) throw new AppError('Gemini returned an unreadable analysis. Please try again.', 502, 'ai_bad_output');
    return { data, sources: [], usage, model };
  } catch (err) { throw mapError(err); }
}

function describe() {
  const evidenceMode = useEvidenceMode(config.ai.gemini.webSearch);
  return { provider: 'gemini', provider_label: 'Google Gemini', model: config.ai.gemini.model, fallback_models: config.ai.gemini.fallbackModels, web_search: config.ai.gemini.webSearch, url_context: config.ai.gemini.urlContext, thinking: config.ai.gemini.thinking, research_mode: config.ai.gemini.researchMode, evidence_mode_active: evidenceMode, search_label: evidenceMode ? 'built-in web research (free search engine + page reading)' : 'Google Search grounding' };
}

module.exports = { testConnection, generateLeadCandidates, generateBusinessProfile, generateBookingAnalysis, mapError, describe, getClientForUser, toGeminiSchema, setFetchForTests, resetQuotaMemoryForTests, cooldownFor, useEvidenceMode, GeminiApiError, GeminiClient, LEADS_SCHEMA };

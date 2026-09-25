'use strict';
/**
 * Evidence gathering for lead research without paid grounding: runs several web searches per
 * niche/city, reads the most useful pages, extracts contact facts, and produces an evidence
 * bundle the model must work from. verifyLead() then strips every claim that is not present in
 * that evidence, so nothing fabricated can reach the database.
 */
const config = require('../config');
const logger = require('../logger');
const websearch = require('./websearch.service');
const norm = require('../lib/normalize');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
let fetchImpl = (...a) => fetch(...a);
function setFetchForTests(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }

const SKIP_HOSTS = /(^|\.)(youtube\.com|youtu\.be|pinterest\.|amazon\.|daraz\.pk|olx\.|wikipedia\.org|reddit\.com|quora\.com|tiktok\.com|x\.com|twitter\.com|apple\.com|play\.google\.com)$/i;
const NO_FETCH_HOSTS = /(^|\.)(instagram\.com|facebook\.com|fb\.com|linkedin\.com|threads\.net)$/i; // block bots: use search snippets only
const PHONE_RE = /(?:\+?92[\s\-.]?\d{2,3}[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}|(?<!\d)0\d{2,3}[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}(?!\d)|(?<!\d)03\d{2}[\s\-.]?\d{7}(?!\d))/g;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const SOCIAL_RE = /https?:\/\/(?:www\.)?(?:instagram\.com|facebook\.com|fb\.com|tiktok\.com|linkedin\.com\/(?:company|in)|wa\.me|api\.whatsapp\.com)\/[^\s"'<>)]+/gi;

function buildQueries({ panel, niche, city }) {
  const base = `${niche} ${city}`;
  const qs = panel === 'strategy'
    ? [`${base}`, `${base} instagram`, `${base} facebook`, `${base} whatsapp booking`, `${niche} in ${city} contact number`, `best ${niche} ${city} appointment`]
    : [`${base}`, `${base} contact number`, `${base} facebook`, `${base} linkedin`, `${niche} in ${city} office`, `top ${niche} ${city}`];
  return qs.map((q) => q.replace(/\s+/g, ' ').trim());
}

function extractFacts(text) {
  const phones = new Set();
  for (const m of String(text).matchAll(PHONE_RE)) { const n = norm.normalizePhone(m[0]); if (n) phones.add(n); }
  const emails = new Set([...String(text).matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase()));
  const socials = new Set([...String(text).matchAll(SOCIAL_RE)].map((m) => m[0].replace(/[.,;:!?)]+$/, '')));
  return { phones: [...phones], emails: [...emails], socials: [...socials] };
}

function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s) || [])[1];
  const desc = (/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i.exec(s) || [])[1];
  const links = [...s.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)].map((m) => m[1]);
  s = s.replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr|section|article)>/gi, '\n').replace(/<[^>]+>/g, ' ');
  s = websearch.decodeEntities(s.replace(/\n{2,}/g, '\n'));
  return { title: websearch.decodeEntities(title || ''), description: websearch.decodeEntities(desc || ''), text: s, links };
}

/** Reads a page through Jina Reader (markdown) when the site refuses direct fetches from this network. */
async function fetchPageViaJina(url) {
  try {
    const r = await websearch.readViaJina(url, { timeoutMs: config.evidence.pageTimeoutMs + 7000 });
    if (r.status !== 200 || !r.text) return null;
    const title = (/^Title:\s*(.+)$/m.exec(r.text) || [])[1] || '';
    const body = r.text.split(/\nMarkdown Content:\n/)[1] || r.text;
    const links = [...body.matchAll(/\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
    const text = websearch.decodeEntities(body.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[#*_>`]+/g, ' '));
    const facts = extractFacts(body + '\n' + links.join('\n'));
    return { url, title: websearch.decodeEntities(title), description: '', text: text.slice(0, config.evidence.maxPageChars), via: 'jina_reader', ...facts };
  } catch (err) { return null; }
}

async function fetchPage(url, { jinaFallback } = {}) {
  let blocked = false;
  try {
    const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(config.evidence.pageTimeoutMs) });
    const ct = res.headers.get('content-type') || '';
    if (!res.ok) blocked = res.status === 403 || res.status === 429 || res.status === 503 || res.status === 401;
    if (!res.ok || !/text\/html|application\/xhtml/.test(ct)) { if (blocked && jinaFallback && jinaFallback.left > 0) { jinaFallback.left--; return fetchPageViaJina(url); } return null; }
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    let html = '';
    if (reader) {
      const dec = new TextDecoder();
      while (html.length < config.evidence.maxPageBytes) { const { done, value } = await reader.read(); if (done) break; html += dec.decode(value, { stream: true }); }
      reader.cancel().catch(() => {});
    } else html = (await res.text()).slice(0, config.evidence.maxPageBytes);
    const parsed = htmlToText(html);
    const facts = extractFacts(html + '\n' + parsed.links.join('\n'));
    if (parsed.text.length < 100 && /cloudflare|enable javascript|access denied|attention required|just a moment/i.test(html) && jinaFallback && jinaFallback.left > 0) { jinaFallback.left--; return fetchPageViaJina(url); }
    return { url: res.url || url, title: parsed.title, description: parsed.description, text: parsed.text.slice(0, config.evidence.maxPageChars), ...facts };
  } catch (err) {
    if (jinaFallback && jinaFallback.left > 0 && !/abort|timeout/i.test(err.name + err.message)) { jinaFallback.left--; return fetchPageViaJina(url); }
    return null;
  }
}

const gatherCache = new Map(); // panel|niche|city -> { at, ev }: a retried batch (model overloaded) reuses its evidence
const GATHER_CACHE_MS = 10 * 60 * 1000;
function clearCacheForTests() { gatherCache.clear(); }

/** Gathers evidence for one niche/city. Returns { queries, results, pages, corpus, phones, urls, elapsed_ms }. */
async function gather({ panel, niche, city, timeBudgetMs = config.evidence.timeBudgetMs, maxPages = config.evidence.maxPages }) {
  const cacheKey = `${panel}|${niche}|${city}`;
  const hit = gatherCache.get(cacheKey);
  if (hit && Date.now() - hit.at < GATHER_CACHE_MS) return { ...hit.ev, cached: true };
  const ev = await gatherUncached({ panel, niche, city, timeBudgetMs, maxPages });
  if (ev.results.length) gatherCache.set(cacheKey, { at: Date.now(), ev });
  return ev;
}
async function gatherUncached({ panel, niche, city, timeBudgetMs, maxPages }) {
  const started = Date.now();
  const queries = buildQueries({ panel, niche, city });
  const seen = new Map(); // url -> result
  for (const q of queries) {
    if (Date.now() - started > timeBudgetMs * 0.5) break;
    const results = await websearch.search(q, { count: 10 });
    for (const r of results) {
      let host; try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch (_) { continue; }
      if (SKIP_HOSTS.test(host)) continue;
      if (!seen.has(r.url)) seen.set(r.url, { ...r, host, queries: [q] }); else seen.get(r.url).queries.push(q);
    }
  }
  const results = [...seen.values()];
  const fetchable = results.filter((r) => !NO_FETCH_HOSTS.test(r.host)).slice(0, maxPages);
  const pages = [];
  const concurrency = 4;
  const jinaFallback = { left: config.evidence.jinaPageFallbacks };
  let idx = 0;
  async function worker() {
    while (idx < fetchable.length && Date.now() - started < timeBudgetMs) {
      const r = fetchable[idx++];
      const page = await fetchPage(r.url, { jinaFallback });
      if (page && page.text.length > 100) pages.push(page);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, fetchable.length) }, worker));
  const snippetText = results.map((r) => `${r.title} ${r.snippet} ${r.url}`).join('\n');
  const corpus = (snippetText + '\n' + pages.map((p) => `${p.url}\n${p.title}\n${p.description}\n${p.text}\n${p.socials.join('\n')}`).join('\n')).toLowerCase();
  const phones = new Set(extractFacts(snippetText).phones);
  for (const p of pages) for (const ph of p.phones) phones.add(ph);
  const urls = new Set(results.map((r) => r.url));
  for (const p of pages) { urls.add(p.url); for (const s of p.socials) urls.add(s); }
  logger.info('Evidence gathered', { niche, city, queries: queries.length, results: results.length, pages: pages.length, phones: phones.size, elapsed_ms: Date.now() - started });
  return { queries, results, pages, corpus, phones, urls, elapsed_ms: Date.now() - started };
}

/** Renders the evidence bundle for the model. */
function render(ev, { maxChars = config.evidence.maxPromptChars } = {}) {
  const parts = [];
  parts.push(`SEARCH QUERIES RUN: ${ev.queries.join(' | ')}`);
  parts.push('SEARCH RESULTS (title — url — snippet):');
  ev.results.forEach((r, i) => parts.push(`${i + 1}. ${r.title} — ${r.url} — ${r.snippet}`));
  parts.push('\nPAGE EXTRACTS:');
  for (const p of ev.pages) {
    parts.push(`--- ${p.url} | ${p.title}${p.description ? ' | ' + p.description : ''}`);
    if (p.phones.length) parts.push(`Phones on this page: ${p.phones.map(norm.formatPhoneForDisplay).join(', ')}`);
    if (p.emails.length) parts.push(`Emails on this page: ${p.emails.join(', ')}`);
    if (p.socials.length) parts.push(`Social links on this page: ${p.socials.slice(0, 12).join(', ')}`);
    parts.push(p.text.slice(0, 3500));
  }
  let out = parts.join('\n');
  if (out.length > maxChars) out = out.slice(0, maxChars) + '\n[evidence truncated]';
  return out;
}

/**
 * Follow-up lookup for a verified lead without a phone number: one search for the business itself,
 * phones taken only from results that name the business. Returns { phone, source_url, snippet } or null.
 */
async function findPhoneFor({ name, city }) {
  const n = norm.normalizeBusinessName(name);
  if (!n) return null;
  const results = await websearch.search(`"${name}" ${city} contact number`, { count: 8 });
  const tally = new Map(); // normalized phone -> { count, raw, url, snippet }
  for (const r of results) {
    const text = `${r.title} ${r.snippet}`;
    if (!nameInCorpus(name, norm.normalizeBusinessName(text) + ' ' + text.toLowerCase())) continue;
    for (const m of text.matchAll(PHONE_RE)) {
      const key = norm.normalizePhone(m[0]);
      if (!key) continue;
      const t = tally.get(key) || { count: 0, raw: m[0].trim(), url: r.url, snippet: r.snippet };
      t.count++;
      tally.set(key, t);
    }
  }
  if (!tally.size) return null;
  const best = [...tally.values()].sort((a, b) => b.count - a.count)[0];
  return { phone: best.raw, normalized: [...tally.entries()].find(([, v]) => v === best)[0], source_url: best.url, snippet: best.snippet };
}

function nameInCorpus(name, corpus) {
  const n = norm.normalizeBusinessName(name);
  if (!n) return false;
  if (corpus.includes(n)) return true;
  const tokens = norm.nameTokens(n).filter((t) => t.length >= 3);
  if (!tokens.length) return false;
  const found = tokens.filter((t) => corpus.includes(t)).length;
  return found / tokens.length >= 0.75 && tokens.length >= 2 ? true : found === tokens.length;
}

/**
 * Enforces that every hard fact in a lead exists in the evidence. Returns
 * { ok, lead, reason, changes[] }. Unsupported values are nulled and marked unknown.
 */
function verifyLead(rawLead, ev) {
  const lead = JSON.parse(JSON.stringify(rawLead || {}));
  const changes = [];
  const corpus = ev.corpus || '';
  if (!lead.business_name || !nameInCorpus(lead.business_name, corpus)) return { ok: false, reason: 'not_in_evidence', lead, changes };
  const fv = Object.assign({ business_name: 'unknown', phone: 'unknown', website: 'unknown', address: 'unknown', social_profiles: 'unknown', people: 'unknown' }, lead.field_verification || {});
  fv.business_name = 'verified';
  const digitsCorpus = corpus.replace(/[^\d]/g, '');
  const phoneOk = (v) => { const n = norm.normalizePhone(v); return n && (ev.phones.has(n) || digitsCorpus.includes(n) || digitsCorpus.includes(n.replace(/^92/, '0'))); };
  if (lead.phone) { if (phoneOk(lead.phone)) fv.phone = 'verified'; else { changes.push(`phone removed (not in evidence): ${lead.phone}`); lead.phone = null; fv.phone = 'unknown'; } }
  if (lead.whatsapp) { if (!phoneOk(lead.whatsapp)) { changes.push('whatsapp removed (not in evidence)'); lead.whatsapp = null; } else if (fv.phone !== 'verified') fv.phone = 'verified'; }
  if (lead.public_email) { if (!corpus.includes(String(lead.public_email).toLowerCase())) { changes.push('email removed (not in evidence)'); lead.public_email = null; } }
  if (lead.website) {
    const d = norm.normalizeDomain(lead.website);
    // A domain counts as evidenced only when it appears as a host (not inside a social-profile path such as instagram.com/<domain-like handle>)
    const hosts = new Set([...ev.urls].map((u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch (_) { return null; } }).filter(Boolean));
    const esc = d ? d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
    const asHost = d && (hosts.has(d) || new RegExp(`(^|[\\s(<"']|://)(www\\.)?${esc}(?=$|[\\s/)>"',])`, 'i').test(corpus));
    if (!asHost) { changes.push(`website removed (not in evidence): ${lead.website}`); lead.website = null; if (lead.website_status === 'has_website') lead.website_status = 'unknown'; fv.website = 'unknown'; } else fv.website = 'verified';
  }
  const sp = lead.social_profiles && typeof lead.social_profiles === 'object' ? lead.social_profiles : {};
  let socialVerified = false;
  for (const k of Object.keys(sp)) {
    if (!sp[k]) continue;
    const c = norm.classifyUrl(sp[k]);
    const handle = c.kind === 'social' ? c.handle : null;
    const ok = (handle && corpus.includes(handle.toLowerCase())) || corpus.includes(String(sp[k]).toLowerCase().replace(/^https?:\/\/(www\.)?/, ''));
    if (!ok) { changes.push(`social ${k} removed (not in evidence)`); sp[k] = null; } else socialVerified = true;
  }
  lead.social_profiles = sp;
  fv.social_profiles = socialVerified ? 'verified' : 'unknown';
  if (lead.address) { const tokens = String(lead.address).toLowerCase().split(/[\s,]+/).filter((t) => t.length >= 4); const found = tokens.filter((t) => corpus.includes(t)).length; fv.address = tokens.length && found / tokens.length >= 0.5 ? 'verified' : 'estimated'; }
  for (const key of ['owners', 'management', 'decision_makers']) {
    if (!Array.isArray(lead[key])) continue;
    const kept = lead[key].filter((p) => p && p.name && corpus.includes(String(p.name).toLowerCase()));
    if (kept.length !== lead[key].length) changes.push(`${lead[key].length - kept.length} unpublished ${key} removed`);
    lead[key] = kept;
  }
  fv.people = ['owners', 'management', 'decision_makers'].some((k) => Array.isArray(lead[k]) && lead[k].length) ? 'verified' : 'unknown';
  lead.source_urls = [...new Set((Array.isArray(lead.source_urls) ? lead.source_urls : []).filter((u) => ev.urls.has(u) || corpus.includes(String(u).toLowerCase())))];
  if (!lead.source_urls.length) {
    // attach the evidence URLs whose text mentions the business
    const n = norm.normalizeBusinessName(lead.business_name);
    for (const r of ev.results) if (norm.normalizeBusinessName(`${r.title} ${r.snippet}`).includes(n) || norm.nameSimilarity(n, norm.normalizeBusinessName(r.title)) >= 0.86) lead.source_urls.push(r.url);
    for (const p of ev.pages) if (p.text.toLowerCase().includes(n) && !lead.source_urls.includes(p.url)) lead.source_urls.push(p.url);
    lead.source_urls = lead.source_urls.slice(0, 8);
  }
  lead.field_verification = fv;
  const hasChannel = !!(lead.phone || lead.whatsapp || Object.values(sp).some(Boolean));
  if (!hasChannel) return { ok: false, reason: 'no_public_contact_channel', lead, changes };
  lead.confidence = fv.phone === 'verified' ? (lead.source_urls.length ? 'verified' : 'partially_verified') : (socialVerified ? 'partially_verified' : 'needs_verification');
  return { ok: true, lead, changes };
}

/** Evidence about one specific business (for meeting preparation). */
async function gatherForBusiness({ name, city, timeBudgetMs = config.evidence.timeBudgetMs, maxPages = 6 }) {
  const started = Date.now();
  const base = `"${name}" ${city || 'Pakistan'}`;
  const queries = [base, `${name} ${city || ''} contact`, `${name} facebook`, `${name} instagram`, `${name} ${city || ''} reviews`].map((q) => q.replace(/\s+/g, ' ').trim());
  const seen = new Map();
  for (const q of queries) {
    if (Date.now() - started > timeBudgetMs * 0.5) break;
    for (const r of await websearch.search(q, { count: 8 })) {
      let host; try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch (_) { continue; }
      if (SKIP_HOSTS.test(host)) continue;
      if (!seen.has(r.url)) seen.set(r.url, { ...r, host, queries: [q] });
    }
  }
  const results = [...seen.values()];
  const n = norm.normalizeBusinessName(name);
  const relevant = results.filter((r) => norm.normalizeBusinessName(`${r.title} ${r.snippet}`).includes(n) || norm.nameSimilarity(n, norm.normalizeBusinessName(r.title)) >= 0.7);
  const fetchable = (relevant.length ? relevant : results).filter((r) => !NO_FETCH_HOSTS.test(r.host)).slice(0, maxPages);
  const pages = [];
  const jinaFallback = { left: config.evidence.jinaPageFallbacks };
  for (const r of fetchable) { if (Date.now() - started > timeBudgetMs) break; const page = await fetchPage(r.url, { jinaFallback }); if (page && page.text.length > 200) pages.push(page); }
  const snippetText = results.map((r) => `${r.title} ${r.snippet} ${r.url}`).join('\n');
  const corpus = (snippetText + '\n' + pages.map((p) => `${p.url}\n${p.title}\n${p.description}\n${p.text}`).join('\n')).toLowerCase();
  const phones = new Set(extractFacts(snippetText).phones); for (const p of pages) for (const ph of p.phones) phones.add(ph);
  const urls = new Set(results.map((r) => r.url)); for (const p of pages) urls.add(p.url);
  return { queries, results, pages, corpus, phones, urls, elapsed_ms: Date.now() - started };
}

module.exports = { gather, gatherForBusiness, render, verifyLead, buildQueries, extractFacts, htmlToText, fetchPage, fetchPageViaJina, findPhoneFor, setFetchForTests, clearCacheForTests, nameInCorpus };

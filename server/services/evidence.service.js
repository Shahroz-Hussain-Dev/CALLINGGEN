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
const criteriaLib = require('../lib/criteria');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
let fetchImpl = (...a) => fetch(...a);
function setFetchForTests(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }

const SKIP_HOSTS = /(^|\.)(youtube\.com|youtu\.be|pinterest\.|amazon\.|daraz\.pk|olx\.|wikipedia\.org|reddit\.com|quora\.com|tiktok\.com|x\.com|twitter\.com|apple\.com|play\.google\.com)$/i;
const NO_FETCH_HOSTS = /(^|\.)(instagram\.com|facebook\.com|fb\.com|linkedin\.com|threads\.net)$/i; // block bots: use search snippets only
const PHONE_RE = /(?:\+?92[\s\-.]?\d{2,3}[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}|(?<!\d)0\d{2,3}[\s\-.]?\d{3,4}[\s\-.]?\d{3,4}(?!\d)|(?<!\d)03\d{2}[\s\-.]?\d{7}(?!\d))/g;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const SOCIAL_RE = /https?:\/\/(?:www\.)?(?:instagram\.com|facebook\.com|fb\.com|tiktok\.com|linkedin\.com\/(?:company|in)|wa\.me|api\.whatsapp\.com)\/[^\s"'<>)]+/gi;

/**
 * Query plan for one niche/city. Returns [{ q, recency }] where recency limits the search to recently
 * published pages ('w' = week, 'm' = month) when the criteria ask for businesses opened within a window.
 */
function buildQueries({ panel, niche, city, criteria = null }) {
  const base = `${niche} ${city}`;
  const c = criteria && typeof criteria === 'object' ? criteria : null;
  const recency = c && c.max_age_days ? (c.max_age_days <= 10 ? 'w' : c.max_age_days <= 45 ? 'm' : null) : null;
  const year = new Date().getFullYear();
  let plan;
  if (recency) {
    // Newly opened businesses: recent pages first, one undated query for phone directories.
    const singular = niche.replace(/\b(Clinics|Studios|Salons|Parlours|Practices|Centers|Centres|Businesses|Companies|Agencies|Offices|Labs)\b/i, (m) => m.replace(/s$/i, '').replace(/ie$/i, 'y'));
    plan = [
      { q: `${base}`, recency },
      { q: `new ${singular} ${city} "now open" OR "grand opening" OR "newly opened" OR "opening soon"`, recency },
      { q: `${base} "just opened" OR "new ${singular.split(' ').pop().toLowerCase()}" OR launched OR inauguration`, recency },
      { q: `${base} instagram`, recency },
      { q: `${base} facebook`, recency },
      { q: `${niche} in ${city} contact number`, recency: null },
    ];
  } else if (panel === 'strategy') {
    plan = [`${base}`, `${base} instagram`, `${base} facebook`, `${base} whatsapp booking`, `${niche} in ${city} contact number`, `best ${niche} ${city} appointment`].map((q) => ({ q, recency: null }));
    if (c && (c.stage === 'startup' || c.founded_from_year)) {
      plan.splice(5, 1, { q: `${niche} ${city} "opening soon" OR "new" instagram`, recency: null });
      plan.push({ q: `new ${niche} ${city} ${c.founded_from_year || year}`, recency: null }, { q: `${niche} ${city} "newly opened" OR "grand opening" OR "now open" OR "just launched"`, recency: null });
    }
  } else {
    plan = [`${base}`, `${base} contact number`, `${base} facebook`, `${base} linkedin`, `${niche} in ${city} office`, `top ${niche} ${city}`].map((q) => ({ q, recency: null }));
    if (c && (c.stage === 'startup' || c.founded_from_year)) plan.push({ q: `new ${niche} ${city} ${c.founded_from_year || year}`, recency: null }, { q: `${niche} ${city} "newly opened" OR "just launched" OR "now open"`, recency: null });
  }
  if (c && c.leadership === 'female_preferred' && !recency) plan.push({ q: `${niche} ${city} "female" OR "woman" OR "her" owner`, recency: null });
  const seen = new Set();
  return plan.map((x) => ({ q: x.q.replace(/\s+/g, ' ').trim(), recency: x.recency })).filter((x) => !seen.has(x.q) && seen.add(x.q));
}

// ---- Opening evidence: "now open / grand opening / newly opened ..." with a date when one is stated ----
const OPENING_RE = /(now open(?:ed)?|grand opening|soft opening|newly opened|new(?:ly)? (?:clinic|salon|studio|practice|branch|parlou?r|centre|center|office)|opening soon|just (?:opened|launched|started)|soft launch|inaugurat\w*|we are (?:now )?open|opened (?:our|its) doors|our first (?:day|week|month)|launching|officially open|first (?:clinic|salon|studio|branch)|est\.? ?20\d\d|since 20\d\d|opened (?:in|on) )/i;
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
/** Parses an absolute or relative date mentioned in text. Returns a Date or null. */
function parseMentionedDate(text, now = new Date()) {
  const s = String(text || '');
  let m;
  if ((m = /\b((?:19|20)\d{2})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?\b(?!\d)/.exec(s))) return new Date(Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 15));
  if ((m = /(\d{1,2})[\/.](\d{1,2})[\/.](20\d{2})/.exec(s))) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  if ((m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?,?\s+(20\d{2})/i.exec(s))) return new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase().slice(0, 4)] ?? MONTHS[m[2].toLowerCase().slice(0, 3)], +m[1]));
  if ((m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(20\d{2})/i.exec(s))) return new Date(Date.UTC(+m[3], MONTHS[m[1].toLowerCase().slice(0, 4)] ?? MONTHS[m[1].toLowerCase().slice(0, 3)], +m[2]));
  if ((m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(20\d{2})/i.exec(s))) return new Date(Date.UTC(+m[2], MONTHS[m[1].toLowerCase().slice(0, 4)] ?? MONTHS[m[1].toLowerCase().slice(0, 3)], 15));
  if ((m = /\b(\d{1,2})\s+(hours?|days?|weeks?|months?)\s+ago\b/i.exec(s))) { const n = +m[1]; const unit = m[2].toLowerCase(); const days = unit.startsWith('hour') ? n / 24 : unit.startsWith('day') ? n : unit.startsWith('week') ? n * 7 : n * 30; return new Date(now.getTime() - days * 86400000); }
  if (/\b(yesterday|today)\b/i.test(s)) return new Date(now.getTime() - (/yesterday/i.test(s) ? 1 : 0) * 86400000);
  if (/\blast week\b/i.test(s)) return new Date(now.getTime() - 7 * 86400000);
  if (/\bthis (week|month)\b/i.test(s)) return new Date(now.getTime() - 3 * 86400000);
  return null;
}
/**
 * Finds an opening announcement about the business in the evidence. Returns
 * { quote, source_url, opened_on, dated_within, recent_page } or null.
 */
function openingEvidenceFor(lead, ev, maxAgeDays, now = new Date()) {
  const n = norm.normalizeBusinessName(lead.business_name || '');
  if (!n) return null;
  const handle = lead.social_profiles && lead.social_profiles.instagram ? (norm.classifyUrl(lead.social_profiles.instagram).handle || '').toLowerCase() : '';
  const docs = [
    ...(ev.results || []).map((r) => ({ text: `${r.title} ${r.snippet}`, url: r.url, recent: !!r.recent })),
    ...(ev.pages || []).map((p) => ({ text: `${p.title} ${p.description} ${p.text}`, url: p.url, recent: !!p.recent })),
  ];
  const since = now.getTime() - (maxAgeDays || 30) * 86400000 - 7 * 86400000; // a week of grace for undated re-posts
  let best = null;
  for (const d of docs) {
    const low = d.text.toLowerCase();
    const mentions = norm.normalizeBusinessName(d.text).includes(n) || (handle && low.includes(handle));
    if (!mentions) continue;
    const m = OPENING_RE.exec(d.text);
    if (!m) continue;
    const at = m.index;
    const window = d.text.slice(Math.max(0, at - 140), at + 160).replace(/\s+/g, ' ').trim();
    const date = parseMentionedDate(window, now);
    const cand = { quote: window.slice(0, 220), source_url: d.url, opened_on: date ? date.toISOString().slice(0, 10) : null, dated_within: date ? date.getTime() >= since : null, recent_page: d.recent };
    if (cand.dated_within === false) { if (!best) best = cand; continue; } // an old dated announcement: remember it, keep looking for a newer one
    if (!best || best.dated_within === false || (cand.dated_within && !best.dated_within) || (!best.recent_page && cand.recent_page)) best = cand;
    if (best.dated_within) break;
  }
  return best;
}

const DESK_RE = /reception|appointment|front ?desk|helpline|booking|clinic (?:number|no|line)|landline|office (?:number|no)|ptcl|uan|for appointments?/i;
/**
 * Finds a person's own (direct) number from public pages: numbers printed next to the person's name,
 * mobile preferred, numbers labelled as reception/appointment lines skipped. Searches the evidence already
 * gathered first, then one targeted web search. Returns { number, source_url, kind, context } or null.
 */
async function findDirectNumber({ personName, businessName, city, ev = null, businessPhone = null }) {
  const name = String(personName || '').replace(/^dr\.?\s*/i, '').trim();
  if (name.length < 3) return null;
  const nameRe = new RegExp(`\\b(?:dr\\.?\\s*)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\s+/g, '\\s+')}\\b`, 'i');
  const biz = norm.normalizePhone(businessPhone);
  const candidates = new Map(); // normalized -> { score, raw, url, context }
  const scan = (text, url) => {
    const s = String(text || '').replace(/\s+/g, ' ');
    let m;
    const nameIdx = [];
    const re = new RegExp(nameRe.source, 'gi');
    while ((m = re.exec(s))) nameIdx.push(m.index);
    if (!nameIdx.length) return;
    let lastPhoneEnd = 0;
    for (const pm of s.matchAll(PHONE_RE)) {
      const norm_ = norm.normalizePhone(pm[0]);
      const segStart = Math.max(lastPhoneEnd, s.lastIndexOf('.', pm.index - 1) + 1, pm.index - 70);
      lastPhoneEnd = pm.index + pm[0].length;
      if (!norm_ || norm_ === biz) continue;
      const dist = Math.min(...nameIdx.map((i) => Math.abs(i - pm.index)));
      if (dist > 160) continue;
      // the label that belongs to this number sits between the previous number / sentence and it
      const context = s.slice(segStart, pm.index + pm[0].length + 30);
      if (DESK_RE.test(context)) continue;
      const mobile = norm_.startsWith('923');
      let score = (mobile ? 3 : 1) + (dist < 60 ? 2 : dist < 120 ? 1 : 0) + (/whatsapp|cell|mobile|direct|personal|contact dr|call dr/i.test(context) ? 2 : 0);
      const cur = candidates.get(norm_);
      if (!cur || cur.score < score) candidates.set(norm_, { score, raw: pm[0].trim(), url, context: context.trim().slice(0, 160), mobile });
    }
  };
  if (ev) { for (const p of ev.pages || []) scan(`${p.title} ${p.text}`, p.url); for (const r of ev.results || []) scan(`${r.title} ${r.snippet}`, r.url); }
  if (![...candidates.values()].some((c) => c.mobile)) {
    const results = await websearch.search(`"${name}" ${city || ''} ${businessName ? `"${businessName}"` : ''} contact OR whatsapp OR mobile`.replace(/\s+/g, ' ').trim(), { count: 8 });
    for (const r of results) scan(`${r.title} ${r.snippet}`, r.url);
    const own = results.filter((r) => { try { return !NO_FETCH_HOSTS.test(new URL(r.url).hostname) && !SKIP_HOSTS.test(new URL(r.url).hostname); } catch (_) { return false; } }).slice(0, 2);
    for (const r of own) { const page = await fetchPage(r.url); if (page) scan(`${page.title} ${page.text}`, page.url); }
  }
  if (!candidates.size) return null;
  const best = [...candidates.entries()].sort((a, b) => b[1].score - a[1].score)[0];
  return { number: best[1].raw, normalized: best[0], source_url: best[1].url, kind: best[1].mobile ? 'direct_mobile' : 'landline', context: best[1].context, person: personName };
}

const AUDIENCE_RE = /([\d.,]+\s?[KkMm]?)\s*Followers?,\s*([\d.,]+\s?[KkMm]?)\s*Following,\s*([\d.,]+\s?[KkMm]?)\s*Posts?/i;
function parseCount(s) {
  const m = /([\d.,]+)\s?([KkMm])?/.exec(String(s || ''));
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (m[2] ? (m[2].toLowerCase() === 'k' ? 1000 : 1000000) : 1));
}
/** Instagram follower / post counts for a business, taken from search snippets that name it or its handle. */
function audienceFor(lead, ev) {
  const handle = lead.social_profiles && lead.social_profiles.instagram ? (norm.classifyUrl(lead.social_profiles.instagram).handle || '').toLowerCase() : '';
  const n = norm.normalizeBusinessName(lead.business_name || '');
  for (const r of ev.results || []) {
    const text = `${r.title} ${r.snippet}`;
    const m = AUDIENCE_RE.exec(text);
    if (!m) continue;
    const low = text.toLowerCase();
    if ((handle && (low.includes(`@${handle}`) || String(r.url).toLowerCase().includes(`instagram.com/${handle}`))) || (n && norm.normalizeBusinessName(text).includes(n))) {
      return { instagram_followers: parseCount(m[1]), instagram_posts: parseCount(m[3]), source_url: r.url };
    }
  }
  return null;
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
async function gather({ panel, niche, city, criteria = null, timeBudgetMs = config.evidence.timeBudgetMs, maxPages = config.evidence.maxPages }) {
  const cacheKey = `${panel}|${niche}|${city}|${JSON.stringify(criteria || {})}`;
  const hit = gatherCache.get(cacheKey);
  if (hit && Date.now() - hit.at < GATHER_CACHE_MS) return { ...hit.ev, cached: true };
  const ev = await gatherUncached({ panel, niche, city, criteria, timeBudgetMs, maxPages });
  if (ev.results.length) gatherCache.set(cacheKey, { at: Date.now(), ev });
  return ev;
}
async function gatherUncached({ panel, niche, city, criteria, timeBudgetMs, maxPages }) {
  const started = Date.now();
  const queries = buildQueries({ panel, niche, city, criteria });
  const seen = new Map(); // url -> result
  const runQueries = async () => {
    for (const { q, recency } of queries) {
      if (Date.now() - started > timeBudgetMs * 0.65) break;
      const results = await websearch.search(q, { count: 10, recency });
      for (const r of results) {
        let host; try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch (_) { continue; }
        if (SKIP_HOSTS.test(host)) continue;
        if (!seen.has(r.url)) seen.set(r.url, { ...r, host, queries: [q] }); else { const e = seen.get(r.url); e.queries.push(q); if (r.recent) e.recent = r.recent; }
      }
    }
  };
  await runQueries();
  if (!seen.size) {
    // Nothing at all usually means the search engines are cooling down after a rate limit: wait it out once when it is short.
    const wait = Math.min(...['jina_reader', 'duckduckgo', 'serper', 'brave', 'tavily', 'jina', 'google_cse'].map((e) => websearch.blockedFor(e)).filter((ms) => ms > 0), Infinity);
    if (Number.isFinite(wait) && wait <= config.evidence.cooldownWaitMaxMs && Date.now() - started + wait < timeBudgetMs * 0.6) {
      logger.warn('Evidence gathering found nothing; waiting for the search engine cooldown', { wait_ms: wait });
      await new Promise((r) => setTimeout(r, wait + 500));
      websearch.cache.clear();
      await runQueries();
    }
  }
  const results = [...seen.values()];
  const fetchable = results.filter((r) => !NO_FETCH_HOSTS.test(r.host)).slice(0, maxPages);
  const pages = [];
  const concurrency = config.evidence.pageConcurrency || 6;
  const jinaFallback = { left: config.evidence.jinaPageFallbacks };
  let idx = 0;
  async function worker() {
    while (idx < fetchable.length && Date.now() - started < timeBudgetMs) {
      const r = fetchable[idx++];
      const page = await fetchPage(r.url, { jinaFallback });
      if (page && page.text.length > 100) pages.push({ ...page, recent: !!r.recent });
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
  parts.push(`SEARCH QUERIES RUN: ${ev.queries.map((q) => (typeof q === 'string' ? q : q.q)).join(' | ')}`);
  parts.push('SEARCH RESULTS (title — url — snippet):');
  ev.results.forEach((r, i) => parts.push(`${i + 1}. ${r.recent ? '[recent page] ' : ''}${r.title} — ${r.url} — ${r.snippet}`));
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
function verifyLead(rawLead, ev, criteria = null) {
  const lead = JSON.parse(JSON.stringify(rawLead || {}));
  const changes = [];
  const corpus = ev.corpus || '';
  if (!lead.business_name || !nameInCorpus(lead.business_name, corpus)) return { ok: false, reason: 'not_in_evidence', lead, changes };
  // Targeting facts: quotes must exist in the evidence, a founding year must appear in it, audience counts come from snippets.
  const squash = (t) => String(t || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const squashedCorpus = squash(corpus);
  const signals = (Array.isArray(lead.startup_signals) ? lead.startup_signals : []).map((q) => String(q || '').trim()).filter((q) => q.length >= 8 && squashedCorpus.includes(squash(q).replace(/^["'“”]+|["'“”]+$/g, '')));
  if (Array.isArray(lead.startup_signals) && signals.length !== lead.startup_signals.length) changes.push(`${lead.startup_signals.length - signals.length} startup signal(s) removed (not in evidence)`);
  lead.startup_signals = signals.slice(0, 5);
  if (lead.founded_year !== null && lead.founded_year !== undefined) {
    // a founding year must be stated as such in the sources ("est. 2026", "opened in 2026"), not merely appear somewhere
    const y = String(lead.founded_year);
    const stated = /^\d{4}$/.test(y) && new RegExp(`(est\\.?|estd\\.?|established|since|founded|opened|open(?:ed|ing) (?:its|our|the) doors|started|launched|new in|opening in|coming soon in|inaugurat\\w+)[^.\\n]{0,30}\\b${y}\\b|\\b${y}\\b[^.\\n]{0,12}(launch|grand opening|newly opened|inaugurat)`, 'i').test(corpus);
    if (!stated) { changes.push(`founded_year removed (not stated in evidence): ${y}`); lead.founded_year = null; }
  }
  if (lead.team_size_estimate !== null && lead.team_size_estimate !== undefined && !Number.isFinite(Number(lead.team_size_estimate))) lead.team_size_estimate = null;
  if (typeof lead.female_led !== 'boolean') lead.female_led = null;
  lead.audience = audienceFor(lead, ev);
  // Opening evidence: what the server finds in the evidence wins; the model's quote counts only when it is in the evidence.
  const maxAge = criteria && criteria.max_age_days ? criteria.max_age_days : 30;
  let opening = openingEvidenceFor(lead, ev, maxAge);
  if (!opening && lead.opening_quote && squashedCorpus.includes(squash(lead.opening_quote).replace(/^["'“”]+|["'“”]+$/g, ''))) {
    const date = parseMentionedDate(lead.opened_on || '') || parseMentionedDate(lead.opening_quote || '');
    opening = { quote: String(lead.opening_quote).slice(0, 220), source_url: null, opened_on: date ? date.toISOString().slice(0, 10) : null, dated_within: date ? date.getTime() >= Date.now() - (maxAge + 7) * 86400000 : null, recent_page: false };
  }
  if (opening && !opening.opened_on && lead.opened_on) { const d = parseMentionedDate(lead.opened_on); if (d) { opening.opened_on = d.toISOString().slice(0, 10); opening.dated_within = d.getTime() >= Date.now() - (maxAge + 7) * 86400000; } }
  lead.opening = opening;
  delete lead.opening_quote; delete lead.opened_on;
  if (criteriaLib.isActive(criteria)) {
    const chk = criteriaLib.check(lead, criteria, { followers: lead.audience ? lead.audience.instagram_followers : null, opening });
    if (!chk.ok) return { ok: false, reason: chk.reason, lead, changes };
    lead.criteria_match = chk.match;
  }
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

module.exports = { gather, gatherForBusiness, render, verifyLead, buildQueries, extractFacts, htmlToText, fetchPage, fetchPageViaJina, findPhoneFor, findDirectNumber, audienceFor, openingEvidenceFor, parseMentionedDate, setFetchForTests, clearCacheForTests, nameInCorpus };

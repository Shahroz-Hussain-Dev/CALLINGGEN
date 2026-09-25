'use strict';
/**
 * Web search used for evidence gathering. Engines share one interface, search(query, {count}) ->
 * [{ title, url, snippet }], and are tried in order until one answers (see engineChain()):
 *   keyed engines (Serper, Brave, Google Programmable Search, Tavily, Jina Search) when configured,
 *   then the key-less engines: DuckDuckGo (direct), Jina Reader proxy (DuckDuckGo Lite / Bing rendered
 *   by r.jina.ai, which works from cloud networks that the search engines block), and Bing RSS.
 * Blocked or rate-limited engines are put on cooldown; results are cached in memory for a short time.
 */
const config = require('../config');
const logger = require('../logger');
const settings = require('./settings.service');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const cache = new Map(); // query -> { at, results }
const CACHE_MS = 15 * 60 * 1000;
let lastRequestAt = 0;
let fetchImpl = (...a) => fetch(...a);
function setFetchForTests(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }

function decodeEntities(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
function decodeDdgUrl(href) {
  let h = String(href || '');
  if (h.startsWith('//')) h = 'https:' + h;
  try {
    const u = new URL(h, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    if (target) return target;
    if (/duckduckgo\.com\/l\//.test(u.href)) return null;
    return u.href;
  } catch (_) { return null; }
}

/** Bing result links are redirects (bing.com/ck/a?...&u=a1<base64url>): recover the target URL. */
function decodeBingUrl(href) {
  const h = String(href || '');
  try {
    const u = new URL(h);
    if (!/(^|\.)bing\.com$/.test(u.hostname) || !u.pathname.startsWith('/ck/')) return /^https?:\/\//.test(h) ? h : null;
    const packed = u.searchParams.get('u') || '';
    if (!packed.startsWith('a1')) return null;
    const b64 = packed.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const target = Buffer.from(b64 + '='.repeat((4 - (b64.length % 4)) % 4), 'base64').toString('utf8');
    return /^https?:\/\//.test(target) ? target : null;
  } catch (_) { return null; }
}
const MD_JUNK_HOSTS = /(^|\.)(duckduckgo\.com|bing\.com|microsoft\.com|jina\.ai|google\.com|live\.com|msn\.com)$/i;
function cleanMarkdownText(s) { return decodeEntities(String(s || '').replace(/\*\*\*\*/g, ' ').replace(/\*\*/g, '').replace(/\\([\[\]()*_])/g, '$1').replace(/(\w)&(\s)/g, '$1 &$2')); }
/**
 * Parses a search result page rendered as markdown by Jina Reader. Both DuckDuckGo Lite and Bing
 * render as a numbered list: "N.[title](link)" or "N.   ## [title](link)" followed by the snippet.
 */
function parseJinaMarkdown(md, decodeLink) {
  const out = [];
  const body = String(md || '').split(/\n\s*Links\/Buttons:/)[0];
  const re = /^\s*\d+\.\s*(?:#+\s*)?\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)\s*\n([\s\S]*?)(?=^\s*\d+\.\s*(?:#+\s*)?\[|\s*$)/gm;
  let m;
  while ((m = re.exec(body))) {
    const url = decodeLink(m[2]);
    if (!url || !/^https?:\/\//.test(url)) continue;
    let host; try { host = new URL(url).hostname; } catch (_) { continue; }
    if (MD_JUNK_HOSTS.test(host)) continue;
    const snippet = m[3].split('\n').map((l) => l.trim()).filter((l) => l && !/^https?:\/\//.test(l) && !/^[\w.-]+\.[a-z]{2,}(\/\S*)?$/i.test(l)).join(' ');
    out.push({ title: cleanMarkdownText(m[1]), url, snippet: cleanMarkdownText(snippet) });
  }
  return out;
}

/** Drops results that share no word with the query (a proxied engine sometimes serves an unrelated cached page). */
function relevantOnly(results, query) {
  const tokens = String(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
  if (!tokens.length) return results;
  return results.filter((r) => { const hay = `${r.title} ${r.snippet} ${r.url}`.toLowerCase(); return tokens.some((t) => hay.includes(t)); });
}

const JINA_READER = 'https://r.jina.ai/';
let lastJinaAt = 0;
let jinaRateLimitedUntil = 0; // key-less Jina Reader allows ~20 requests/minute per IP
/** Fetches a URL rendered as markdown by Jina Reader (key-less; the JINA_API_KEY raises the rate limit when set). */
async function readViaJina(targetUrl, { timeoutMs = config.websearch.timeoutMs } = {}) {
  if (jinaRateLimitedUntil > Date.now()) throw new BlockedError('Jina Reader rate limit cooldown', jinaRateLimitedUntil - Date.now());
  const wait = lastJinaAt + config.websearch.jinaGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastJinaAt = Date.now();
  const headers = { Accept: 'text/plain', 'X-Timeout': String(Math.max(5, Math.floor(timeoutMs / 1000) - 3)), 'X-Return-Format': 'markdown' };
  if (keys.jina) headers.Authorization = `Bearer ${keys.jina}`;
  const res = await fetchImpl(JINA_READER + targetUrl, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (res.status === 429) { jinaRateLimitedUntil = Date.now() + config.websearch.jinaRateLimitCooldownMs; throw new BlockedError('Jina Reader rate limit (HTTP 429)', config.websearch.jinaRateLimitCooldownMs); }
  if (res.status === 401 || res.status === 402) throw new BlockedError(`Jina Reader returned HTTP ${res.status}`);
  return { status: res.status, text, remaining: Number(res.headers && res.headers.get ? res.headers.get('x-ratelimit-remaining') : NaN) };
}

async function throttle() {
  const gap = config.websearch.minGapMs;
  const wait = lastRequestAt + gap - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function getHtml(url) {
  await throttle();
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(config.websearch.timeoutMs) });
  const text = await res.text();
  return { status: res.status, text };
}

function parseDdgHtml(html) {
  const out = [];
  const blocks = html.split(/<div class="result results_links/);
  for (const b of blocks.slice(1)) {
    const a = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b);
    if (!a) continue;
    const url = decodeDdgUrl(a[1]);
    if (!url || !/^https?:\/\//.test(url)) continue;
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(b) || /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:span|div|td)>/.exec(b);
    out.push({ title: decodeEntities(a[2]), url, snippet: sn ? decodeEntities(sn[1]) : '' });
  }
  return out;
}
function parseDdgLite(html) {
  const out = [];
  const re = /<a rel="nofollow" href="([^"]+)" class='result-link'>([\s\S]*?)<\/a>[\s\S]*?<td class='result-snippet'>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    const url = decodeDdgUrl(m[1]);
    if (url && /^https?:\/\//.test(url)) out.push({ title: decodeEntities(m[2]), url, snippet: decodeEntities(m[3]) });
  }
  return out;
}

const engineBlockedUntil = new Map(); // engine -> timestamp (blocked / rate-limited engines are skipped for a while)
const ENGINE_COOLDOWN_MS = 30 * 60 * 1000;
const emptyStreak = new Map(); // engine -> consecutive empty answers (an engine that keeps returning nothing is soft-throttling us)
const EMPTY_STREAK_LIMIT = 2;
const EMPTY_COOLDOWN_MS = 10 * 60 * 1000;
class BlockedError extends Error { constructor(msg, cooldownMs) { super(msg); this.blocked = true; this.cooldownMs = cooldownMs || ENGINE_COOLDOWN_MS; } }

function parseBingRss(xml) {
  const out = [];
  const clean = (v) => decodeEntities(String(v || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const title = (/<title>([\s\S]*?)<\/title>/.exec(block) || [])[1];
    const link = (/<link>([\s\S]*?)<\/link>/.exec(block) || [])[1];
    const desc = (/<description>([\s\S]*?)<\/description>/.exec(block) || [])[1];
    const url = clean(link);
    if (/^https?:\/\//.test(url)) out.push({ title: clean(title), url, snippet: clean(desc) });
  }
  return out;
}

let lastBingAt = 0;
let keys = {}; // merged keys: environment + owner-stored (refreshed by loadKeys)
async function loadKeys() {
  const stored = await settings.getWebSearchKeys();
  keys = {
    serper: stored.serper || config.search.serperApiKey || '',
    jina: stored.jina || config.websearch.jinaApiKey || '',
    tavily: stored.tavily || config.websearch.tavilyApiKey || '',
    brave: stored.brave || config.websearch.braveApiKey || '',
    google_cse_key: stored.google_cse_key || config.websearch.googleCseKey || '',
    google_cse_id: stored.google_cse_id || config.websearch.googleCseId || '',
  };
  return keys;
}

const engines = {
  async jina(query, count) {
    if (!keys.jina) throw new Error('Jina API key not set');
    await throttle();
    const res = await fetchImpl(`https://s.jina.ai/?q=${encodeURIComponent(query)}&gl=pk&hl=en&num=${Math.min(10, count)}`, { headers: { Authorization: `Bearer ${keys.jina}`, Accept: 'application/json', 'X-Respond-With': 'no-content' }, signal: AbortSignal.timeout(config.websearch.timeoutMs) });
    if (res.status === 401 || res.status === 402 || res.status === 429) throw new BlockedError(`Jina returned HTTP ${res.status}`);
    if (!res.ok) throw new Error(`Jina returned HTTP ${res.status}`);
    const j = await res.json();
    return (j.data || []).map((x) => ({ title: x.title || '', url: x.url, snippet: x.description || x.content || '' })).filter((x) => /^https?:\/\//.test(x.url || '')).slice(0, count);
  },
  async tavily(query, count) {
    if (!keys.tavily) throw new Error('Tavily API key not set');
    await throttle();
    const res = await fetchImpl('https://api.tavily.com/search', { method: 'POST', headers: { Authorization: `Bearer ${keys.tavily}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, max_results: Math.min(10, count), search_depth: 'basic', country: 'pakistan' }), signal: AbortSignal.timeout(config.websearch.timeoutMs) });
    if (res.status === 401 || res.status === 432 || res.status === 429) throw new BlockedError(`Tavily returned HTTP ${res.status}`);
    if (!res.ok) throw new Error(`Tavily returned HTTP ${res.status}`);
    const j = await res.json();
    return (j.results || []).map((x) => ({ title: x.title || '', url: x.url, snippet: x.content || '' })).slice(0, count);
  },
  async google_cse(query, count) {
    const googleCseKey = keys.google_cse_key, googleCseId = keys.google_cse_id;
    if (!googleCseKey || !googleCseId) throw new Error('GOOGLE_CSE_API_KEY / GOOGLE_CSE_ID not set');
    await throttle();
    const res = await fetchImpl(`https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(googleCseKey)}&cx=${encodeURIComponent(googleCseId)}&gl=pk&num=${Math.min(10, count)}&q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(config.websearch.timeoutMs) });
    if (res.status === 429 || res.status === 403) throw new BlockedError(`Google Programmable Search returned HTTP ${res.status} (daily quota?)`);
    if (!res.ok) throw new Error(`Google Programmable Search returned HTTP ${res.status}`);
    const j = await res.json();
    return (j.items || []).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet || '' })).slice(0, count);
  },
  async bing(query, count) {
    // Bing quietly returns an empty feed when queried too quickly: keep a wider gap between Bing calls.
    const wait = lastBingAt + config.websearch.bingGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastBingAt = Date.now();
    await throttle();
    const res = await fetchImpl(`https://www.bing.com/search?format=rss&mkt=en-PK&cc=PK&setlang=en&count=${Math.min(50, Math.max(10, count))}&q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml,application/xml,text/xml,*/*', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(config.websearch.timeoutMs) });
    const text = await res.text();
    if (res.status === 403 || res.status === 429) throw new BlockedError(`Bing returned HTTP ${res.status}`);
    if (!res.ok) throw new Error(`Bing returned HTTP ${res.status}`);
    const results = parseBingRss(text);
    if (!results.length && !/<rss/.test(text)) throw new BlockedError('Bing did not return RSS results');
    return results.slice(0, count);
  },
  /** Key-less proxy engine: search result pages rendered by Jina Reader (works where engines block cloud IPs). */
  async jina_reader(query, count) {
    const sources = [
      ['duckduckgo_lite', `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&kl=pk-en`, decodeDdgUrl],
      ['bing', `https://www.bing.com/search?q=${encodeURIComponent(query)}&mkt=en-PK&setlang=en`, decodeBingUrl],
    ];
    let lastErr = null;
    for (const [name, url, decode] of sources) {
      try {
        const r = await readViaJina(url);
        if (r.status !== 200) { lastErr = new Error(`Jina Reader (${name}) returned HTTP ${r.status}`); continue; }
        const results = relevantOnly(parseJinaMarkdown(r.text, decode), query);
        if (results.length) return results.slice(0, count);
        if (/anomaly|captcha|challenge|unusual traffic|are you a robot|access denied/i.test(r.text.slice(0, 6000))) lastErr = new Error(`${name} challenged Jina Reader`);
      } catch (err) { if (err.blocked) throw err; lastErr = err; }
    }
    if (lastErr) throw lastErr;
    return [];
  },
  async duckduckgo(query, count) {
    let r = await getHtml('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&kl=pk-en');
    if (r.status === 403 || r.status === 202 || r.status === 429) throw new BlockedError(`DuckDuckGo returned HTTP ${r.status}`);
    let results = r.status === 200 ? parseDdgHtml(r.text) : [];
    if (!results.length) {
      r = await getHtml('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query) + '&kl=pk-en');
      if (r.status === 403 || r.status === 202 || r.status === 429) throw new BlockedError(`DuckDuckGo returned HTTP ${r.status}`);
      results = r.status === 200 ? parseDdgLite(r.text) : [];
      if (!results.length && r.status !== 200) throw new Error(`DuckDuckGo returned HTTP ${r.status}`);
    }
    return results.slice(0, count);
  },
  async brave(query, count) {
    const key = keys.brave;
    if (!key) throw new Error('BRAVE_SEARCH_API_KEY not set');
    await throttle();
    const res = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&country=PK`, { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, signal: AbortSignal.timeout(config.websearch.timeoutMs) });
    if (!res.ok) throw new Error(`Brave Search returned HTTP ${res.status}`);
    const j = await res.json();
    return ((j.web && j.web.results) || []).map((x) => ({ title: x.title, url: x.url, snippet: x.description || '' })).slice(0, count);
  },
  async serper(query, count) {
    const key = keys.serper;
    if (!key) throw new Error('SERPER_API_KEY not set');
    await throttle();
    const res = await fetchImpl('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query, gl: 'pk', num: count }), signal: AbortSignal.timeout(config.websearch.timeoutMs) });
    if (res.status === 401 || res.status === 403 || res.status === 429) throw new BlockedError(`Serper returned HTTP ${res.status}`);
    if (!res.ok) throw new Error(`Serper returned HTTP ${res.status}`);
    const j = await res.json();
    return (j.organic || []).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet || '' })).slice(0, count);
  },
};

const FREE_ENGINES = ['duckduckgo', 'jina_reader', 'bing'];
/** Engine order: keyed engines (Google-quality first) when configured, then the free key-less engines (preferred one first). */
function engineChain() {
  const preferred = config.websearch.engine;
  const chain = [];
  if (keys.serper) chain.push('serper');
  if (keys.brave) chain.push('brave');
  if (keys.google_cse_key && keys.google_cse_id) chain.push('google_cse');
  if (keys.tavily) chain.push('tavily');
  if (keys.jina) chain.push('jina');
  const free = FREE_ENGINES;
  if (free.includes(preferred)) chain.push(preferred, ...free.filter((f) => f !== preferred));
  else chain.push(...free);
  if (!free.includes(preferred) && chain.includes(preferred)) { const i = chain.indexOf(preferred); if (i > 0) { chain.splice(i, 1); chain.unshift(preferred); } }
  return chain;
}
function activeEngines() { const now = Date.now(); const all = engineChain(); const live = all.filter((e) => (engineBlockedUntil.get(e) || 0) <= now); return live.length ? live : all; }

/** Searches the web. Never throws for a single engine failure; returns [] when every engine fails. */
async function search(query, { count = 8 } = {}) {
  await loadKeys();
  const key = `${query}|${count}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;
  let lastErr = null;
  let sawEmpty = false;
  for (const name of activeEngines()) {
    try {
      const results = await engines[name](query, count);
      if (!results.length) { // an engine with no answer: let the next one try; repeated silence means it is throttling us
        sawEmpty = true;
        const streak = (emptyStreak.get(name) || 0) + 1;
        emptyStreak.set(name, streak);
        if (streak >= EMPTY_STREAK_LIMIT && activeEngines().length > 1) { engineBlockedUntil.set(name, Date.now() + EMPTY_COOLDOWN_MS); logger.warn('Web search engine demoted after repeated empty answers', { engine: name }); }
        continue;
      }
      emptyStreak.set(name, 0);
      cache.set(key, { at: Date.now(), results, engine: name });
      return results;
    } catch (err) {
      lastErr = err;
      if (err.blocked) engineBlockedUntil.set(name, Date.now() + (err.cooldownMs || ENGINE_COOLDOWN_MS));
      logger.warn('Web search engine failed', { engine: name, blocked: !!err.blocked, error: err.message.slice(0, 120) });
    }
  }
  if (sawEmpty && !lastErr) { cache.set(key, { at: Date.now(), results: [], engine: null }); return []; }
  logger.warn('All web search engines failed', { query: query.slice(0, 80), error: lastErr && lastErr.message });
  return [];
}

async function describe() { await loadKeys(); const chain = engineChain(); const live = activeEngines(); return { engine: live[0], engines: chain, blocked: chain.filter((e) => !live.includes(e)), keyed: chain.filter((e) => !FREE_ENGINES.includes(e)), free: FREE_ENGINES.includes(live[0]) }; }
function resetForTests() { cache.clear(); engineBlockedUntil.clear(); emptyStreak.clear(); lastRequestAt = 0; lastBingAt = 0; lastJinaAt = 0; jinaRateLimitedUntil = 0; settings.clearKeyCache(); }

module.exports = { search, describe, readViaJina, relevantOnly, setFetchForTests, resetForTests, parseDdgHtml, parseDdgLite, parseBingRss, parseJinaMarkdown, decodeDdgUrl, decodeBingUrl, decodeEntities, engines, cache, FREE_ENGINES };

'use strict';
/**
 * Free, key-less web search used for evidence gathering (default engine: DuckDuckGo HTML).
 * Optional keyed engines can be added here; the interface is search(query, {count}) ->
 * [{ title, url, snippet }]. Results are cached in memory for a short time.
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
class BlockedError extends Error { constructor(msg) { super(msg); this.blocked = true; } }

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

/** Engine order: keyed engines when configured, then the preferred free engine, then the other free engines. */
/** Engine order: keyed engines (Google-quality first) when configured, then the free key-less engines. */
function engineChain() {
  const preferred = config.websearch.engine;
  const chain = [];
  if (keys.serper) chain.push('serper');
  if (keys.brave) chain.push('brave');
  if (keys.google_cse_key && keys.google_cse_id) chain.push('google_cse');
  if (keys.tavily) chain.push('tavily');
  if (keys.jina) chain.push('jina');
  const free = ['duckduckgo', 'bing'];
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
      if (!results.length) { sawEmpty = true; continue; } // an engine with no answer: let the next one try
      cache.set(key, { at: Date.now(), results, engine: name });
      return results;
    } catch (err) {
      lastErr = err;
      if (err.blocked) engineBlockedUntil.set(name, Date.now() + ENGINE_COOLDOWN_MS);
      logger.warn('Web search engine failed', { engine: name, blocked: !!err.blocked, error: err.message.slice(0, 120) });
    }
  }
  if (sawEmpty && !lastErr) { cache.set(key, { at: Date.now(), results: [], engine: null }); return []; }
  logger.warn('All web search engines failed', { query: query.slice(0, 80), error: lastErr && lastErr.message });
  return [];
}

async function describe() { await loadKeys(); const chain = engineChain(); const live = activeEngines(); return { engine: live[0], engines: chain, blocked: chain.filter((e) => !live.includes(e)), keyed: chain.filter((e) => !['duckduckgo', 'bing'].includes(e)), free: ['duckduckgo', 'bing'].includes(live[0]) }; }
function resetForTests() { cache.clear(); engineBlockedUntil.clear(); lastRequestAt = 0; lastBingAt = 0; settings.clearKeyCache(); }

module.exports = { search, describe, setFetchForTests, resetForTests, parseDdgHtml, parseDdgLite, parseBingRss, decodeDdgUrl, decodeEntities, engines, cache };

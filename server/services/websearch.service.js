'use strict';
/**
 * Free, key-less web search used for evidence gathering (default engine: DuckDuckGo HTML).
 * Optional keyed engines can be added here; the interface is search(query, {count}) ->
 * [{ title, url, snippet }]. Results are cached in memory for a short time.
 */
const config = require('../config');
const logger = require('../logger');

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

const engines = {
  async duckduckgo(query, count) {
    let r = await getHtml('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '&kl=pk-en');
    let results = r.status === 200 ? parseDdgHtml(r.text) : [];
    if (!results.length) {
      r = await getHtml('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query) + '&kl=pk-en');
      results = r.status === 200 ? parseDdgLite(r.text) : [];
      if (!results.length && r.status !== 200) throw new Error(`DuckDuckGo returned HTTP ${r.status}`);
    }
    return results.slice(0, count);
  },
  async brave(query, count) {
    const key = config.websearch.braveApiKey;
    if (!key) throw new Error('BRAVE_SEARCH_API_KEY not set');
    await throttle();
    const res = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&country=PK`, { headers: { Accept: 'application/json', 'X-Subscription-Token': key }, signal: AbortSignal.timeout(config.websearch.timeoutMs) });
    if (!res.ok) throw new Error(`Brave Search returned HTTP ${res.status}`);
    const j = await res.json();
    return ((j.web && j.web.results) || []).map((x) => ({ title: x.title, url: x.url, snippet: x.description || '' })).slice(0, count);
  },
  async serper(query, count) {
    const key = config.search.serperApiKey;
    if (!key) throw new Error('SERPER_API_KEY not set');
    await throttle();
    const res = await fetchImpl('https://google.serper.dev/search', { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q: query, gl: 'pk', num: count }), signal: AbortSignal.timeout(config.websearch.timeoutMs) });
    if (!res.ok) throw new Error(`Serper returned HTTP ${res.status}`);
    const j = await res.json();
    return (j.organic || []).map((x) => ({ title: x.title, url: x.link, snippet: x.snippet || '' })).slice(0, count);
  },
};

function engineChain() {
  const preferred = config.websearch.engine;
  const chain = [];
  if (preferred === 'brave' && config.websearch.braveApiKey) chain.push('brave');
  if (preferred === 'serper' && config.search.serperApiKey) chain.push('serper');
  if (config.websearch.braveApiKey && !chain.includes('brave')) chain.push('brave');
  if (config.search.serperApiKey && !chain.includes('serper')) chain.push('serper');
  chain.push('duckduckgo');
  if (preferred === 'duckduckgo') return ['duckduckgo', ...chain.filter((c) => c !== 'duckduckgo')];
  return chain;
}

/** Searches the web. Never throws for a single engine failure; returns [] when every engine fails. */
async function search(query, { count = 8 } = {}) {
  const key = `${query}|${count}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.results;
  let lastErr = null;
  for (const name of engineChain()) {
    try {
      const results = await engines[name](query, count);
      cache.set(key, { at: Date.now(), results, engine: name });
      return results;
    } catch (err) { lastErr = err; logger.warn('Web search engine failed', { engine: name, error: err.message.slice(0, 120) }); }
  }
  logger.warn('All web search engines failed', { query: query.slice(0, 80), error: lastErr && lastErr.message });
  return [];
}

function describe() { return { engine: engineChain()[0], engines: engineChain(), free: engineChain()[0] === 'duckduckgo' }; }

module.exports = { search, describe, setFetchForTests, parseDdgHtml, parseDdgLite, decodeDdgUrl, decodeEntities, engines, cache };

'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const ai = require('../services/ai.service');
const apiKeys = require('../services/apiKeys.service');
const search = require('../services/search');
const websearch = require('../services/websearch.service');

const router = express.Router();
router.use(['/ai', '/claude'], requireAuth);

async function status(req, res) {
  const provider = req.query.provider || undefined;
  res.json({ ...(await apiKeys.getStatus(req.user.id, provider)), ...(provider && provider !== ai.activeName() ? {} : ai.describe()), search: search.describe(), web_research: await websearch.describe(), active_provider: ai.activeName() });
}
async function test(req, res) { res.json(await ai.testConnection(req.user.id)); }
async function saveKey(req, res) { res.json(await apiKeys.saveKey(req.user, (req.body || {}).api_key, (req.body || {}).provider)); }
async function removeKey(req, res) { res.json(await apiKeys.removeKey(req.user, (req.body || {}).provider || req.query.provider)); }

// Read-only self-test of the free web research layer (fixed query, no data written)
router.get('/ai/search-test', async (req, res) => {
  const started = Date.now();
  const q = 'bridal makeup studio Lahore instagram';
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const probes = [
    ['duckduckgo_html', `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=pk-en`, /class="result__a"/g],
    ['bing_rss', `https://www.bing.com/search?format=rss&mkt=en-PK&cc=PK&setlang=en&count=10&q=${encodeURIComponent(q)}`, /<item>/g],
    ['bing_html', `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en&cc=PK`, /class="b_algo"/g],
    ['yahoo_html', `https://search.yahoo.com/search?p=${encodeURIComponent(q)}&n=10`, /class="algo|class="compTitle/g],
    ['mojeek_html', `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`, /class="ob"/g],
    ['qwant_api', `https://api.qwant.com/v3/search/web?q=${encodeURIComponent(q)}&t=web&locale=en_GB&count=10&offset=0`, /"url":"https?:/g],
    ['google_html', `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en&gl=pk&num=10`, /<div class="g"|<a href="\/url\?q=/g],
    ['startpage_html', `https://www.startpage.com/do/search?q=${encodeURIComponent(q)}&cat=web&language=english`, /class="w-gl__result|result-link/g],
  ];
  const diagnostics = [];
  for (const [name, url, marker] of probes) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml,application/json,*/*', 'Accept-Language': 'en-US,en;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
      const text = await r.text();
      diagnostics.push({ engine: name, status: r.status, length: text.length, matches: (text.match(marker) || []).length, blocked: /anomaly|captcha|challenge|unusual traffic|are you a robot|access denied/i.test(text.slice(0, 8000)), head: text.replace(/\s+/g, ' ').slice(0, 120) });
    } catch (err) { diagnostics.push({ engine: name, error: err.message.slice(0, 120) }); }
  }
  websearch.resetForTests();
  const results = await websearch.search(q, { count: 5 });
  res.json({ ok: results.length > 0, engine: await websearch.describe(), results: results.map((r) => ({ title: r.title, url: r.url })), diagnostics, latency_ms: Date.now() - started });
});

// Current routes + legacy aliases (/api/claude/*) used by older clients
for (const prefix of ['/ai', '/claude']) {
  router.get(`${prefix}/status`, status);
  router.post(`${prefix}/test`, test);
  router.post(`${prefix}/key`, saveKey);
  router.delete(`${prefix}/key`, removeKey);
}

module.exports = router;

'use strict';
/** Unit tests for the free web research layer (no network). */
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const websearch = require('../server/services/websearch.service');
const evidence = require('../server/services/evidence.service');
const settings = require('../server/services/settings.service');
let storedKeys = {};
settings.getWebSearchKeys = async () => storedKeys; // no database in these unit tests

const DDG_HTML = `<div class="result results_links results_links_deep web-result "><div class="links_main links_deep result__body"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.instagram.com%2Fglowstudio.pk%2F&amp;rut=abc">Glow Studio (@glowstudio.pk) &#x2022; Instagram</a></h2><a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.instagram.com%2Fglowstudio.pk%2F">Bridal makeup studio Lahore. Bookings on WhatsApp 0300-1234567</a></div></div>
<div class="result results_links results_links_deep web-result "><div class="links_main"><h2 class="result__title"><a rel="nofollow" class="result__a" href="https://example-directory.pk/lahore/salons">Salons in Lahore | Directory</a></h2><a class="result__snippet" href="https://example-directory.pk/lahore/salons">Top salons with phone numbers</a></div></div>`;

test('parses DuckDuckGo HTML results and decodes redirect links', () => {
  const r = websearch.parseDdgHtml(DDG_HTML);
  assert.equal(r.length, 2);
  assert.equal(r[0].url, 'https://www.instagram.com/glowstudio.pk/');
  assert.match(r[0].title, /Glow Studio/);
  assert.match(r[0].snippet, /0300-1234567/);
  assert.equal(r[1].url, 'https://example-directory.pk/lahore/salons');
});

test('parses Bing RSS results and fails over to Bing when DuckDuckGo is blocked', async () => {
  const rss = '<?xml version="1.0"?><rss><channel><item><title>NOOREYS - Makeup Studio | Lahore</title><link>https://www.facebook.com/nooreysmakeupstudio/</link><description>Bridal makeup &amp; WhatsApp bookings 0325-4066555</description></item><item><title>Bad</title><link>javascript:void(0)</link><description>x</description></item></channel></rss>';
  const r = websearch.parseBingRss(rss);
  assert.equal(r.length, 1); assert.equal(r[0].url, 'https://www.facebook.com/nooreysmakeupstudio/'); assert.match(r[0].snippet, /& WhatsApp bookings 0325-4066555/);
  websearch.resetForTests();
  const hits = [];
  websearch.setFetchForTests(async (url) => { hits.push(url.split('?')[0]); if (/duckduckgo/.test(url)) return { status: 403, text: async () => 'blocked' }; return { ok: true, status: 200, text: async () => rss }; });
  try {
    const a = await websearch.search('bridal makeup Lahore', { count: 5 });
    assert.equal(a.length, 1);
    const b = await websearch.search('another query', { count: 5 });
    assert.equal(b.length, 1);
    assert.equal(hits.filter((h) => /^https:\/\/(html|lite)\.duckduckgo/.test(h)).length, 1, 'DuckDuckGo is skipped after being blocked once');
    assert.ok((await websearch.describe()).blocked.includes('duckduckgo'));
  } finally { websearch.setFetchForTests(null); websearch.resetForTests(); }
});

const JINA_LITE_MD = `Title: bridal makeup studio Lahore at DuckDuckGo

URL Source: https://lite.duckduckgo.com/lite/?q=bridal%20makeup%20studio%20Lahore&kl=pk-en

Markdown Content:
1.[NUMRA - Makeup Studio & Salon | Lahore - Facebook](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.facebook.com%2FNumraMakeupS%2F&rut=b229)
NUMRA Salon is a luxury **bridal****makeup**& hair salon located in **Lahore**.
www.facebook.com/NumraMakeupS/

2.[Makeup Studio (@zainabsharifmakeupstudio) - Instagram](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.instagram.com%2Fzainabsharifmakeupstudio%2F&rut=5247)
40K Followers - Zainab Sharif | **Makeup****Studio** Garden Town, **Lahore** 📞 0311-4857825
www.instagram.com/zainabsharifmakeupstudio/

3.[Next page](https://lite.duckduckgo.com/lite/?q=x&s=10)

Links/Buttons:
- [NUMRA - Makeup Studio & Salon | Lahore - Facebook](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.facebook.com%2FNumraMakeupS%2F&rut=b229)
`;
const JINA_BING_MD = `Title: bridal makeup studio Lahore - Bing

URL Source: https://www.bing.com/search?q=bridal%20makeup%20studio%20Lahore&mkt=en-PK&setlang=en

Markdown Content:
About 39,500 results

1.   ## [Manam **Studio** — **Makeup Studio**& Salon | **Lahore**](https://www.bing.com/ck/a?!&&p=9564&ptn=3&ver=2&hsh=4&fclid=256c&u=a1aHR0cHM6Ly9tYW5hbXN0dWRpb2FuZHNhbG9uLmNvbS8&ntb=1)

Manam Studio — Premium Makeup Studio & Salon in Lahore. Bridal Makeup, Hair Treatments, Facials & more at 994 Ravi Block, …

2.   ## [Bridal Makeup Lahore - Iram Asif Beauty & Care](https://www.bing.com/ck/a?!&&p=f974&u=a1aHR0cHM6Ly9pcmFtYmVhdXR5c2Fsb24uY29tL2JyaWRhbC1tYWtldXAtbGFob3JlLw&ntb=1)

We have transformed hundreds of brides across Lahore.

Links/Buttons:
- [2](https://www.bing.com/search?q=bridal+makeup&first=11&FORM=PERE)
`;

test('parses search result pages rendered by Jina Reader (DuckDuckGo Lite and Bing) and decodes redirect links', () => {
  const ddg = websearch.parseJinaMarkdown(JINA_LITE_MD, websearch.decodeDdgUrl);
  assert.deepEqual(ddg.map((r) => r.url), ['https://www.facebook.com/NumraMakeupS/', 'https://www.instagram.com/zainabsharifmakeupstudio/']);
  assert.equal(ddg[0].title, 'NUMRA - Makeup Studio & Salon | Lahore - Facebook');
  assert.match(ddg[0].snippet, /luxury bridal makeup & hair salon located in Lahore/);
  assert.match(ddg[1].snippet, /0311-4857825/);
  assert.equal(websearch.decodeBingUrl('https://www.bing.com/ck/a?!&&p=9564&u=a1aHR0cHM6Ly9tYW5hbXN0dWRpb2FuZHNhbG9uLmNvbS8&ntb=1'), 'https://manamstudioandsalon.com/');
  assert.equal(websearch.decodeBingUrl('https://example.pk/page'), 'https://example.pk/page');
  assert.equal(websearch.decodeBingUrl('https://www.bing.com/ck/a?u=zz'), null);
  const bing = websearch.parseJinaMarkdown(JINA_BING_MD, websearch.decodeBingUrl);
  assert.deepEqual(bing.map((r) => r.url), ['https://manamstudioandsalon.com/', 'https://irambeautysalon.com/bridal-makeup-lahore/']);
  assert.equal(bing[0].title, 'Manam Studio — Makeup Studio & Salon | Lahore');
  assert.match(bing[0].snippet, /994 Ravi Block/);
});

test('jina_reader engine answers when direct engines are blocked, and backs off on a Jina 429', async () => {
  websearch.resetForTests();
  const hits = [];
  let jinaStatus = 200;
  websearch.setFetchForTests(async (url) => {
    hits.push(url);
    if (/^https:\/\/r\.jina\.ai\//.test(url)) return { status: jinaStatus, headers: { get: (h) => (h === 'x-ratelimit-remaining' ? '17' : null) }, text: async () => (jinaStatus === 200 && /duckduckgo/.test(url) ? JINA_LITE_MD : jinaStatus === 200 ? JINA_BING_MD : 'rate limited') };
    if (/duckduckgo/.test(url)) return { status: 403, text: async () => 'blocked' };
    return { ok: true, status: 200, text: async () => '<?xml version="1.0"?><rss><channel></channel></rss>' }; // Bing RSS: empty feed
  });
  try {
    const a = await websearch.search('bridal makeup Lahore', { count: 5 });
    assert.equal(a.length, 2);
    assert.equal(a[1].url, 'https://www.instagram.com/zainabsharifmakeupstudio/');
    assert.ok(hits.some((h) => h.startsWith('https://r.jina.ai/https://lite.duckduckgo.com/lite/')), 'DuckDuckGo Lite was read through Jina Reader');
    assert.equal(websearch.cache.get('bridal makeup Lahore|5').engine, 'jina_reader');
    jinaStatus = 429;
    const b = await websearch.search('second query', { count: 5 });
    assert.deepEqual(b, [], 'Jina rate-limited and Bing RSS empty -> no results, no throw');
    const d = await websearch.describe();
    assert.ok(d.blocked.includes('duckduckgo') && d.blocked.includes('jina_reader'), 'blocked engines sit on cooldown: ' + JSON.stringify(d));
    const jinaCalls = hits.filter((h) => h.startsWith('https://r.jina.ai/')).length;
    await websearch.search('third query', { count: 5 });
    assert.equal(hits.filter((h) => h.startsWith('https://r.jina.ai/')).length, jinaCalls, 'no Jina call while on cooldown');
  } finally { websearch.setFetchForTests(null); websearch.resetForTests(); }
});

test('an engine that keeps answering nothing is demoted so the next engine gets tried first', async () => {
  websearch.resetForTests();
  const md = JINA_LITE_MD;
  websearch.setFetchForTests(async (url) => {
    if (/^https:\/\/r\.jina\.ai\//.test(url)) return { status: 200, headers: { get: () => null }, text: async () => md };
    return { status: 200, text: async () => '<html><body>no results</body></html>' }; // direct DuckDuckGo: 200 but empty
  });
  try {
    await websearch.search('q1', { count: 5 });
    await websearch.search('q2', { count: 5 });
    const d = await websearch.describe();
    assert.ok(d.blocked.includes('duckduckgo'), 'duckduckgo demoted after two empty answers: ' + JSON.stringify(d));
    assert.equal(d.engine, 'jina_reader');
  } finally { websearch.setFetchForTests(null); websearch.resetForTests(); }
});

test('fetchPage falls back to Jina Reader when a site blocks direct fetches', async () => {
  websearch.resetForTests();
  websearch.setFetchForTests(async (url) => ({ status: 200, headers: { get: () => null }, text: async () => 'Title: Glow Studio Lahore\n\nURL Source: https://glowstudio.pk/\n\nMarkdown Content:\n# Glow Studio\n\nBridal makeup in Johar Town, Lahore. Call **0321-1112223** or [WhatsApp](https://wa.me/923211112223) · [Instagram](https://www.instagram.com/glowstudio.pk/)\n\nWe offer bridal makeup, party makeup, hair styling and facials. Bookings by appointment only, walk-ins on weekdays.' }));
  evidence.setFetchForTests(async () => ({ ok: false, status: 403, url: 'https://glowstudio.pk/', headers: { get: () => 'text/html' }, text: async () => 'Forbidden' }));
  try {
    const none = await evidence.fetchPage('https://glowstudio.pk/');
    assert.equal(none, null, 'no fallback unless allowed');
    const budget = { left: 1 };
    const page = await evidence.fetchPage('https://glowstudio.pk/', { jinaFallback: budget });
    assert.ok(page, 'page read through Jina');
    assert.equal(page.via, 'jina_reader');
    assert.equal(page.title, 'Glow Studio Lahore');
    assert.ok(page.phones.includes('923211112223'));
    assert.ok(page.socials.some((s) => s.includes('instagram.com/glowstudio.pk')));
    assert.match(page.text, /Johar Town/);
    assert.equal(budget.left, 0);
    assert.equal(await evidence.fetchPage('https://glowstudio.pk/', { jinaFallback: budget }), null, 'fallback budget exhausted');
  } finally { websearch.setFetchForTests(null); evidence.setFetchForTests(null); websearch.resetForTests(); }
});

test('extracts Pakistani phone numbers, emails and social links from page text', () => {
  const f = evidence.extractFacts('Call 0300-1234567 or +92 42 35761234, WhatsApp 0321 7654321. mail: hello@glow.pk https://www.instagram.com/glowstudio.pk/ https://wa.me/923001234567');
  assert.ok(f.phones.includes('923001234567'));
  assert.ok(f.phones.includes('924235761234'));
  assert.ok(f.phones.includes('923217654321'));
  assert.deepEqual(f.emails, ['hello@glow.pk']);
  assert.ok(f.socials.some((s) => s.includes('instagram.com/glowstudio.pk')));
});

test('verifyLead keeps only facts present in the evidence and computes verification', () => {
  const ev = { corpus: 'glow studio (@glowstudio.pk) instagram bridal makeup studio lahore. bookings on whatsapp 0300-1234567 https://www.instagram.com/glowstudio.pk/ owner sana khan', phones: new Set(['923001234567']), urls: new Set(['https://www.instagram.com/glowstudio.pk/']), results: [{ title: 'Glow Studio', snippet: 'bridal', url: 'https://www.instagram.com/glowstudio.pk/' }], pages: [] };
  const r = evidence.verifyLead({ business_name: 'Glow Studio', phone: '0300 1234567', whatsapp: '0333-9999999', public_email: 'x@y.com', website: 'https://glowstudio.pk', website_status: 'has_website', social_profiles: { instagram: 'https://instagram.com/glowstudio.pk', facebook: 'https://facebook.com/notthere' }, owners: [{ name: 'Sana Khan', designation: 'Owner', source_url: null }, { name: 'Invented Person', designation: 'CEO', source_url: null }], source_urls: ['https://www.instagram.com/glowstudio.pk/', 'https://made-up.example'] }, ev);
  assert.equal(r.ok, true);
  assert.equal(r.lead.phone, '0300 1234567');
  assert.equal(r.lead.whatsapp, null, 'unsupported whatsapp removed');
  assert.equal(r.lead.public_email, null);
  assert.equal(r.lead.website, null, 'unsupported website removed');
  assert.equal(r.lead.website_status, 'unknown');
  assert.equal(r.lead.social_profiles.facebook, null);
  assert.ok(r.lead.social_profiles.instagram);
  assert.deepEqual(r.lead.owners.map((o) => o.name), ['Sana Khan']);
  assert.deepEqual(r.lead.source_urls, ['https://www.instagram.com/glowstudio.pk/']);
  assert.equal(r.lead.field_verification.phone, 'verified');
  assert.equal(r.lead.field_verification.business_name, 'verified');
  assert.equal(r.lead.confidence, 'verified');
  assert.ok(r.changes.length >= 4);
  const bad = evidence.verifyLead({ business_name: 'Totally Unknown Parlour', phone: '0300-1234567' }, ev);
  assert.equal(bad.ok, false); assert.equal(bad.reason, 'not_in_evidence');
  const noChannel = evidence.verifyLead({ business_name: 'Glow Studio', phone: '0311-0000000', social_profiles: {} }, ev);
  assert.equal(noChannel.ok, false); assert.equal(noChannel.reason, 'no_public_contact_channel');
});

test('gather runs the query set, skips junk hosts, reads pages and collects phones (fake network)', async () => {
  const pageHtml = '<html><head><title>Sarah Makeup Studio Lahore</title><meta name="description" content="Bridal makeup"></head><body><script>x()</script><h1>Sarah Makeup Studio</h1><p>Call us: 0321-1112223 · <a href="https://www.instagram.com/sarahstudio">Instagram</a></p><p>We offer bridal makeup, party makeup, hair styling, facials and mehndi in Johar Town, Lahore. Bookings are taken on WhatsApp and by phone; walk-ins welcome on weekdays.</p></body></html>';
  websearch.setFetchForTests(async (url) => ({ status: 200, text: async () => DDG_HTML.replace('example-directory.pk/lahore/salons', 'sarahstudio.pk/') }));
  evidence.setFetchForTests(async (url) => ({ ok: true, status: 200, url, headers: { get: () => 'text/html; charset=utf-8' }, body: null, text: async () => pageHtml }));
  websearch.resetForTests();
  try {
    const ev = await evidence.gather({ panel: 'strategy', niche: 'Bridal Makeup Studios', city: 'Lahore', timeBudgetMs: 5000, maxPages: 3 });
    assert.equal(ev.queries.length, 6);
    assert.ok(ev.results.length >= 2);
    assert.equal(ev.pages.length, 1, 'instagram is not fetched; the directory page is');
    assert.ok(ev.phones.has('923001234567'), 'phone from a search snippet');
    assert.ok(ev.phones.has('923211112223'), 'phone from a fetched page');
    assert.ok(ev.corpus.includes('sarah makeup studio'));
    const rendered = evidence.render(ev);
    assert.match(rendered, /SEARCH RESULTS/); assert.match(rendered, /PAGE EXTRACTS/); assert.match(rendered, /0321 1112223|\+92 321 1112223/);
  } finally { websearch.setFetchForTests(null); evidence.setFetchForTests(null); websearch.resetForTests(); }
});

test('keyed engines (Serper, Jina, Tavily) come first when their keys are stored, and parse results', async () => {
  websearch.resetForTests();
  storedKeys = { jina: 'jk' };
  const urls = [];
  websearch.setFetchForTests(async (url, opts) => {
    urls.push(url.split('?')[0]);
    if (/s\.jina\.ai/.test(url)) { assert.equal(opts.headers.Authorization, 'Bearer jk'); return { ok: true, status: 200, json: async () => ({ data: [{ title: 'Glow Studio', url: 'https://instagram.com/glow', description: 'Bridal makeup Lahore 0300-1234567' }] }), text: async () => '' }; }
    return { ok: true, status: 200, text: async () => '' };
  });
  try {
    const d = await websearch.describe();
    assert.deepEqual(d.engines.slice(0, 1), ['jina']);
    const r = await websearch.search('bridal makeup Lahore', { count: 5 });
    assert.equal(r.length, 1); assert.equal(r[0].url, 'https://instagram.com/glow');
    assert.equal(urls.length, 1, 'no fallback engine was needed');
    websearch.resetForTests(); storedKeys = { serper: 'sk', tavily: 'tk' };
    websearch.setFetchForTests(async (url, opts) => {
      if (/serper\.dev/.test(url)) return { ok: true, status: 200, json: async () => ({ organic: [{ title: 'Noor Studio', link: 'https://facebook.com/noor', snippet: 'WhatsApp 0321-0000000' }] }), text: async () => '' };
      if (/tavily/.test(url)) return { ok: true, status: 200, json: async () => ({ results: [{ title: 'T', url: 'https://t.example', content: 'x' }] }), text: async () => '' };
      return { ok: true, status: 200, text: async () => '' };
    });
    const d2 = await websearch.describe();
    assert.deepEqual(d2.engines.slice(0, 2), ['serper', 'tavily']);
    const r2 = await websearch.search('salon Karachi', { count: 5 });
    assert.equal(r2[0].url, 'https://facebook.com/noor');
  } finally { websearch.setFetchForTests(null); websearch.resetForTests(); storedKeys = {}; }
});

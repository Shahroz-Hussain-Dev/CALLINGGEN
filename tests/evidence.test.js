'use strict';
/** Unit tests for the free web research layer (no network). */
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const websearch = require('../server/services/websearch.service');
const evidence = require('../server/services/evidence.service');

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
  websearch.cache.clear();
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
  } finally { websearch.setFetchForTests(null); evidence.setFetchForTests(null); websearch.cache.clear(); }
});

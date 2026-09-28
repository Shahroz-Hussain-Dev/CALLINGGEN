'use strict';
/** Unit tests: sell-probability scoring, opened-within evidence, direct numbers, niche switching (no network, no database). */
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const scoring = require('../server/lib/scoring');
const criteria = require('../server/lib/criteria');
const evidence = require('../server/services/evidence.service');
const websearch = require('../server/services/websearch.service');
const generation = require('../server/services/generation.service');
require('../server/services/settings.service').getWebSearchKeys = async () => ({});

const NEW_CLINIC = { business_name: 'Noor Dental Care', niche: 'Dental Clinics', phone: '0321-1234567', website: null, website_status: 'no_website', online_booking_status: 'none', current_booking_method: 'phone and WhatsApp', booking_problems: 'walk-in only', social_profiles: { instagram: 'https://instagram.com/noordental' }, company_size: 'solo', team_size_estimate: 3, owners: [{ name: 'Dr Sana Noor', designation: 'Dentist' }], opening: { quote: 'Grand opening 12 September 2026', dated_within: true }, address: 'DHA Phase 6, Karachi', startup_signals: ['grand opening'] };
const OLD_CHAIN = { business_name: 'Smile Chain Dental', niche: 'Dental Clinics', phone: '021-1234567', website: 'https://smilechain.pk', website_status: 'has_website', online_booking_status: 'full', current_booking_method: 'online', social_profiles: { instagram: 'x', facebook: 'y' }, company_size: 'large', founded_year: 2015, business_locations: ['Karachi', 'Lahore'], business_description: 'Pakistan\'s largest chain with branches across the country' };

test('scoring turns weighted signals into a sell probability and ranks a new gap-rich clinic far above an equipped chain', () => {
  const cfg = scoring.normalize({});
  const good = scoring.scoreLead(NEW_CLINIC, { nicheRank: 2, femalePreferred: true }, cfg);
  const bad = scoring.scoreLead(OLD_CHAIN, { nicheRank: 2 }, cfg);
  assert.ok(good.probability > 90, JSON.stringify(good));
  assert.ok(bad.probability < 5, JSON.stringify(bad));
  assert.ok(good.breakdown.some((b) => b.key === 'opened_within_window_confirmed' && b.points === 2));
  assert.ok(good.breakdown.some((b) => b.key === 'no_website' && b.points === 1));
  assert.ok(good.breakdown.some((b) => b.key === 'niche_priority' && b.points === 0.8), 'second-priority niche earns 0.8 of the weight');
  assert.ok(bad.breakdown.some((b) => b.key === 'full_online_booking' && b.points === -3));
  // owner-tunable weights
  const custom = scoring.normalize({ weights: { no_website: 5 }, min_probability: 60, pivot: 2 });
  assert.equal(custom.weights.no_website, 5); assert.equal(custom.weights.no_facebook, 0.4); assert.equal(custom.min_probability, 60);
  assert.ok(scoring.scoreLead(NEW_CLINIC, {}, custom).points > good.points);
  assert.throws(() => scoring.normalize({ weights: { no_website: 99 } }), /between/);
  assert.equal(scoring.appliesTo(cfg, 'strategy'), true); assert.equal(scoring.appliesTo(cfg, 'service'), false);
  assert.equal(scoring.appliesTo(scoring.normalize({ panel: 'both' }), 'service'), true);
  const direct = scoring.scoreLead({ ...NEW_CLINIC, direct_contact: { number: '0300-1111111' } }, {}, cfg);
  assert.ok(direct.points - scoring.scoreLead(NEW_CLINIC, {}, cfg).points === 1, 'own number adds its weight');
});

test('opened-within window: the prompt demands opening evidence, recent-page queries are used, and leads without it are rejected', () => {
  const c = criteria.normalize({ max_age_days: 30 });
  assert.match(criteria.promptText(c), /OPENED within the last 30 days/);
  assert.match(criteria.describe(c), /opened within the last 30 days/);
  const plan = evidence.buildQueries({ panel: 'strategy', niche: 'Dental Clinics', city: 'Karachi', criteria: c });
  assert.equal(plan.length, 6);
  assert.equal(plan.filter((x) => x.recency === 'm').length, 5, 'five searches limited to the past month');
  assert.ok(plan.some((x) => /grand opening/.test(x.q) && /Dental Clinic Karachi/.test(x.q)), JSON.stringify(plan));
  assert.equal(plan.find((x) => /contact number/.test(x.q)).recency, null, 'phone directories are not date-limited');
  assert.equal(evidence.buildQueries({ panel: 'strategy', niche: 'X', city: 'Y', criteria: criteria.normalize({ max_age_days: 7 }) })[0].recency, 'w');
  assert.deepEqual(criteria.check({ business_name: 'A' }, c, {}), { ok: false, reason: 'fails_criteria_not_new', match: null });
  assert.deepEqual(criteria.check({ business_name: 'A' }, c, { opening: { quote: 'now open', dated_within: null } }), { ok: true, match: 'likely' });
  assert.deepEqual(criteria.check({ business_name: 'A' }, c, { opening: { quote: 'opened 1 March 2024', opened_on: '2024-03-01', dated_within: false } }), { ok: false, reason: 'fails_criteria_opened_earlier', match: null });
  assert.deepEqual(criteria.check({ business_name: 'A' }, c, { opening: { quote: 'grand opening 12 Sep 2026', opened_on: '2026-09-12', dated_within: true } }), { ok: true, match: 'confirmed' });
});

test('opening evidence is extracted from the sources with absolute and relative dates', () => {
  const now = new Date('2026-09-28T12:00:00Z');
  assert.equal(evidence.parseMentionedDate('Grand opening on 12 September 2026!', now).toISOString().slice(0, 10), '2026-09-12');
  assert.equal(evidence.parseMentionedDate('Sep 5, 2026 · now open', now).toISOString().slice(0, 10), '2026-09-05');
  assert.equal(evidence.parseMentionedDate('posted 3 days ago', now).toISOString().slice(0, 10), '2026-09-25');
  assert.equal(evidence.parseMentionedDate('15/08/2026', now).toISOString().slice(0, 10), '2026-08-15');
  assert.equal(evidence.parseMentionedDate('no date here', now), null);
  const ev = { results: [
    { title: 'Noor Dental Care (@noordental) - Instagram', snippet: 'We are now open! Grand opening 12 September 2026 at DHA Phase 6. Book on 0321-1234567', url: 'https://www.instagram.com/noordental/', recent: 'm' },
    { title: 'Old Smile Dental', snippet: 'Serving Karachi since 2015. Grand opening 1 March 2015', url: 'https://old.example', recent: null },
  ], pages: [] };
  const o = evidence.openingEvidenceFor({ business_name: 'Noor Dental Care' }, ev, 30, now);
  assert.ok(o, 'found'); assert.equal(o.opened_on, '2026-09-12'); assert.equal(o.dated_within, true); assert.equal(o.recent_page, true); assert.match(o.quote, /now open/i);
  const old = evidence.openingEvidenceFor({ business_name: 'Old Smile Dental' }, ev, 30, now);
  assert.equal(old.dated_within, false, 'a dated announcement from years ago fails the window');
  assert.equal(evidence.openingEvidenceFor({ business_name: 'Nowhere Clinic' }, ev, 30, now), null);
  const fresh = { results: [{ title: 'Glow Lab (@glowlab.khi) - Instagram', snippet: '184 Followers, 90 Following, 9 Posts - Glow Lab Karachi. Skin clinic, DHA. Bookings 0300-1234567', url: 'https://www.instagram.com/glowlab.khi/' }], pages: [] };
  const acc = evidence.openingEvidenceFor({ business_name: 'Glow Lab', social_profiles: { instagram: 'https://instagram.com/glowlab.khi' } }, fresh, 30, now);
  assert.ok(acc && acc.kind === 'new_account', 'a brand-new account counts as opening evidence: ' + JSON.stringify(acc));
  assert.deepEqual(criteria.check({ business_name: 'Glow Lab' }, criteria.normalize({ max_age_days: 30 }), { opening: acc }), { ok: true, match: 'likely' });
  const established = { results: [{ title: 'Big Salon (@bigsalon) - Instagram', snippet: '45K Followers, 120 Following, 2,300 Posts - Big Salon Karachi', url: 'https://www.instagram.com/bigsalon/' }], pages: [] };
  assert.equal(evidence.openingEvidenceFor({ business_name: 'Big Salon', social_profiles: { instagram: 'https://instagram.com/bigsalon' } }, established, 30, now), null);
  // verifyLead: model quote must be in the evidence; the server extraction wins; criteria applied
  const corpus = 'noor dental care (@noordental) instagram we are now open! grand opening 12 september 2026 at dha phase 6. book on 0321-1234567 https://www.instagram.com/noordental/';
  const full = { corpus, phones: new Set(['923211234567']), urls: new Set(['https://www.instagram.com/noordental/']), results: ev.results, pages: [] };
  const r = evidence.verifyLead({ business_name: 'Noor Dental Care', phone: '0321-1234567', social_profiles: { instagram: 'https://instagram.com/noordental' }, opening_quote: 'invented quote', opened_on: '2026-09-12' }, full, criteria.normalize({ max_age_days: 30 }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.lead.criteria_match, 'confirmed'); assert.equal(r.lead.opening.opened_on, '2026-09-12'); assert.equal(r.lead.opening_quote, undefined);
  const none = evidence.verifyLead({ business_name: 'Old Smile Dental', phone: '0321-1234567', social_profiles: {} }, { ...full, corpus: corpus + ' old smile dental serving karachi since 2015' }, criteria.normalize({ max_age_days: 30 }));
  assert.equal(none.ok, false); assert.equal(none.reason, 'fails_criteria_opened_earlier', 'a "since 2015" statement dates the opening outside the window');
  const blank = evidence.verifyLead({ business_name: 'Quiet Clinic', phone: '0321-1234567', social_profiles: {} }, { ...full, corpus: corpus + ' quiet clinic karachi dental' }, criteria.normalize({ max_age_days: 30 }));
  assert.equal(blank.ok, false); assert.equal(blank.reason, 'fails_criteria_not_new');
});

test('a doctor\'s own number is taken from public pages next to the name, skipping reception lines and preferring mobiles', async () => {
  websearch.resetForTests();
  const page = 'Noor Dental Care. Reception / appointments: 021-35000000. Dr Sana Noor (BDS) — for consultation queries WhatsApp 0321-7654321. Timings 4-9 pm.';
  const ev = { results: [{ title: 'Noor Dental Care Karachi', snippet: 'Dental clinic', url: 'https://noordental.pk' }], pages: [{ title: 'Noor Dental Care', text: page, url: 'https://noordental.pk/contact', phones: [], socials: [] }] };
  const found = await evidence.findDirectNumber({ personName: 'Dr Sana Noor', businessName: 'Noor Dental Care', city: 'Karachi', ev, businessPhone: '021-35000000' });
  assert.ok(found, 'found'); assert.equal(found.number, '0321-7654321'); assert.equal(found.kind, 'direct_mobile'); assert.equal(found.source_url, 'https://noordental.pk/contact');
  // nothing in the evidence -> one web search, receptionist numbers skipped
  websearch.setFetchForTests(async (url) => ({ status: 200, headers: { get: () => null }, text: async () => /r\.jina\.ai/.test(url) ? 'Title: x\n\nMarkdown Content:\n1.[Dr Ali Raza - Profile | Marham](https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.marham.pk%2Fdoctors%2Fali-raza)\nDr Ali Raza Karachi. For appointment call 0300-1112222. Personal cell of Dr Ali Raza 0333-9998887\nwww.marham.pk\n' : '<html></html>' }));
  evidence.setFetchForTests(async () => ({ ok: false, status: 403, headers: { get: () => 'text/html' }, text: async () => '' }));
  try {
    const f2 = await evidence.findDirectNumber({ personName: 'Dr Ali Raza', businessName: 'Raza Clinic', city: 'Karachi', ev: { results: [], pages: [] } });
    assert.ok(f2, 'found via search'); assert.equal(f2.number, '0333-9998887');
    assert.equal(await evidence.findDirectNumber({ personName: 'Xy', city: 'Karachi' }), null, 'too short a name');
  } finally { websearch.setFetchForTests(null); evidence.setFetchForTests(null); websearch.resetForTests(); }
});

test('chooseTarget works the top-priority niche across cities, skips covered pairs and reports nationwide exhaustion', () => {
  const nicheRows = [{ id: 'n1', name: 'Nail Art Studios' }, { id: 'n2', name: 'Dental Clinics' }];
  const cities = ['Karachi', 'Islamabad'];
  const priority = ['Dental Clinics', 'Nail Art Studios'];
  const t1 = generation.chooseTarget({ nicheRows, cities, priority, coverage: {} });
  assert.equal(t1.niche.name, 'Dental Clinics'); assert.equal(t1.city, 'Karachi');
  const coverage = { [generation.coverageKey(nicheRows[1], 'Karachi')]: { attempts: 2, saved: 0, exhausted: true } };
  const t2 = generation.chooseTarget({ nicheRows, cities, priority, coverage });
  assert.equal(t2.niche.name, 'Dental Clinics'); assert.equal(t2.city, 'Islamabad', 'same niche, next city');
  coverage[generation.coverageKey(nicheRows[1], 'Islamabad')] = { attempts: 2, saved: 0, exhausted: true };
  const t3 = generation.chooseTarget({ nicheRows, cities, priority, coverage });
  assert.equal(t3.niche.name, 'Nail Art Studios', 'dental exhausted in every city -> next niche'); assert.deepEqual(t3.exhaustedNiches, ['Dental Clinics']);
  coverage[generation.coverageKey(nicheRows[0], 'Karachi')] = { attempts: 1, saved: 3 };
  assert.equal(generation.chooseTarget({ nicheRows, cities, priority, coverage }).city, 'Islamabad', 'least-attempted city first');
  coverage[generation.coverageKey(nicheRows[0], 'Islamabad')] = { attempts: 2, saved: 0, exhausted: true };
  coverage[generation.coverageKey(nicheRows[0], 'Karachi')] = { attempts: 3, saved: 3, exhausted: true };
  assert.equal(generation.chooseTarget({ nicheRows, cities, priority, coverage }).allExhausted, true);
});

test('the practitioner named in a clinic\'s business name is used for the own-number lookup', () => {
  const re = /^(?:dr\.?|doctor)\s+([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3}?)(?=\s+(?:clinic|dental|skin|care|medical|hospital|centre|center|practice|surgery|physio|homeo|eye|child|maternity)|\s*$)/i;
  assert.equal(re.exec('Dr. Suhail Ahmed Channa Clinic')[1], 'Suhail Ahmed Channa');
  assert.equal(re.exec('Dr Sana Noor Dental Care')[1], 'Sana Noor');
  assert.equal(re.exec('Dr Ali')[1], 'Ali');
  assert.equal(re.exec('Optimal Medical Clinic'), null);
});

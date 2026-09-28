'use strict';
/** Unit tests for lead targeting criteria (no network, no database). */
process.env.NODE_ENV = 'test';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const criteria = require('../server/lib/criteria');
const evidence = require('../server/services/evidence.service');
const prompts = require('../server/prompts/leadGeneration');
require('../server/services/settings.service').getWebSearchKeys = async () => ({});

const STARTUP = { stage: 'startup', founded_from_year: 2026, max_employees: 10, leadership: 'female_preferred', max_followers: null, max_age_days: null, notes: '' };

test('criteria are validated, described and written into the prompt', () => {
  const n = criteria.normalize({ stage: 'startup', founded_from_year: '2026', max_employees: '10', leadership: 'female_preferred' });
  assert.deepEqual(n, STARTUP);
  assert.equal(criteria.isActive(criteria.normalize({})), false);
  assert.throws(() => criteria.normalize({ stage: 'unicorn' }), /stage/);
  assert.throws(() => criteria.normalize({ founded_from_year: 1800 }), /founded_from_year/);
  assert.match(criteria.describe(n), /started in 2026 or later/);
  const p = prompts.buildUserPrompt({ panel: 'strategy', niches: ['Nail Art Studios'], city: 'Karachi', count: 5, excludeNames: [], searchEnabled: true, criteria: n });
  assert.match(p, /TARGETING/);
  assert.match(p, /Started in 2026 or later/);
  assert.match(p, /at most 10 people/);
  assert.match(p, /PREFER female-led/);
  assert.doesNotMatch(prompts.buildUserPrompt({ panel: 'strategy', niches: ['X'], city: 'Karachi', count: 5, excludeNames: [], searchEnabled: true }), /TARGETING/);
});

test('check enforces founding year, team size and audience size, and confirms matches from signals', () => {
  assert.equal(criteria.check({ founded_year: 2024 }, STARTUP).ok, false);
  assert.equal(criteria.check({ founded_year: 2024 }, STARTUP).reason, 'fails_criteria_founded_before');
  assert.equal(criteria.check({ team_size_estimate: 25 }, STARTUP).reason, 'fails_criteria_team_size');
  assert.equal(criteria.check({ company_size: 'large' }, STARTUP).reason, 'fails_criteria_established');
  assert.equal(criteria.check({ company_size: 'medium' }, STARTUP).reason, 'fails_criteria_team_size');
  assert.equal(criteria.check({}, STARTUP, { followers: 45000 }).reason, 'fails_criteria_established');
  assert.deepEqual(criteria.check({ startup_signals: ['grand opening'] }, STARTUP, { followers: 900 }), { ok: true, match: 'confirmed' });
  assert.deepEqual(criteria.check({ company_size: 'small' }, STARTUP), { ok: true, match: 'unknown' });
  assert.deepEqual(criteria.check({ company_size: 'large' }, criteria.normalize({})), { ok: true, match: null });
  assert.ok(criteria.rank({ female_led: true, criteria_match: 'confirmed' }, STARTUP) > criteria.rank({ female_led: null, criteria_match: 'confirmed' }, STARTUP));
});

test('evidence queries gain newcomer searches under startup criteria; audience counts are read from snippets', () => {
  const plain = evidence.buildQueries({ panel: 'strategy', niche: 'Nail Art Studios', city: 'Karachi' });
  const targeted = evidence.buildQueries({ panel: 'strategy', niche: 'Nail Art Studios', city: 'Karachi', criteria: STARTUP });
  assert.equal(plain.length, 6);
  assert.ok(targeted.length >= 8);
  assert.ok(targeted.some((x) => /newly opened/.test(x.q)));
  assert.ok(targeted.some((x) => /new Nail Art Studios Karachi 2026/.test(x.q)));
  assert.ok(targeted.every((x) => x.recency === null), 'no recency limit without an opened-within window');
  const ev = { results: [{ title: 'Nail Nook (@nailnook.khi) - Instagram', snippet: '1,204 Followers, 310 Following, 88 Posts - Nail Nook Karachi. New nail studio in DHA, opened 2026. Bookings 0312-1234567', url: 'https://www.instagram.com/nailnook.khi/' }], pages: [] };
  const a = evidence.audienceFor({ business_name: 'Nail Nook', social_profiles: { instagram: 'https://instagram.com/nailnook.khi' } }, ev);
  assert.deepEqual(a, { instagram_followers: 1204, instagram_posts: 88, source_url: 'https://www.instagram.com/nailnook.khi/' });
  assert.equal(evidence.audienceFor({ business_name: 'Somewhere Else' }, ev), null);
});

test('verifyLead keeps only evidenced startup facts and applies the criteria', () => {
  const corpus = 'nail nook (@nailnook.khi) instagram 1,204 followers, 310 following, 88 posts - nail nook karachi. new nail studio in dha, opened 2026. bookings 0312-1234567 https://www.instagram.com/nailnook.khi/';
  const ev = { corpus, phones: new Set(['923121234567']), urls: new Set(['https://www.instagram.com/nailnook.khi/']), results: [{ title: 'Nail Nook (@nailnook.khi) - Instagram', snippet: '1,204 Followers, 310 Following, 88 Posts - Nail Nook Karachi. New nail studio in DHA, opened 2026. Bookings 0312-1234567', url: 'https://www.instagram.com/nailnook.khi/' }], pages: [] };
  const lead = { business_name: 'Nail Nook', phone: '0312-1234567', social_profiles: { instagram: 'https://instagram.com/nailnook.khi' }, founded_year: 2026, team_size_estimate: 2, female_led: true, startup_signals: ['New nail studio in DHA', 'award-winning chain since 2010'], company_size: 'solo', source_urls: ['https://www.instagram.com/nailnook.khi/'] };
  const r = evidence.verifyLead(lead, ev, STARTUP);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.lead.startup_signals, ['New nail studio in DHA'], 'quote not in evidence removed');
  assert.equal(r.lead.founded_year, 2026);
  assert.equal(r.lead.criteria_match, 'confirmed');
  assert.equal(r.lead.audience.instagram_followers, 1204);
  const old = evidence.verifyLead({ ...lead, founded_year: 2019, startup_signals: [] }, ev, STARTUP);
  assert.equal(old.lead.founded_year, null, 'a year absent from the evidence is dropped rather than trusted');
  assert.equal(old.ok, true);
  const big = evidence.verifyLead({ ...lead, founded_year: null, team_size_estimate: 40 }, ev, STARTUP);
  assert.equal(big.ok, false); assert.equal(big.reason, 'fails_criteria_team_size');
});

test('a founding year must be stated in the sources; landline area codes locate the business', () => {
  const norm = require('../server/lib/normalize');
  assert.equal(norm.cityFromPhone('041 5472772'), 'Faisalabad');
  assert.equal(norm.cityFromPhone('+92 21 35360003'), 'Karachi');
  assert.equal(norm.cityFromPhone('0300-1234567'), null, 'mobile numbers carry no city');
  const mk = (corpus) => ({ corpus, phones: new Set(['923001234567']), urls: new Set(['https://www.instagram.com/x/']), results: [], pages: [] });
  const lead = { business_name: 'Aura Studio', phone: '0300-1234567', social_profiles: {}, founded_year: 2026 };
  assert.equal(evidence.verifyLead(lead, mk('aura studio bridal campaign 2026 call 0300-1234567')).lead.founded_year, null, 'a campaign year is not a founding year');
  assert.equal(evidence.verifyLead(lead, mk('aura studio est. 2026 call 0300-1234567')).lead.founded_year, 2026);
  assert.equal(evidence.verifyLead(lead, mk('aura studio opened its doors in 2026 call 0300-1234567')).lead.founded_year, 2026);
});

test('generic category names are not accepted as businesses', () => {
  const norm = require('../server/lib/normalize');
  assert.equal(norm.isGenericName('Social Media Services Provider'), true);
  assert.equal(norm.isGenericName('Best Bridal Makeup Studio Karachi'), true);
  assert.equal(norm.isGenericName('Utilizor'), false);
  assert.equal(norm.isGenericName('ZAKZ Marketing Agency'), false);
  assert.equal(norm.isGenericName("Sarah's Makeup Studio"), false);
  assert.equal(norm.isGenericName('Social Media Services - SMS'), true);
  assert.equal(norm.isGenericName('N&R Nails & Beauty Studio'), false, 'initials make a name distinctive');
  assert.equal(norm.isGenericName('M. Beauty Salon'), false);
  assert.equal(norm.isGenericName('SB Sehrish beauty salon'), false);
  assert.equal(norm.isGenericName('Online Tutor | Multan'), true);
});

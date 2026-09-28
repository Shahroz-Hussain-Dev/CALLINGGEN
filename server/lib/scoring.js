'use strict';
/**
 * Sell-probability scoring for the Strategy panel.
 *
 * Every lead is scored on a table of weighted signals (no website = 1.0 point, no Facebook = 0.4, opened
 * within the last month = 2.0, owner's direct number found = 1.0, has a website with online booking = -3 ...).
 * The points are turned into a probability of selling with a logistic curve, so a lead with a few strong
 * gaps and a reachable owner lands high and an established, well-equipped business lands low. The owner can
 * change every weight in Settings (system_settings.lead_scoring); the defaults below are the starting point.
 */
const { ValidationError } = require('./errors');

// [key, label, default weight, group]
const FEATURES = [
  // Digital gaps = opportunity for websites / booking systems
  ['no_website', 'No official website', 1.0, 'gaps'],
  ['no_facebook', 'No Facebook page', 0.4, 'gaps'],
  ['no_instagram', 'No Instagram profile', 0.3, 'gaps'],
  ['no_online_booking', 'No online booking system', 0.8, 'gaps'],
  ['partial_online_booking', 'Only partial online booking', 0.3, 'gaps'],
  ['books_by_phone_or_chat', 'Bookings by phone, WhatsApp, DM or walk-in', 0.6, 'gaps'],
  ['booking_problems_reported', 'Booking friction observed (slow replies, DM to book)', 0.7, 'gaps'],
  ['website_opportunity_stated', 'Concrete website opportunity identified', 0.3, 'gaps'],
  ['booking_automation_opportunity_stated', 'Concrete booking-automation opportunity identified', 0.3, 'gaps'],
  // Newness and size = decision is easy, budget is fresh
  ['opened_within_window_confirmed', 'Opened within the target window (dated evidence)', 2.0, 'newness'],
  ['opened_within_window_likely', 'Opened recently (opening announcement, no date)', 1.0, 'newness'],
  ['startup_signals_present', 'Startup / smallness signals quoted from sources', 0.4, 'newness'],
  ['founded_this_year', 'Founding year stated as this year', 0.5, 'newness'],
  ['solo_or_small_team', 'Solo or small team (up to 10 people)', 0.5, 'newness'],
  ['low_following', 'Small social following (under 2,000)', 0.3, 'newness'],
  ['few_posts', 'Few posts (under 100)', 0.2, 'newness'],
  // Reachability = the call actually happens
  ['phone_public', 'Phone number published', 0.8, 'reach'],
  ['whatsapp_public', 'WhatsApp number published', 0.5, 'reach'],
  ['owner_named', 'Owner / decision-maker named on a source', 0.4, 'reach'],
  ['owner_direct_number', "Owner's or doctor's own number found", 1.0, 'reach'],
  ['email_public', 'Public email published', 0.1, 'reach'],
  ['female_led', 'Female-led (when preferred)', 0.3, 'reach'],
  // Fit
  ['appointment_based', 'Appointment-based business', 0.5, 'fit'],
  ['clinic_or_doctor', 'Clinic / doctor practice', 0.6, 'fit'],
  ['niche_priority', 'Niche priority (top niche = full weight)', 1.0, 'fit'],
  ['address_public', 'Physical address published', 0.2, 'fit'],
  // Negatives
  ['has_website', 'Has an official website', -1.5, 'negative'],
  ['full_online_booking', 'Already has full online booking', -3.0, 'negative'],
  ['multiple_branches', 'Several branches / locations', -0.8, 'negative'],
  ['chain_or_franchise', 'Chain or franchise signals', -1.5, 'negative'],
  ['large_following', 'Large social following (over 20,000)', -1.0, 'negative'],
  ['large_team', 'Team larger than 10', -1.0, 'negative'],
  ['established_years', 'Founded two or more years ago', -1.0, 'negative'],
];

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  panel: 'strategy',
  min_probability: 40, // leads below this are rejected (low_sell_probability)
  pivot: 3.0, // points that correspond to a 50 % chance
  scale: 1.2, // how quickly the probability moves with the points
  weights: Object.fromEntries(FEATURES.map(([k, , w]) => [k, w])),
});

function num(v, field, min, max, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}`);
  return n;
}

/** Validates and normalizes a scoring configuration (unknown weights are ignored, missing ones default). */
function normalize(input) {
  const c = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const weights = {};
  const w = c.weights && typeof c.weights === 'object' ? c.weights : {};
  for (const [k, , d] of FEATURES) weights[k] = num(w[k], `weights.${k}`, -10, 10, d);
  const panel = c.panel === undefined ? 'strategy' : String(c.panel);
  if (!['strategy', 'service', 'both'].includes(panel)) throw new ValidationError('lead_scoring.panel must be strategy, service or both');
  return {
    enabled: c.enabled === undefined ? true : !!c.enabled,
    panel,
    min_probability: num(c.min_probability, 'min_probability', 0, 100, DEFAULT_CONFIG.min_probability),
    pivot: num(c.pivot, 'pivot', -20, 20, DEFAULT_CONFIG.pivot),
    scale: num(c.scale, 'scale', 0.1, 10, DEFAULT_CONFIG.scale),
    weights,
  };
}

function appliesTo(cfg, panel) { const c = cfg || DEFAULT_CONFIG; return !!c.enabled && (c.panel === 'both' || c.panel === panel); }

const CLINIC_RE = /clinic|doctor|dental|dentist|physio|dermatolog|gynecolog|pediatric|optometr|eye|homeopath|hikmat|nutrition|psycholog|counsel|diagnostic|lab|veterinar/i;
const CHAIN_RE = /franchise|branches (across|in) |nationwide|chain of|all branches|multiple branches/i;

/**
 * Feature values (0..1) for one verified lead.
 * ctx: { criteria, nicheRank (1 = top priority), nicheCount, followers, posts, opening, directNumber, femalePreferred }
 */
function computeFeatures(lead, ctx = {}) {
  const sp = lead.social_profiles || {};
  const booking = String(lead.current_booking_method || '').toLowerCase();
  const desc = `${lead.business_description || ''} ${lead.qualification_notes || ''}`;
  const team = Number.isFinite(Number(lead.team_size_estimate)) && lead.team_size_estimate !== null ? Number(lead.team_size_estimate) : null;
  const founded = Number.isFinite(Number(lead.founded_year)) && lead.founded_year !== null ? Number(lead.founded_year) : null;
  const followers = ctx.followers === undefined || ctx.followers === null ? (lead.audience ? lead.audience.instagram_followers : null) : ctx.followers;
  const posts = ctx.posts === undefined || ctx.posts === null ? (lead.audience ? lead.audience.instagram_posts : null) : ctx.posts;
  const opening = ctx.opening || lead.opening || null;
  const hasWebsite = !!lead.website || lead.website_status === 'has_website';
  const people = [...(lead.owners || []), ...(lead.decision_makers || []), ...(lead.management || [])].filter((p) => p && p.name);
  const direct = ctx.directNumber !== undefined ? !!ctx.directNumber : !!(lead.direct_contact && lead.direct_contact.number);
  const year = new Date().getFullYear();
  const nicheName = `${lead.niche || ''} ${ctx.nicheName || ''}`;
  const f = {
    no_website: hasWebsite ? 0 : 1,
    no_facebook: sp.facebook ? 0 : 1,
    no_instagram: sp.instagram ? 0 : 1,
    no_online_booking: lead.online_booking_status === 'none' ? 1 : 0,
    partial_online_booking: lead.online_booking_status === 'partial' ? 1 : 0,
    books_by_phone_or_chat: /phone|call|whatsapp|dm|message|instagram|facebook|walk/.test(booking) ? 1 : 0,
    booking_problems_reported: lead.booking_problems ? 1 : 0,
    website_opportunity_stated: lead.website_opportunity ? 1 : 0,
    booking_automation_opportunity_stated: lead.booking_automation_opportunity ? 1 : 0,
    opened_within_window_confirmed: opening && opening.dated_within ? 1 : 0,
    opened_within_window_likely: opening && !opening.dated_within && opening.quote ? 1 : 0,
    startup_signals_present: Array.isArray(lead.startup_signals) && lead.startup_signals.length ? 1 : 0,
    founded_this_year: founded === year ? 1 : 0,
    solo_or_small_team: lead.company_size === 'solo' || lead.company_size === 'small' || (team !== null && team <= 10) ? 1 : 0,
    low_following: followers !== null && followers !== undefined && followers < 2000 ? 1 : 0,
    few_posts: posts !== null && posts !== undefined && posts < 100 ? 1 : 0,
    phone_public: lead.phone ? 1 : 0,
    whatsapp_public: lead.whatsapp || sp.whatsapp ? 1 : 0,
    owner_named: people.length ? 1 : 0,
    owner_direct_number: direct ? 1 : 0,
    email_public: lead.public_email ? 1 : 0,
    female_led: ctx.femalePreferred && lead.female_led === true ? 1 : 0,
    appointment_based: 1,
    clinic_or_doctor: CLINIC_RE.test(nicheName) ? 1 : 0,
    niche_priority: ctx.nicheRank ? Math.max(0, 1 - (ctx.nicheRank - 1) * 0.2) : 0,
    address_public: lead.address ? 1 : 0,
    has_website: hasWebsite ? 1 : 0,
    full_online_booking: lead.online_booking_status === 'full' ? 1 : 0,
    multiple_branches: Array.isArray(lead.business_locations) && lead.business_locations.length > 1 ? 1 : 0,
    chain_or_franchise: CHAIN_RE.test(desc) || CHAIN_RE.test(lead.business_name || '') ? 1 : 0,
    large_following: followers !== null && followers !== undefined && followers > 20000 ? 1 : 0,
    large_team: (team !== null && team > 10) || lead.company_size === 'large' ? 1 : 0,
    established_years: founded !== null && founded <= year - 2 ? 1 : 0,
  };
  return f;
}

/** Scores a lead: { points, probability (0-100), breakdown: [{ key, label, weight, value, points }] }. */
function scoreLead(lead, ctx = {}, cfg = DEFAULT_CONFIG) {
  const c = cfg || DEFAULT_CONFIG;
  const features = computeFeatures(lead, ctx);
  const breakdown = [];
  let points = 0;
  for (const [key, label] of FEATURES) {
    const value = features[key] || 0;
    const weight = c.weights && Number.isFinite(Number(c.weights[key])) ? Number(c.weights[key]) : DEFAULT_CONFIG.weights[key];
    if (!value) continue;
    const p = Math.round(weight * value * 100) / 100;
    points += p;
    breakdown.push({ key, label, weight, value: Math.round(value * 100) / 100, points: p });
  }
  points = Math.round(points * 100) / 100;
  const probability = Math.round(1000 / (1 + Math.exp(-(points - c.pivot) / c.scale))) / 10;
  breakdown.sort((a, b) => Math.abs(b.points) - Math.abs(a.points));
  return { points, probability, breakdown };
}

module.exports = { FEATURES, DEFAULT_CONFIG, normalize, appliesTo, computeFeatures, scoreLead };

'use strict';
/**
 * Lead targeting criteria: what kind of businesses a list should contain beyond niche and city.
 * Stored globally in system_settings.lead_criteria and snapshotted on each list (contact_lists.criteria).
 * The same rules are written into the model prompt and enforced server-side on every candidate.
 */
const { ValidationError } = require('./errors');

const STAGES = ['any', 'startup'];
const LEADERSHIP = ['any', 'female_preferred'];
const EMPTY = Object.freeze({ stage: 'any', founded_from_year: null, max_employees: null, leadership: 'any', max_followers: null, max_age_days: null, notes: '' });

function intOrNull(v, field, min, max) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}`);
  return n;
}

/** Validates and normalizes a criteria object (throws ValidationError). */
function normalize(input) {
  if (input === null || input === undefined) return { ...EMPTY };
  if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('lead_criteria must be an object');
  const stage = input.stage === undefined ? 'any' : String(input.stage);
  if (!STAGES.includes(stage)) throw new ValidationError(`stage must be one of ${STAGES.join(', ')}`);
  const leadership = input.leadership === undefined ? 'any' : String(input.leadership);
  if (!LEADERSHIP.includes(leadership)) throw new ValidationError(`leadership must be one of ${LEADERSHIP.join(', ')}`);
  const notes = String(input.notes || '').trim().slice(0, 400);
  return {
    stage,
    founded_from_year: intOrNull(input.founded_from_year, 'founded_from_year', 1990, 2100),
    max_employees: intOrNull(input.max_employees, 'max_employees', 1, 100000),
    leadership,
    max_followers: intOrNull(input.max_followers, 'max_followers', 100, 100000000),
    max_age_days: intOrNull(input.max_age_days, 'max_age_days', 1, 3650),
    notes,
  };
}

function isActive(c) {
  const n = c && typeof c === 'object' ? c : EMPTY;
  return n.stage === 'startup' || !!n.founded_from_year || !!n.max_employees || n.leadership === 'female_preferred' || !!n.max_followers || !!n.max_age_days || !!(n.notes && n.notes.trim());
}

/** Plain-English summary shown in the UI and in exports. */
function describe(c) {
  const n = c && typeof c === 'object' ? c : EMPTY;
  const parts = [];
  if (n.max_age_days) parts.push(`opened within the last ${n.max_age_days} days`);
  if (n.stage === 'startup') parts.push('startups / recently started businesses');
  if (n.founded_from_year) parts.push(`started in ${n.founded_from_year} or later`);
  if (n.max_employees) parts.push(`at most ${n.max_employees} employees`);
  if (n.leadership === 'female_preferred') parts.push('female-led preferred (male-led acceptable)');
  if (n.max_followers) parts.push(`under ${n.max_followers.toLocaleString('en-US')} social followers`);
  if (n.notes) parts.push(n.notes);
  return parts.join(' · ');
}

/** Text block for the model prompt. Returns '' when no criteria apply. */
function promptText(c) {
  const n = c && typeof c === 'object' ? c : EMPTY;
  if (!isActive(n)) return '';
  const lines = ['TARGETING (these rules override the size guidance in the target profile):'];
  if (n.max_age_days) {
    const since = new Date(Date.now() - n.max_age_days * 86400000).toISOString().slice(0, 10);
    lines.push(`- MOST IMPORTANT: only businesses that OPENED within the last ${n.max_age_days} days (on or after ${since}). Acceptable evidence: an opening announcement ("now open", "grand opening", "newly opened", "opening soon", "just launched", "new clinic/salon/studio", "our first ...") or a stated opening date on a page or post from that period, OR a brand-new social account (about 20 posts or fewer and a few hundred followers at most: quote the "N Followers ... N Posts" line). Copy the evidence verbatim into opening_quote and put the date into opened_on (YYYY-MM-DD or YYYY-MM when only the month is known; null when no date is stated). A business with no such evidence must NOT be returned, however good it looks otherwise. Results marked [recent page] come from pages published in the last month: prefer them.`);
  }
  if (n.stage === 'startup') {
    lines.push('- Only STARTUPS / recently started, small businesses. Evidence of newness: "new", "newly opened", "grand opening", "opening soon", "just launched", "now open", a founding or "since" year, few posts, a small following, first reviews. EXCLUDE established brands, chains, franchises, businesses with several branches, and any business that looks long-established.');
    lines.push('- A founder-run small business with no sign of being established (single location, small following, founder named as the contact, few reviews) DOES qualify even when its start year is not published: include it with founded_year null and quote the smallness signals in startup_signals. Do not return an empty list when such businesses are in the evidence.');
  }
  if (n.founded_from_year) lines.push(`- Started in ${n.founded_from_year} or later. Fill founded_year ONLY when a source states or clearly implies it (e.g. "est. ${n.founded_from_year}", "opened in ${n.founded_from_year}", "new in ${n.founded_from_year}"); otherwise null. Never include a business that a source shows was operating before ${n.founded_from_year}.`);
  if (n.max_employees) lines.push(`- Team size at most ${n.max_employees} people. Fill team_size_estimate from evidence (staff mentioned, "team of", "we are a family-run", solo artist = 1); null when there is no signal. Exclude businesses that mention larger teams, many branches or large facilities.`);
  if (n.max_followers) lines.push(`- Treat a social account with more than ${n.max_followers.toLocaleString('en-US')} followers as established, not a startup: exclude it.`);
  if (n.leadership === 'female_preferred') lines.push('- PREFER female-led businesses (owner/founder/lead artist is a woman: a female name, "her studio", "by <female name>", "she"). List female-led businesses first. Male-led businesses are acceptable when not enough female-led ones qualify. Set female_led to true/false only when the evidence indicates it, otherwise null.');
  if (n.notes) lines.push(`- ${n.notes}`);
  lines.push('- For every lead, fill startup_signals with 1-3 SHORT quotes copied verbatim from the evidence that show the business is new, small, or female-led (empty array when there are none).');
  return lines.join('\n');
}

/**
 * Server-side enforcement on one candidate. `facts` may carry evidence-derived data
 * ({ followers, posts, opening: { quote, dated_within, recent_page } }). Returns { ok, reason, match }
 * where match is 'confirmed' | 'likely' | 'unknown'.
 */
function check(lead, c, facts = {}) {
  const n = c && typeof c === 'object' ? c : EMPTY;
  if (!isActive(n)) return { ok: true, match: null };
  if (n.max_age_days) {
    const o = facts.opening || lead.opening || null;
    if (!o || !o.quote) return { ok: false, reason: 'fails_criteria_not_new', match: null };
    if (o.opened_on && o.dated_within === false) return { ok: false, reason: 'fails_criteria_opened_earlier', match: null };
  }
  const founded = Number.isFinite(Number(lead.founded_year)) && lead.founded_year !== null ? Number(lead.founded_year) : null;
  const team = Number.isFinite(Number(lead.team_size_estimate)) && lead.team_size_estimate !== null ? Number(lead.team_size_estimate) : null;
  const followers = Number.isFinite(Number(facts.followers)) && facts.followers !== null && facts.followers !== undefined ? Number(facts.followers) : null;
  if (n.founded_from_year && founded !== null && founded < n.founded_from_year) return { ok: false, reason: 'fails_criteria_founded_before', match: null };
  if (n.max_employees && team !== null && team > n.max_employees) return { ok: false, reason: 'fails_criteria_team_size', match: null };
  if (n.stage === 'startup' && lead.company_size === 'large') return { ok: false, reason: 'fails_criteria_established', match: null };
  if (n.stage === 'startup' && n.max_employees && n.max_employees <= 10 && lead.company_size === 'medium') return { ok: false, reason: 'fails_criteria_team_size', match: null };
  const followerCap = n.max_followers || (n.stage === 'startup' ? 20000 : null);
  if (followerCap && followers !== null && followers > followerCap) return { ok: false, reason: 'fails_criteria_established', match: null };
  const signals = Array.isArray(lead.startup_signals) ? lead.startup_signals.filter(Boolean) : [];
  if (n.max_age_days) {
    const o = facts.opening || lead.opening;
    return { ok: true, match: o.dated_within ? 'confirmed' : 'likely' };
  }
  const confirmed = (n.founded_from_year && founded !== null && founded >= n.founded_from_year) || signals.length > 0 || (followers !== null && followers <= 5000) || (team !== null && n.max_employees && team <= n.max_employees);
  return { ok: true, match: confirmed ? 'confirmed' : 'unknown' };
}

/** Sort key: female-led first when preferred, then confirmed matches, then everything else. */
function rank(lead, c) {
  const n = c && typeof c === 'object' ? c : EMPTY;
  let r = 0;
  if (n.leadership === 'female_preferred' && lead.female_led === true) r += 2;
  if (lead.criteria_match === 'confirmed') r += 1;
  if (lead.criteria_match === 'likely') r += 0.5;
  return r;
}

module.exports = { STAGES, LEADERSHIP, EMPTY, normalize, isActive, describe, promptText, check, rank };

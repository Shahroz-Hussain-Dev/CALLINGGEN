'use strict';
/**
 * Global duplicate detection. Uses several identifying signals (phone, domain,
 * name+city, social handles, fuzzy name) so the same business is never stored
 * twice, while unrelated businesses with merely similar names are kept apart.
 */
const db = require('../db');
const { nameSimilarity, nameTokens } = require('../lib/normalize');

const SELECT = 'id, business_name, normalized_business_name, city, normalized_phone, normalized_website_domain, social_profiles, contact_type';

/**
 * @param {object} c normalized candidate: { normalized_business_name, normalized_phone, normalized_website_domain, city, handles: {instagram, facebook} }
 * @returns {Promise<null | {contact, reason, score}>}
 */
async function findDuplicate(c, client) {
  const run = db.q(client);
  if (c.normalized_phone) {
    const { rows } = await run(`SELECT ${SELECT} FROM contacts WHERE normalized_phone = $1 LIMIT 1`, [c.normalized_phone]);
    if (rows[0]) return { contact: rows[0], reason: 'same_phone', score: 1 };
  }
  if (c.normalized_website_domain) {
    const { rows } = await run(`SELECT ${SELECT} FROM contacts WHERE normalized_website_domain = $1 LIMIT 1`, [c.normalized_website_domain]);
    if (rows[0]) return { contact: rows[0], reason: 'same_website', score: 1 };
  }
  if (c.normalized_business_name) {
    const { rows } = await run(
      `SELECT ${SELECT} FROM contacts WHERE normalized_business_name = $1 AND COALESCE(lower(btrim(city)), '') = COALESCE(lower(btrim($2)), '') LIMIT 1`,
      [c.normalized_business_name, c.city || null],
    );
    if (rows[0]) return { contact: rows[0], reason: 'same_name_and_city', score: 1 };
  }
  const handles = c.handles || {};
  for (const platform of ['instagram', 'facebook', 'tiktok']) {
    const h = handles[platform];
    if (!h) continue;
    const { rows } = await run(
      `SELECT ${SELECT} FROM contacts WHERE lower(social_profiles->>'${platform}_handle') = lower($1) LIMIT 1`, [h],
    );
    if (rows[0]) return { contact: rows[0], reason: `same_${platform}`, score: 1 };
  }
  // Fuzzy name match: prefilter by shared significant token, then score.
  const tokens = nameTokens(c.normalized_business_name || '').filter((t) => t.length >= 3);
  if (tokens.length) {
    const patterns = tokens.slice(0, 3).map((t) => `%${t}%`);
    const { rows } = await run(
      `SELECT ${SELECT} FROM contacts WHERE normalized_business_name LIKE ANY($1::text[]) LIMIT 200`, [patterns],
    );
    let best = null;
    for (const row of rows) {
      // Names alone are only a duplicate signal within the same city (or when a city is unknown);
      // the same name in another city with different contact details is a different business/branch.
      const sameCity = !c.city || !row.city || c.city.toLowerCase().trim() === String(row.city).toLowerCase().trim();
      if (!sameCity) continue;
      const score = nameSimilarity(c.normalized_business_name, row.normalized_business_name);
      if (score >= 0.86 && (!best || score > best.score)) best = { contact: row, reason: 'similar_name_same_city', score };
    }
    if (best) return best;
  }
  return null;
}

module.exports = { findDuplicate };

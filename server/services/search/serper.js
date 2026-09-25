'use strict';
/** Serper.dev (Google Places / Search) verification connector. */
const config = require('../../config');
const logger = require('../../logger');
const { normalizeBusinessName, nameSimilarity, normalizeDomain, isSocialDomain } = require('../../lib/normalize');

async function post(path, body) {
  const res = await fetch(`https://google.serper.dev/${path}`, {
    method: 'POST',
    headers: { 'X-API-KEY': config.search.serperApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Serper ${path} failed with status ${res.status}`);
  return res.json();
}

module.exports = {
  name: 'serper',
  enabled: () => !!config.search.serperApiKey,
  async lookupBusiness(candidate) {
    if (!config.search.serperApiKey) return null;
    const q = `${candidate.business_name} ${candidate.city || ''} Pakistan`.trim();
    try {
      const data = await post('places', { q, gl: 'pk' });
      const places = Array.isArray(data.places) ? data.places : [];
      const target = normalizeBusinessName(candidate.business_name);
      let best = null, bestScore = 0;
      for (const p of places) {
        const score = nameSimilarity(target, normalizeBusinessName(p.title || ''));
        if (score > bestScore) { best = p; bestScore = score; }
      }
      if (!best || bestScore < 0.8) return { found: false, best_match: best ? best.title : null, score: bestScore };
      const website = best.website && !isSocialDomain(new URL(best.website).hostname) ? best.website : null;
      return {
        found: true,
        title: best.title,
        phone: best.phoneNumber || null,
        website,
        website_domain: website ? normalizeDomain(website) : null,
        address: best.address || null,
        rating: best.rating || null,
        reviews: best.ratingCount || null,
        source_url: best.cid ? `https://maps.google.com/?cid=${best.cid}` : (best.placeId ? `https://www.google.com/maps/place/?q=place_id:${best.placeId}` : null),
        score: bestScore,
      };
    } catch (err) {
      logger.warn('Serper lookup failed', { error: err.message });
      return null;
    }
  },
};

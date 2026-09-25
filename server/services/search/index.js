'use strict';
/**
 * Pluggable business-data / search provider registry.
 * Configure with LEAD_SEARCH_PROVIDER=none|serper (+ provider API key).
 * A provider implements: { name, enabled(), lookupBusiness(candidate) }.
 * lookupBusiness returns null when nothing matches, or
 * { found: true, phone, website, address, source_url, rating, reviews, raw }.
 */
const config = require('../../config');
const providers = { none: require('./none'), serper: require('./serper') };

function getProvider() {
  const p = providers[config.search.provider] || providers.none;
  return p;
}

function describe() {
  const p = getProvider();
  return { provider: p.name, enabled: p.enabled(), claude_web_search: config.claude.webSearch };
}

module.exports = { getProvider, describe, providers };

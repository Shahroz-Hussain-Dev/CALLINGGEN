'use strict';
/**
 * Provider-agnostic AI facade. The active provider is chosen by AI_PROVIDER
 * (gemini | anthropic); Gemini is the default whenever GEMINI_API_KEY is set.
 * Tests can force a provider with setProviderForTests().
 */
const config = require('../config');

const providers = {
  gemini: () => require('./gemini.service'),
  anthropic: () => require('./claude.service'),
};
let override = null;
function setProviderForTests(name) { override = name || null; }
function activeName() { const n = override || config.ai.provider; return providers[n] ? n : 'anthropic'; }
function active() { return providers[activeName()](); }

function describe() {
  const name = activeName();
  if (name === 'gemini') return { ...active().describe(), server_key_configured: !!config.ai.gemini.apiKey };
  return { provider: 'anthropic', provider_label: 'Anthropic Claude', model: config.claude.model, web_search: config.claude.webSearch, search_label: 'Claude web search', server_key_configured: !!config.claude.apiKey };
}
function webSearchDefault() { return activeName() === 'gemini' ? config.ai.gemini.webSearch : config.claude.webSearch; }

module.exports = {
  setProviderForTests, activeName, describe, webSearchDefault,
  testConnection: (...a) => active().testConnection(...a),
  generateLeadCandidates: (...a) => active().generateLeadCandidates(...a),
  generateBusinessProfile: (...a) => active().generateBusinessProfile(...a),
  generateBookingAnalysis: (...a) => active().generateBookingAnalysis(...a),
  mapError: (...a) => active().mapError(...a),
};

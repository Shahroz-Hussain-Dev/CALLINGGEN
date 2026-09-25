'use strict';
/**
 * Normalization helpers used for global duplicate prevention.
 * The same functions run before every insert and inside duplicate checks so a
 * business is only ever stored once, regardless of formatting differences.
 */

const LEGAL_SUFFIXES = [
  'private limited', 'pvt limited', 'pvt ltd', 'pvt. ltd.', 'pvt. ltd', '(pvt) ltd', '(pvt.) ltd.', '(private) limited',
  'limited', 'ltd', 'llc', 'inc', 'incorporated', 'co', 'company', 'corp', 'corporation', 'smc-pvt', 'smc pvt',
];
const NOISE_TOKENS = new Set(['the', 'and', 'of', 'by', 'at', 'in', 'a', 'an', '&']);
const SOCIAL_DOMAINS = [
  'facebook.com', 'fb.com', 'm.facebook.com', 'instagram.com', 'tiktok.com', 'youtube.com', 'youtu.be',
  'linkedin.com', 'twitter.com', 'x.com', 'wa.me', 'whatsapp.com', 'api.whatsapp.com', 'snapchat.com',
  'pinterest.com', 'threads.net', 'linktr.ee', 'bit.ly', 'google.com', 'maps.google.com', 'goo.gl',
  'maps.app.goo.gl', 'business.site', 'g.page', 'daraz.pk', 'olx.com.pk',
];
const DEFAULT_CITIES = [
  'karachi', 'lahore', 'islamabad', 'rawalpindi', 'faisalabad', 'multan', 'peshawar', 'gujranwala', 'sialkot',
  'hyderabad', 'bahawalpur', 'abbottabad', 'quetta', 'sargodha', 'sukkur', 'larkana', 'sheikhupura', 'jhang',
  'gujrat', 'mardan', 'kasur', 'okara', 'sahiwal', 'wah', 'dera ghazi khan', 'mirpur', 'muzaffarabad', 'pakistan',
];

function stripDiacritics(s) {
  return String(s).normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function basicClean(name) {
  return stripDiacritics(name)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[’'`´]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Canonical business-name key: lowercase, no punctuation, no legal suffix, no trailing city. */
function normalizeBusinessName(name, cities = DEFAULT_CITIES) {
  if (!name) return '';
  let s = basicClean(name);
  for (const suffix of LEGAL_SUFFIXES) {
    const clean = basicClean(suffix);
    if (!clean) continue;
    const re = new RegExp(`(^|\\s)${clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    s = s.replace(re, '').trim();
  }
  // strip trailing city names ("Glow Beauty Studio Lahore" -> "glow beauty studio")
  let changed = true;
  while (changed) {
    changed = false;
    for (const city of cities) {
      const c = basicClean(city);
      if (!c) continue;
      if (s.endsWith(' ' + c) && s.length > c.length + 1) {
        s = s.slice(0, s.length - c.length - 1).trim();
        changed = true;
      }
    }
  }
  s = s.replace(/^(the|a|an)\s+/, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** Significant tokens for fuzzy comparison. */
function nameTokens(normalized) {
  return normalized.split(' ').filter((t) => t && !NOISE_TOKENS.has(t));
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

/** Two name tokens "match" when equal, or when both are words (>= 3 letters) within one edit of each other. Numbers must match exactly. */
function tokensMatch(a, b) {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  if (a.length < 3 || b.length < 3) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  return levenshtein(a, b) <= 1;
}

/**
 * Token-level similarity (0..1): Sørensen–Dice over fuzzily matched tokens,
 * plus a containment score when one name is fully contained in the other.
 * "glo beauty studio" ~ "glow beauty studio" -> 1.0 (spelling variant)
 * "glow beauty studio" ~ "glow beauty studio and spa" -> 0.95 (contained)
 * "test studio 1" ~ "test studio 2" -> 0.67 (different branch numbers are significant)
 */
function nameSimilarity(a, b) {
  const na = typeof a === 'string' ? a : '';
  const nb = typeof b === 'string' ? b : '';
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ta = [...new Set(nameTokens(na))], tb = [...new Set(nameTokens(nb))];
  if (!ta.length || !tb.length) return 0;
  const usedB = new Set();
  let matched = 0;
  for (const x of ta) {
    const idx = tb.findIndex((y, i) => !usedB.has(i) && tokensMatch(x, y));
    if (idx >= 0) { usedB.add(idx); matched++; }
  }
  const dice = (2 * matched) / (ta.length + tb.length);
  const shorter = Math.min(ta.length, tb.length);
  const containment = shorter >= 2 && matched === shorter ? 0.95 : 0;
  return Math.max(dice, containment);
}

/** Pakistani-aware phone normalization to digits with country code (e.g. 923001234567). */
function normalizePhone(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  // take the first number if several are listed
  const first = s.split(/[,/;|]| or | and /i)[0];
  let digits = first.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('92')) {
    // already has country code; drop a stray 0 after code ("920300...")
    if (digits.length === 13 && digits[2] === '0') digits = '92' + digits.slice(3);
  } else if (digits.startsWith('0') && digits.length >= 10 && digits.length <= 11) {
    digits = '92' + digits.slice(1);
  } else if (digits.length === 10 && digits.startsWith('3')) {
    digits = '92' + digits;
  }
  if (digits.length < 9 || digits.length > 15) return null;
  return digits;
}

function formatPhoneForDisplay(normalized) {
  if (!normalized) return '';
  if (normalized.startsWith('92') && normalized.length === 12) return `+92 ${normalized.slice(2, 5)} ${normalized.slice(5)}`;
  return '+' + normalized;
}

/** Returns hostname without www, or null for empty / social-profile URLs. */
function normalizeDomain(url) {
  if (!url) return null;
  let s = String(url).trim().toLowerCase();
  if (!s || s === 'n/a' || s === 'none' || s === 'null') return null;
  if (!/^https?:\/\//.test(s)) s = 'https://' + s;
  let host;
  try { host = new URL(s).hostname; } catch (_) { return null; }
  host = host.replace(/^www\./, '').replace(/\.$/, '');
  if (!host.includes('.')) return null;
  if (isSocialDomain(host)) return null;
  return host;
}

function isSocialDomain(host) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  return SOCIAL_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

/** Classifies a URL: returns {kind: 'website'|'social'|'invalid', platform?, handle?} */
function classifyUrl(url) {
  if (!url) return { kind: 'invalid' };
  let s = String(url).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (_) { return { kind: 'invalid' }; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.replace(/\/+$/, '');
  const platformMap = { 'instagram.com': 'instagram', 'facebook.com': 'facebook', 'fb.com': 'facebook', 'm.facebook.com': 'facebook', 'tiktok.com': 'tiktok', 'linkedin.com': 'linkedin', 'youtube.com': 'youtube', 'x.com': 'twitter', 'twitter.com': 'twitter', 'wa.me': 'whatsapp', 'api.whatsapp.com': 'whatsapp', 'whatsapp.com': 'whatsapp' };
  for (const [d, platform] of Object.entries(platformMap)) {
    if (host === d || host.endsWith('.' + d)) {
      const handle = path.split('/').filter(Boolean)[0] || null;
      return { kind: 'social', platform, handle: handle ? handle.replace(/^@/, '').toLowerCase() : null, url: u.toString() };
    }
  }
  if (isSocialDomain(host)) return { kind: 'social', platform: 'other', handle: null, url: u.toString() };
  return { kind: 'website', domain: normalizeDomain(u.toString()), url: u.toString() };
}

/** Normalizes an Instagram/Facebook handle or URL into a bare lowercase handle. */
function normalizeHandle(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^https?:\/\//i.test(s) || s.includes('.com/')) {
    const c = classifyUrl(s);
    return c.kind === 'social' ? c.handle : null;
  }
  return s.replace(/^@/, '').toLowerCase().replace(/\/+$/, '') || null;
}

function normalizeCity(city) {
  if (!city) return null;
  const s = basicClean(city);
  return s ? s.replace(/\b\w/g, (c) => c.toUpperCase()) : null;
}

function normalizeEmail(email) {
  if (!email) return null;
  const s = String(email).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null;
}

module.exports = {
  normalizeBusinessName, nameSimilarity, nameTokens, levenshtein, normalizePhone, formatPhoneForDisplay,
  normalizeDomain, isSocialDomain, classifyUrl, normalizeHandle, normalizeCity, normalizeEmail, DEFAULT_CITIES,
};

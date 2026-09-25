'use strict';
const { ForbiddenError } = require('../lib/errors');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
}

/**
 * CSRF protection for cookie-authenticated state changes: every non-GET API
 * request must carry a custom header, which cross-site forms cannot set, and
 * must originate from our own origin when a browser sends Sec-Fetch-Site.
 */
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'same-site', 'none'].includes(site)) return next(new ForbiddenError('Cross-site request blocked'));
  const marker = req.headers['x-requested-with'];
  if (marker !== 'XMLHttpRequest' && !(req.headers.authorization && req.path.startsWith('/api/rotation/cron'))) {
    return next(new ForbiddenError('Missing request marker header'));
  }
  next();
}

module.exports = { securityHeaders, csrfGuard };

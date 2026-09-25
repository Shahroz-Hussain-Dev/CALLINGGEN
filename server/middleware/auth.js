'use strict';
const config = require('../config');
const { parseCookies } = require('../lib/cookies');
const { AuthError, ForbiddenError } = require('../lib/errors');
const authService = require('../services/auth.service');

/** Attaches req.user when a valid session cookie is present. Never throws. */
async function attachUser(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[config.session.cookieName];
    req.sessionToken = token || null;
    req.user = null;
    if (token) {
      const resolved = await authService.resolveSession(token);
      if (resolved) { req.user = resolved.user; req.sessionId = resolved.sessionId; }
    }
    next();
  } catch (err) { next(err); }
}

function requireAuth(req, res, next) {
  if (!req.user) return next(new AuthError());
  next();
}

function requireOwner(req, res, next) {
  if (!req.user) return next(new AuthError());
  if (req.user.role !== 'owner') return next(new ForbiddenError('Administrator access required'));
  next();
}

module.exports = { attachUser, requireAuth, requireOwner };

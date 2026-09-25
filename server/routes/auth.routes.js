'use strict';
const express = require('express');
const config = require('../config');
const { serializeCookie } = require('../lib/cookies');
const { requireAuth } = require('../middleware/auth');
const auth = require('../services/auth.service');
const cycle = require('../services/cycle.service');
const settings = require('../services/settings.service');

const router = express.Router();

function cookieOpts(maxAge) {
  return { httpOnly: true, secure: config.session.secureCookies, sameSite: 'Lax', path: '/', maxAge };
}

router.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const { user, token, expiresAt } = await auth.login({ username, password, ip, userAgent: req.headers['user-agent'] });
  res.setHeader('Set-Cookie', serializeCookie(config.session.cookieName, token, cookieOpts(Math.floor((expiresAt.getTime() - Date.now()) / 1000))));
  res.json({ user });
});

router.post('/auth/logout', async (req, res) => {
  await auth.logout(req.sessionToken, req.user);
  res.setHeader('Set-Cookie', serializeCookie(config.session.cookieName, '', cookieOpts(0)));
  res.json({ ok: true });
});

router.get('/me', requireAuth, async (req, res) => {
  const state = await cycle.getState();
  const all = await settings.getAll();
  res.json({ user: req.user, cycle: cycle.describe(state, all), app: { name: config.app.name, timezone: all.timezone } });
});

router.post('/me/password', requireAuth, async (req, res) => {
  await auth.changePassword(req.user, req.body || {});
  res.json({ ok: true });
});

module.exports = router;

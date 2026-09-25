'use strict';
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');
const { requireAuth, requireOwner } = require('../middleware/auth');
const { AuthError, ServiceUnavailableError } = require('../lib/errors');
const rotation = require('../services/rotation.service');
const lists = require('../services/lists.service');

const router = express.Router();

function checkCronSecret(req) {
  const secret = config.security.cronSecret;
  if (!secret) throw new ServiceUnavailableError('CRON_SECRET is not configured on the server', 'cron_not_configured');
  const header = req.headers.authorization || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : (req.query.secret || '');
  const a = Buffer.from(String(provided)); const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new AuthError('Invalid cron secret');
}

// Vercel Cron (GET) / external scheduler. Idempotent.
router.all('/rotation/cron', async (req, res) => {
  checkCronSecret(req);
  const result = await rotation.runScheduled({ trigger: 'cron', timeBudgetMs: config.generation.timeBudgetMs });
  logger.info('Scheduled rotation run', { rotated: result.rotation.rotated, reason: result.rotation.reason });
  res.json(result);
});

router.get('/rotation/status', requireAuth, async (req, res) => res.json(await rotation.status(req.user)));
router.get('/rotation/overview', requireAuth, requireOwner, async (req, res) => res.json(await lists.rotationOverview(req.user)));
router.post('/rotation/run', requireAuth, requireOwner, async (req, res) => {
  const result = await rotation.runRotation({ trigger: 'manual', user: req.user, force: !!(req.body || {}).force });
  res.json(result);
});
router.post('/rotation/transfer', requireAuth, requireOwner, async (req, res) => {
  const { list_id, new_owner_id } = req.body || {};
  res.json({ list: await rotation.manualTransfer(req.user, list_id, new_owner_id) });
});

module.exports = router;

'use strict';
const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');
const niches = require('../services/niches.service');

const router = express.Router();
router.use('/niches', requireAuth);

router.get('/niches', async (req, res) => res.json({ items: await niches.list({ panel: req.query.panel || null, includeInactive: req.user.role === 'owner' && req.query.include_inactive === 'true' }) }));
router.post('/niches', requireOwner, async (req, res) => res.status(201).json({ niche: await niches.create(req.user, req.body || {}) }));
router.patch('/niches/:id', requireOwner, async (req, res) => res.json({ niche: await niches.update(req.user, req.params.id, req.body || {}) }));

module.exports = router;

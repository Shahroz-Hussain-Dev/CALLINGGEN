'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const followups = require('../services/followups.service');

const router = express.Router();
router.use('/follow-ups', requireAuth);

router.get('/follow-ups', async (req, res) => res.json(await followups.list(req.user, req.query)));
router.get('/follow-ups/summary', async (req, res) => res.json(await followups.summary(req.user)));
router.patch('/follow-ups/:id', async (req, res) => res.json({ follow_up: await followups.update(req.user, req.params.id, req.body || {}) }));

module.exports = router;

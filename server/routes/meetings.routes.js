'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const meetings = require('../services/meetings.service');

const router = express.Router();
router.use('/meetings', requireAuth);

router.get('/meetings', async (req, res) => res.json({ items: await meetings.list(req.user, req.query), types: meetings.TYPES, statuses: meetings.STATUSES }));
router.post('/meetings/check', async (req, res) => res.json(await meetings.checkAvailability(req.user, req.body || {})));
router.post('/meetings', async (req, res) => res.status(201).json({ meeting: await meetings.create(req.user, req.body || {}) }));
router.patch('/meetings/:id', async (req, res) => res.json({ meeting: await meetings.update(req.user, req.params.id, req.body || {}) }));
router.delete('/meetings/:id', async (req, res) => res.json({ meeting: await meetings.cancel(req.user, req.params.id) }));

module.exports = router;

'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const analytics = require('../services/analytics.service');
const activity = require('../services/activity.service');
const users = require('../services/users.service');

const router = express.Router();
router.use(['/overview', '/activity', '/users'], requireAuth);

router.get('/overview', async (req, res) => res.json(await analytics.overview(req.user)));
router.get('/activity', async (req, res) => res.json(await activity.list({ user: req.user, limit: Math.min(parseInt(req.query.limit, 10) || 30, 100), offset: parseInt(req.query.offset, 10) || 0 })));
router.get('/users', async (req, res) => res.json({ items: (await users.listUsers()).map((u) => ({ id: u.id, display_name: u.display_name, role: u.role, username: u.username })) }));

module.exports = router;

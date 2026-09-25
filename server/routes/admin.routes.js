'use strict';
const express = require('express');
const { requireAuth, requireOwner } = require('../middleware/auth');
const activity = require('../services/activity.service');
const analytics = require('../services/analytics.service');
const contacts = require('../services/contacts.service');
const users = require('../services/users.service');
const cycle = require('../services/cycle.service');

const router = express.Router();
router.use('/admin', requireAuth, requireOwner);

router.get('/admin/activity', async (req, res) => res.json(await activity.list({ user: req.user, limit: Math.min(parseInt(req.query.limit, 10) || 50, 200), offset: parseInt(req.query.offset, 10) || 0, action: req.query.action || null, userId: req.query.user_id || null, from: req.query.from || null, to: req.query.to || null })));
router.get('/admin/analytics', async (req, res) => res.json(await analytics.teamAnalytics(req.user)));
router.get('/admin/contacts', async (req, res) => res.json(await contacts.list(req.user, req.query)));
router.get('/admin/search', async (req, res) => res.json({ items: await contacts.adminSearch(req.user, req.query.q) }));
router.get('/admin/users', async (req, res) => res.json({ items: await users.listUsers() }));
router.patch('/admin/users/:id', async (req, res) => res.json({ user: await users.adminUpdateUser(req.user, req.params.id, req.body || {}) }));
router.get('/admin/employees', async (req, res) => {
  const state = await cycle.getState();
  const all = await users.listUsers();
  const items = [];
  for (const u of all) items.push({ user: u, stats: await analytics.employeeStats(u.id, state.current_cycle_number) });
  res.json({ items, current_cycle: state.current_cycle_number });
});

module.exports = router;

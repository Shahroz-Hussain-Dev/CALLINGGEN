'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const claude = require('../services/claude.service');
const apiKeys = require('../services/apiKeys.service');
const search = require('../services/search');

const router = express.Router();
router.use('/claude', requireAuth);

router.get('/claude/status', async (req, res) => {
  res.json({ ...(await apiKeys.getStatus(req.user.id)), search: search.describe() });
});
router.post('/claude/test', async (req, res) => {
  const result = await claude.testConnection(req.user.id);
  res.status(result.ok ? 200 : 200).json(result);
});
router.post('/claude/key', async (req, res) => {
  res.json(await apiKeys.saveKey(req.user, (req.body || {}).api_key));
});
router.delete('/claude/key', async (req, res) => {
  res.json(await apiKeys.removeKey(req.user));
});

module.exports = router;

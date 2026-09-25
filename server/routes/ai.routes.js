'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const ai = require('../services/ai.service');
const apiKeys = require('../services/apiKeys.service');
const search = require('../services/search');

const router = express.Router();
router.use(['/ai', '/claude'], requireAuth);

async function status(req, res) {
  const provider = req.query.provider || undefined;
  res.json({ ...(await apiKeys.getStatus(req.user.id, provider)), ...(provider && provider !== ai.activeName() ? {} : ai.describe()), search: search.describe(), active_provider: ai.activeName() });
}
async function test(req, res) { res.json(await ai.testConnection(req.user.id)); }
async function saveKey(req, res) { res.json(await apiKeys.saveKey(req.user, (req.body || {}).api_key, (req.body || {}).provider)); }
async function removeKey(req, res) { res.json(await apiKeys.removeKey(req.user, (req.body || {}).provider || req.query.provider)); }

// Current routes + legacy aliases (/api/claude/*) used by older clients
for (const prefix of ['/ai', '/claude']) {
  router.get(`${prefix}/status`, status);
  router.post(`${prefix}/test`, test);
  router.post(`${prefix}/key`, saveKey);
  router.delete(`${prefix}/key`, removeKey);
}

module.exports = router;

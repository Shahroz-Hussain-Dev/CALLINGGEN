'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const exportService = require('../services/export.service');

const router = express.Router();
router.use('/export', requireAuth);

// PDF of one or more lists (owner: any lists; employees: lists in their workspace). ?ids=a,b&title=...
router.get('/export/lists.pdf', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
  const { filename, stream } = await exportService.listsPdf(req.user, { ids, title: req.query.title });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download === '0' ? 'inline' : 'attachment'}; filename="${filename}"`);
  res.setHeader('Cache-Control', 'no-store');
  stream.pipe(res);
});

module.exports = router;

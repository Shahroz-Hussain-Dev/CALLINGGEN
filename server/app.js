'use strict';
const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const { attachUser } = require('./middleware/auth');
const { securityHeaders, csrfGuard } = require('./middleware/security');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.set('etag', false);

app.use(securityHeaders);
app.use(express.json({ limit: '1mb' }));
app.use(csrfGuard);
app.use(attachUser);

app.get('/api/health', async (req, res) => {
  try {
    const database = await db.healthCheck();
    res.json({ ok: true, database: { ok: true, latency_ms: database.latencyMs }, version: '1.0.0', env: config.env });
  } catch (err) {
    res.status(503).json({ ok: false, database: { ok: false }, error: 'Database unreachable' });
  }
});

app.use('/api', require('./routes/auth.routes'));
app.use('/api', require('./routes/ai.routes'));
app.use('/api', require('./routes/leads.routes'));
app.use('/api', require('./routes/lists.routes'));
app.use('/api', require('./routes/rotation.routes'));
app.use('/api', require('./routes/meetings.routes'));
app.use('/api', require('./routes/followups.routes'));
app.use('/api', require('./routes/niches.routes'));
app.use('/api', require('./routes/settings.routes'));
app.use('/api', require('./routes/admin.routes'));
app.use('/api', require('./routes/dashboard.routes'));
app.use('/api', notFound);

// Static frontend (served by Vercel's CDN in production; by Express locally / in tests)
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, { index: 'index.html', maxAge: config.isProduction ? '1h' : 0 }));
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use(errorHandler);

module.exports = app;

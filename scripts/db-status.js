#!/usr/bin/env node
require('dotenv').config();
const db = require('../server/db');
(async () => {
  try {
    const h = await db.healthCheck();
    console.log('Database OK:', h);
    const { rows } = await db.query('SELECT version FROM schema_migrations ORDER BY version');
    console.log('Applied migrations:', rows.map((r) => r.version));
  } catch (err) {
    console.error('Database check failed:', err.message);
    process.exitCode = 1;
  } finally { await db.closePool(); }
})();

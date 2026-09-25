'use strict';
const logger = require('../logger');
const { AppError } = require('../lib/errors');

function notFound(req, res) {
  res.status(404).json({ error: { code: 'not_found', message: `Route not found: ${req.method} ${req.path}` } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'invalid_json', message: 'Request body is not valid JSON' } });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body is too large' } });
  }
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error('Application error', { code: err.code, message: err.message, path: req.path });
    return res.status(err.status).json({ error: { code: err.code, message: err.expose ? err.message : 'Something went wrong on the server', details: err.expose ? err.details : undefined } });
  }
  // Database-level safety nets that map to user-facing conflicts
  if (err && err.code === '23P01' && /meetings_no_overlap/.test(err.constraint || '')) {
    return res.status(409).json({ error: { code: 'meeting_conflict', message: 'That time slot overlaps with an existing meeting on the shared calendar' } });
  }
  if (err && err.code === '23505' && /contacts_/.test(err.constraint || '')) {
    return res.status(409).json({ error: { code: 'duplicate_contact', message: 'This business already exists in the database' } });
  }
  if (err && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === '57P01' || err.code === '08006' || err.code === '08001')) {
    logger.error('Database unavailable', { code: err.code, message: err.message });
    return res.status(503).json({ error: { code: 'database_unavailable', message: 'The database is currently unreachable. Please try again shortly.' } });
  }
  logger.error('Unhandled error', { message: err && err.message, stack: err && err.stack, path: req.path, code: err && err.code });
  res.status(500).json({ error: { code: 'internal_error', message: 'Something went wrong on the server' } });
}

module.exports = { notFound, errorHandler };

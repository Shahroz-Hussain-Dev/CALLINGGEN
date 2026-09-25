'use strict';
/** Minimal structured logger. Never logs secrets; callers must not pass them. */
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const current = levels[(process.env.LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'error' : 'info')).toLowerCase()] || 20;

function log(level, msg, meta) {
  if (levels[level] < current) return;
  const line = { ts: new Date().toISOString(), level, msg, ...(meta || {}) };
  const out = JSON.stringify(line);
  if (level === 'error' || level === 'warn') process.stderr.write(out + '\n');
  else process.stdout.write(out + '\n');
}

module.exports = {
  debug: (m, meta) => log('debug', m, meta),
  info: (m, meta) => log('info', m, meta),
  warn: (m, meta) => log('warn', m, meta),
  error: (m, meta) => log('error', m, meta),
};

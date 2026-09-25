'use strict';
const { ValidationError } = require('./errors');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function str(value, { field = 'value', required = false, max = 2000, min = 0, trim = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`);
  const v = trim ? value.trim() : value;
  if (required && !v) throw new ValidationError(`${field} is required`);
  if (v.length > max) throw new ValidationError(`${field} must be at most ${max} characters`);
  if (v.length < min) throw new ValidationError(`${field} must be at least ${min} characters`);
  return v;
}

function oneOf(value, allowed, { field = 'value', required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} is required`);
    return null;
  }
  if (!allowed.includes(value)) throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

function int(value, { field = 'value', required = false, min = -Infinity, max = Infinity, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} is required`);
    return fallback;
  }
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isInteger(n)) throw new ValidationError(`${field} must be a whole number`);
  if (n < min || n > max) throw new ValidationError(`${field} must be between ${min} and ${max}`);
  return n;
}

function bool(value, { field = 'value', fallback = false } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  throw new ValidationError(`${field} must be true or false`);
}

function uuid(value, { field = 'id', required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw new ValidationError(`${field} is not a valid identifier`);
  return value.toLowerCase();
}

function dateStr(value, { field = 'date', required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value + 'T00:00:00Z'))) {
    throw new ValidationError(`${field} must be a date in YYYY-MM-DD format`);
  }
  return value;
}

function timeStr(value, { field = 'time', required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} is required`);
    return null;
  }
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value));
  if (!m || +m[1] > 23 || +m[2] > 59) throw new ValidationError(`${field} must be a time in HH:MM format`);
  return `${String(+m[1]).padStart(2, '0')}:${m[2]}`;
}

function arrayOf(value, itemFn, { field = 'list', required = false, max = 500 } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`${field} is required`);
    return [];
  }
  if (!Array.isArray(value)) throw new ValidationError(`${field} must be a list`);
  if (value.length > max) throw new ValidationError(`${field} has too many items`);
  return value.map((v, i) => itemFn(v, `${field}[${i}]`));
}

function objectOrEmpty(value, field = 'value') {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${field} must be an object`);
  return value;
}

module.exports = { str, oneOf, int, bool, uuid, dateStr, timeStr, arrayOf, objectOrEmpty, UUID_RE };

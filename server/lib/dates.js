'use strict';
/** Timezone-aware date helpers (no external dependency). */

function tzParts(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10);
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

function tzOffsetMs(date, tz) {
  const p = tzParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Converts a wall-clock time in tz to a UTC Date. */
function zonedTimeToUtc(y, m, d, h = 0, mi = 0, s = 0, tz) {
  let guess = Date.UTC(y, m - 1, d, h, mi, s);
  for (let i = 0; i < 2; i++) {
    const offset = tzOffsetMs(new Date(guess), tz);
    guess = Date.UTC(y, m - 1, d, h, mi, s) - offset;
  }
  return new Date(guess);
}

/** 00:00 of the given instant's calendar day in tz, as a UTC Date. */
function startOfDayInTz(date, tz) {
  const p = tzParts(date, tz);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, 0, tz);
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

/** YYYY-MM-DD of an instant in tz. */
function toDateString(date, tz) {
  const p = tzParts(date, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function parseDateString(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

function parseTimeString(s) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return { h, mi };
}

/** Combines a YYYY-MM-DD date and HH:MM time in tz into a UTC Date. */
function combineDateTime(dateStr, timeStr, tz) {
  const d = parseDateString(dateStr);
  const t = parseTimeString(timeStr);
  if (!d || !t) return null;
  return zonedTimeToUtc(d.y, d.m, d.d, t.h, t.mi, 0, tz);
}

function daysBetween(from, to) {
  return Math.ceil((to.getTime() - from.getTime()) / 86400000);
}

module.exports = { tzParts, zonedTimeToUtc, startOfDayInTz, addDays, toDateString, parseDateString, parseTimeString, combineDateTime, daysBetween };

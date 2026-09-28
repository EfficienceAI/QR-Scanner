'use strict';

/** Small time-zone helpers built on Intl, so buckets follow the shop's clock (Europe/London), DST included. */

const partsCache = new Map();
function formatter(tz) {
  if (!partsCache.has(tz)) {
    partsCache.set(tz, new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
  }
  return partsCache.get(tz);
}

/** Local wall-clock parts of an instant. */
function localParts(date, tz) {
  const p = {};
  for (const { type, value } of formatter(tz).formatToParts(date)) if (type !== 'literal') p[type] = Number(value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

/** Offset (minutes) between local wall clock and UTC at that instant. */
function offsetMinutes(date, tz) {
  const l = localParts(date, tz);
  return (Date.UTC(l.y, l.m - 1, l.d, l.h, l.mi, l.s) - date.getTime()) / 60000;
}

/** The instant of local midnight for a local calendar date (y, m 1-12, d). */
function localMidnight(y, m, d, tz) {
  let guess = new Date(Date.UTC(y, m - 1, d) - offsetMinutes(new Date(Date.UTC(y, m - 1, d, 12)), tz) * 60000);
  // Re-derive with the offset in force at the guess (handles DST switch days).
  guess = new Date(Date.UTC(y, m - 1, d) - offsetMinutes(guess, tz) * 60000);
  return guess;
}

function addDays(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

function addMonths(y, m, n) {
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1 };
}

const pad = (n) => String(n).padStart(2, '0');
const dateKey = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;
const monthKey = ({ y, m }) => `${y}-${pad(m)}`;

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel({ y, m, d }) {
  return `${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d}`;
}
function monthLabel({ y, m }) {
  return `${MON[m - 1]} ${String(y).slice(2)}`;
}

module.exports = { localParts, offsetMinutes, localMidnight, addDays, addMonths, dateKey, monthKey, dayLabel, monthLabel, pad };

'use strict';

/**
 * The admin gate, used only by /api/admin/backfill.
 *
 * The scanner API itself (/api/loyalty, /api/stats) is deliberately open: it
 * has to work the instant staff pick the device up, and access control is the
 * deployment's job. Do not add application-level auth there without being
 * asked.
 *
 * The backfill is different. It is a one-off that writes to the ledger in
 * bulk, runs for up to 60 seconds and is never touched by staff, so it keeps
 * the ADMIN_SECRET it shipped with.
 */

const crypto = require('crypto');

const ADMIN_HEADER = 'x-admin-secret';

// Per-instance brute-force brake. Fluid Compute keeps instances warm, so this
// does slow a scripted guessing run, but it is not a substitute for a long
// secret: requests may land on an instance that has seen no failures.
const MAX_FAILURES = 10;
const WINDOW_MS = 5 * 60 * 1000;
const MAX_TRACKED = 500;
const failures = new Map(); // client -> { n, first }

function clientKey(req) {
  const h = (req && req.headers) || {};
  const fwd = String(h['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || String(h['x-real-ip'] || '') || 'unknown';
}

function throttled(key) {
  const rec = failures.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > WINDOW_MS) {
    failures.delete(key);
    return false;
  }
  return rec.n >= MAX_FAILURES;
}

function noteFailure(key) {
  const now = Date.now();
  const rec = failures.get(key);
  if (!rec || now - rec.first > WINDOW_MS) {
    if (failures.size >= MAX_TRACKED) failures.clear();
    failures.set(key, { n: 1, first: now });
    return;
  }
  rec.n += 1;
}

/**
 * Constant-time compare. Both sides are hashed first so the comparison is
 * always over 32 bytes: timingSafeEqual throws on a length mismatch, and the
 * throw itself would leak the secret's length.
 */
function secretsMatch(given, expected) {
  const a = crypto.createHash('sha256').update(String(given), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

/** Returns null when the request may proceed, or { status, body } to send back. */
function requireAdmin(req) {
  const expected = String(process.env.ADMIN_SECRET || '');
  if (!expected) {
    return {
      status: 503,
      body: { ok: false, error: 'not_configured', message: 'ADMIN_SECRET is not set on the server.' },
    };
  }
  const key = clientKey(req);
  if (throttled(key)) {
    return {
      status: 429,
      body: { ok: false, error: 'too_many_attempts', message: 'Too many failed attempts. Wait a few minutes.' },
    };
  }
  const given = ((req && req.headers) || {})[ADMIN_HEADER];
  if (!given || !secretsMatch(given, expected)) {
    noteFailure(key);
    return { status: 401, body: { ok: false, error: 'unauthorized' } };
  }
  failures.delete(key);
  return null;
}

module.exports = {
  requireAdmin,
  ADMIN_HEADER,
  _internals: { secretsMatch, failures, clientKey },
};

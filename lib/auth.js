'use strict';

/**
 * The admin gate for every /api/admin/* endpoint.
 *
 * The scanner API itself (/api/loyalty, /api/stats) is deliberately open: it
 * has to work the instant staff pick the device up, and access control is the
 * deployment's job. Do not add application-level auth there without being
 * asked.
 *
 * The admin endpoints are different, and they are the reason the throttle
 * below exists. One correct guess of ADMIN_SECRET moves any member's balance
 * (/points), returns their personal pass link (/member), writes up to 500
 * member rows (/import) or re-pushes every pass (/refresh). ADMIN_SECRET is a
 * hand-set environment variable with no enforced length or entropy, so
 * unlimited guessing is the whole attack: every one of those endpoints must
 * come through here rather than compare the header itself.
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

/**
 * Returns null when the request may proceed, or { status, body } to send back.
 * `env` is for tests; handlers pass their own injected environment through.
 */
function requireAdmin(req, { env = process.env } = {}) {
  const expected = String((env && env.ADMIN_SECRET) || '');
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

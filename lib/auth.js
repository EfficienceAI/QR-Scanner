'use strict';

/**
 * Shared-secret gate for the API.
 *
 * The scanner page lives on a public URL, so the API behind it cannot be
 * open: anyone who knows a member id could otherwise read a balance or move
 * points (`remove_points` in particular empties an account). Staff enter a
 * passcode once per device and the page sends it with every call.
 *
 * Fails closed. With STAFF_PASSCODE unset the API serves nobody, which is
 * noisy on first deploy but never silently public.
 */

const crypto = require('crypto');

const STAFF_HEADER = 'x-staff-passcode';
const ADMIN_HEADER = 'x-admin-secret';

// Per-instance brute-force brake. Fluid Compute keeps instances warm, so this
// does slow a scripted guessing run, but it is not a substitute for a long
// passcode: requests may land on an instance that has seen no failures.
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
function check(req, header, envName) {
  const expected = String(process.env[envName] || '');
  if (!expected) {
    return {
      status: 503,
      body: { ok: false, error: 'not_configured', message: `${envName} is not set on the server.` },
    };
  }
  const key = clientKey(req);
  if (throttled(key)) {
    return {
      status: 429,
      body: { ok: false, error: 'too_many_attempts', message: 'Too many wrong passcodes. Wait a few minutes.' },
    };
  }
  const given = ((req && req.headers) || {})[header];
  if (!given || !secretsMatch(given, expected)) {
    noteFailure(key);
    return { status: 401, body: { ok: false, error: 'unauthorized', message: 'Staff passcode required.' } };
  }
  failures.delete(key);
  return null;
}

const requireStaff = (req) => check(req, STAFF_HEADER, 'STAFF_PASSCODE');
const requireAdmin = (req) => check(req, ADMIN_HEADER, 'ADMIN_SECRET');

module.exports = {
  requireStaff,
  requireAdmin,
  STAFF_HEADER,
  ADMIN_HEADER,
  _internals: { secretsMatch, failures, clientKey },
};

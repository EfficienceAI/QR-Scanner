'use strict';

/**
 * POST /api/admin/points  { serial | email, delta }   header: x-admin-secret
 * Staff / test tool for the native pass system: changes a member's balance
 * atomically and tells Wallet the pass changed. The scanner will do the same
 * through its own integration later; until then this is how a stamp reaches
 * a native pass.
 */

const crypto = require('crypto');
const members = require('../../lib/members');
const apns = require('../../lib/apns');

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body); } catch { return {}; }
}
function authorized(req, secret) {
  const given = String((req.headers && req.headers['x-admin-secret']) || '');
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function createHandler(deps = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { ok: false, error: 'method_not_allowed' }); }
    const secret = (deps.env || process.env).ADMIN_SECRET || '';
    if (!secret) return send(res, 503, { ok: false, error: 'not_configured', message: 'ADMIN_SECRET is not set.' });
    if (!authorized(req, secret)) return send(res, 401, { ok: false, error: 'unauthorized' });

    const body = readBody(req);
    const delta = Number.parseInt(body.delta, 10);
    if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 99) return send(res, 400, { ok: false, error: 'invalid_delta', message: 'delta must be a whole number between -99 and 99, not 0.' });

    const log = (f) => console.log(JSON.stringify({ src: 'admin-points', ...f }));
    try {
      let member = null;
      if (body.serial) member = await (deps.getBySerial || members.getBySerial)(String(body.serial), deps);
      else if (body.email) member = await (deps.findByEmail || members.findByEmail)(String(body.email), deps);
      if (!member) return send(res, 404, { ok: false, error: 'member_not_found' });

      const points = await (deps.adjustPoints || members.adjustPoints)(member.id, delta, deps);
      const push = await (deps.pushPassUpdate || apns.pushPassUpdate)(member.pass_serial, { ...deps, log });
      log({ event: 'points_adjusted', serial: member.pass_serial, delta, points, push });
      return send(res, 200, { ok: true, member: { id: member.id, serial: member.pass_serial, name: member.full_name, points }, push });
    } catch (err) {
      if (err instanceof members.InsufficientPointsError) return send(res, 409, { ok: false, error: 'insufficient_points', message: 'That would take the balance below zero.' });
      if (err instanceof members.NotFoundError) return send(res, 404, { ok: false, error: 'member_not_found' });
      log({ event: 'failed', status: err.status, message: err.message });
      return send(res, err.status === 0 ? 503 : 502, { ok: false, error: 'db_error', message: err.message });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;

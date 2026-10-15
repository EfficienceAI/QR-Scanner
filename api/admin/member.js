'use strict';

/**
 * GET /api/admin/member?passkit_id=…  |  ?email=…  |  ?serial=…    header: x-admin-secret
 * Finds one member and returns their personal pass link (the "tap to
 * upgrade" link for an imported PassKit member). Read-only.
 */

const auth = require('../../lib/auth');
const members = require('../../lib/members');
const { db: defaultDb } = require('../../lib/db');

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}
function passUrlFor(member, base) {
  return `${base}/api/pass/${encodeURIComponent(member.pass_serial)}?t=${encodeURIComponent(member.download_token)}`;
}

function createHandler(deps = {}) {
  const db = deps.db || defaultDb;
  return async function handler(req, res) {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, { ok: false, error: 'method_not_allowed' }); }
    const env = deps.env || process.env;
    // The shared gate: hashed constant-time compare plus the brute-force
    // brake. A private copy here would have neither.
    const gate = auth.requireAdmin(req, { env: env });
    if (gate) return send(res, gate.status, gate.body);
    if (!db.enabled()) return send(res, 503, { ok: false, error: 'not_configured', message: 'The members database is not configured yet.' });

    const q = new URL(req.url || '/', 'http://local').searchParams;
    try {
      let member = null;
      if (q.get('passkit_id')) member = await members.findByPasskitId(q.get('passkit_id'), { db });
      else if (q.get('email')) member = await members.findByEmail(members.normalizeEmail(q.get('email')), { db });
      else if (q.get('serial')) member = await members.getBySerial(q.get('serial'), { db });
      else return send(res, 400, { ok: false, error: 'invalid', message: 'Give passkit_id, email or serial.' });
      if (!member) return send(res, 404, { ok: false, error: 'member_not_found' });
      const regs = await members.registrationsForSerial(member.pass_serial, { db });
      const base = String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
      return send(res, 200, {
        ok: true,
        member: {
          id: member.id, name: member.full_name, email: member.email || null, points: Number(member.points) || 0,
          status: member.status, source: member.source, serial: member.pass_serial, passkit_member_id: member.passkit_member_id || null,
          joined: member.created_at, last_visit_at: member.last_visit_at || null, devices: Array.isArray(regs) ? regs.length : 0,
        },
        passUrl: passUrlFor(member, base),
        qrUrl: `${base}/api/pass/${encodeURIComponent(member.pass_serial)}?t=${encodeURIComponent(member.download_token)}&qr=1`,
      });
    } catch (err) {
      return send(res, err.status === 0 ? 503 : 502, { ok: false, error: 'db_error', message: err.message });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;

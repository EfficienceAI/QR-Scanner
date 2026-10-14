'use strict';

/**
 * POST /api/admin/refresh  { serial } | { all: true, offset? }   header: x-admin-secret
 * Marks passes as changed and tells Wallet, so every phone re-downloads
 * them. Use after an artwork or theme change (PASS_THEME). `all` works
 * through registered passes 200 at a time; call again with the returned
 * nextOffset until done.
 */

const auth = require('../../lib/auth');
const members = require('../../lib/members');
const apns = require('../../lib/apns');
const gwallet = require('../../lib/gwallet');

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

function createHandler(deps = {}) {
  return async function handler(req, res) {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { ok: false, error: 'method_not_allowed' }); }
    // The shared gate: hashed constant-time compare plus the brute-force
    // brake. A private copy here would have neither.
    const gate = auth.requireAdmin(req, { env: deps.env || process.env });
    if (gate) return send(res, gate.status, gate.body);

    const body = readBody(req);
    const log = (f) => console.log(JSON.stringify({ src: 'admin-refresh', ...f }));
    const touch = deps.touchPass || members.touchPass;
    const push = deps.pushPassUpdate || apns.pushPassUpdate;
    try {
      let serials = [];
      let nextOffset = null;
      if (body.serial) {
        serials = [String(body.serial)];
      } else if (body.all === true) {
        const offset = Math.max(0, parseInt(body.offset || 0, 10) || 0);
        serials = await (deps.registeredSerials || members.registeredSerials)({ limit: 200, offset }, deps);
        if (serials.length === 200) nextOffset = offset + 200;
      } else {
        return send(res, 400, { ok: false, error: 'invalid', message: 'Send { serial } or { all: true }.' });
      }
      const results = [];
      for (const serial of serials) {
        const row = await touch(serial, deps);
        if (!row) { results.push({ serial, found: false }); continue; }
        const summary = await push(serial, { ...deps, log });
        const google = await (deps.syncGoogle || gwallet.syncAfterChange)(row, { ...deps, log });
        results.push({ serial, found: true, sent: summary.sent, failed: summary.failed, removed: summary.removed, skipped: summary.skipped, google });
      }
      log({ event: 'refreshed', count: results.length, nextOffset });
      return send(res, 200, { ok: true, refreshed: results.length, nextOffset, results });
    } catch (err) {
      log({ event: 'failed', status: err.status, message: err.message });
      return send(res, err.status === 0 ? 503 : 502, { ok: false, error: 'db_error', message: err.message });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;

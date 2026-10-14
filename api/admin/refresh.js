'use strict';

/**
 * POST /api/admin/refresh
 *   { serial }                  one pass
 *   { all: true, after? }       every pass, 200 at a time
 *   { class: true }             the Google Wallet card design only
 * header: x-admin-secret
 *
 * Marks passes as changed and tells Wallet, so every phone re-downloads
 * them. Use after an artwork or theme change (PASS_THEME). `all` walks
 * `members` by serial: call again with the returned `nextAfter` until it
 * comes back null. It walks members rather than Apple's registration table
 * so that a customer who only saved the Google card is included too.
 *
 * The Google Wallet *class* carries the card design, and Google keeps an
 * existing class as it is, so changing PASS_THEME, the logo, the programme
 * name or the website never reached Android cards: nothing PUT the class.
 * The first page of an `all` run now syncs it (that being the
 * artwork-change workflow), and `{ class: true }` does it on its own --
 * which is also the only way to re-submit a class stuck UNDER_REVIEW.
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

const PAGE = 200;

/**
 * PUT the Google Wallet class, or say why not. Never throws: a Google outage
 * must not stop the Apple side of a refresh, which is the half that reaches
 * most customers.
 */
async function syncClassQuietly(syncClass, gwSettings, deps, log) {
  if (!gwSettings || !gwSettings.enabled) return false;
  try {
    await syncClass(gwSettings, deps);
    return true;
  } catch (err) {
    log({ warn: 'class_sync_failed', status: err.status, message: err.message });
    return false;
  }
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
      let nextAfter = null;
      let classSynced = null;
      const syncClass = deps.syncClass || gwallet.syncClass;
      const gwSettings = (deps.gwalletSettings || gwallet.settings)(deps.env || process.env);

      if (body.class === true && !body.serial && body.all !== true) {
        classSynced = await syncClassQuietly(syncClass, gwSettings, deps, log);
        log({ event: 'class_synced', classSynced });
        return send(res, 200, { ok: true, refreshed: 0, classSynced, nextAfter: null, results: [] });
      }

      if (body.serial) {
        serials = [String(body.serial)];
      } else if (body.all === true) {
        const after = body.after ? String(body.after) : null;
        serials = await (deps.passPage || members.passPage)({ limit: PAGE, after }, deps);
        // One row per member, so a full page means there may be another.
        if (serials.length === PAGE) nextAfter = serials[serials.length - 1];
        // The design lives on the class, and one PUT covers every card, so
        // it belongs on the first page rather than once per member.
        if (!after) classSynced = await syncClassQuietly(syncClass, gwSettings, deps, log);
      } else {
        return send(res, 400, { ok: false, error: 'invalid', message: 'Send { serial }, { all: true } or { class: true }.' });
      }
      const results = [];
      for (const serial of serials) {
        const row = await touch(serial, deps);
        if (!row) { results.push({ serial, found: false }); continue; }
        const summary = await push(serial, { ...deps, log });
        const google = await (deps.syncGoogle || gwallet.syncAfterChange)(row, { ...deps, log });
        results.push({ serial, found: true, sent: summary.sent, failed: summary.failed, removed: summary.removed, skipped: summary.skipped, google });
      }
      log({ event: 'refreshed', count: results.length, nextAfter, classSynced });
      return send(res, 200, { ok: true, refreshed: results.length, classSynced, nextAfter, results });
    } catch (err) {
      log({ event: 'failed', status: err.status, message: err.message });
      return send(res, err.status === 0 ? 503 : 502, { ok: false, error: 'db_error', message: err.message });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;

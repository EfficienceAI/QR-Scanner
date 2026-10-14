'use strict';

/**
 * GET /api/gwallet/:serial?t=<download token>   -> 302 to Google's "Save to Google Wallet" link
 *
 * The Android counterpart of /api/pass/:serial. The member's loyalty object
 * is created or refreshed first, so the link always carries their current
 * balance, and the object id is remembered so later scans update Google too.
 */

const members = require('../../lib/members');
const gwallet = require('../../lib/gwallet');
const { db: defaultDb } = require('../../lib/db');
const { send, query } = require('../../lib/wallet');

function createHandler(deps = {}) {
  const gw = deps.gwallet || gwallet;
  const db = deps.db || defaultDb;
  return async function handler(req, res) {
    // The ?t= download token is bearer-equivalent and ends up in history and
    // access logs; keep it out of any referrer too.
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, { ok: false, error: 'method_not_allowed' }); }
    const q = query(req);
    const serial = String(q.serial || '');
    const token = String(q.t || '');
    const s = gw.settings(deps.env || process.env);
    if (!s.enabled) return send(res, 503, { ok: false, error: 'not_configured', message: 'Google Wallet is not set up on this deployment yet.' });
    let member;
    try {
      member = await members.getBySerial(serial, { db });
    } catch (err) {
      if (err.status === 0) return send(res, 503, { ok: false, error: 'not_configured', message: 'The members database is not configured yet.' });
      return send(res, 502, { ok: false, error: 'db_error', message: err.message });
    }
    if (!member || !members.timingSafeEqual(token, member.download_token)) return send(res, 404, { ok: false, error: 'not_found' });

    const log = (f) => console.log(JSON.stringify({ src: 'gwallet', serial, ...f }));
    try {
      await gw.ensureClass(s);
      await gw.upsertObject(member, s);
      const id = gw.objectId(member, s);
      if (member.gwallet_object_id !== id) {
        await db.update('members', `id=eq.${encodeURIComponent(member.id)}`, { gwallet_object_id: id, gwallet_updated_at: new Date().toISOString() });
      }
      log({ event: 'save_link', objectId: id });
      res.statusCode = 302;
      res.setHeader('Location', gw.saveUrl(member, s));
      res.setHeader('Cache-Control', 'no-store');
      return res.end();
    } catch (err) {
      log({ event: 'failed', status: err.status, message: err.message });
      return send(res, 502, { ok: false, error: 'google_wallet_error', message: 'Google Wallet did not answer. Try again in a moment.' });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;

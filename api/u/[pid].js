'use strict';

/**
 * GET /u/:pid   (rewritten to /api/u/:pid)   -> the customer's new card, one tap
 *
 * The link on the back of the old PassKit pass is `.../u/${pid}`, which
 * PassKit fills in with that pass's own id, the same value the pass's QR
 * carries and the serial our imported record keeps. So the tap identifies
 * the customer without a form: an iPhone gets the signed .pkpass, which
 * Wallet swaps in for the old card, and an Android phone goes to Google
 * Wallet. An id we have not imported yet is fetched from PassKit and the
 * record created on the spot (lib/adopt.js). Anyone else, or an id PassKit
 * does not know either, lands on the upgrade page with the email-and-code
 * flow.
 *
 * A PassKit member id is as private as the old pass itself: PassKit serves
 * that pass to anyone who knows the id, so accepting one here hands out
 * nothing new. That argument covers PassKit ids and nothing else -- see the
 * check on the id below, which is the whole of this route's access control.
 */

const members = require('../../lib/members');
const { adoptFromPassKit } = require('../../lib/adopt');
const passLib = require('../../lib/pass');
const gwallet = require('../../lib/gwallet');
const { db: defaultDb } = require('../../lib/db');
const { send, query } = require('../../lib/wallet');

const FALLBACK = '/upgrade';

function createHandler(deps = {}) {
  const db = deps.db || defaultDb;
  const env = deps.env || process.env;
  return async function handler(req, res) {
    // The id in this URL fetches a pass, and the Android branch redirects to
    // one carrying the download token. Neither response has a sub-resource to
    // leak a referrer to today; the same is true of api/pass/:serial and
    // api/gwallet/:serial, which set this anyway, and it costs one header.
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, { ok: false, error: 'method_not_allowed' }); }
    const pid = String(query(req).pid || '').trim();
    const go = (location) => { res.statusCode = 302; res.setHeader('Location', location); res.setHeader('Cache-Control', 'no-store'); return res.end(); };
    // A PassKit member id, and nothing of ours. This route asks for no
    // download token -- that is the point of it -- so whatever it accepts
    // here, it hands the signed pass to anyone who can type it.
    //
    // Our own serials are `LBM-` and ten characters, which fits the pattern
    // below, and members.printableSerial prints them on the card as the QR's
    // alt text so a human can read them. So a serial lookup on this route
    // served a native member's pass -- with the pass_auth_token inside it and
    // the LBM: QR that is their balance at the till -- to anyone who glanced
    // at the front of their card. api/pass/:serial gates that same download
    // on the download token, and so does api/gwallet/:serial.
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(pid) || /^LBM-/i.test(pid)) return go(FALLBACK);
    const log = (f) => console.log(JSON.stringify({ src: 'upgrade-link', pid, ...f }));
    let member;
    try {
      // By passkit_member_id only. The import (api/admin/import.js) and
      // lib/adopt.js both write it beside the serial, so this finds every
      // PassKit member there is, and a fallback to pass_serial would only
      // widen the route to serials that are not PassKit's.
      member = await members.findByPasskitId(pid, { db });
      // Joined PassKit after the last import: fetch them and create the record now.
      if (!member) member = await (deps.adopt || adoptFromPassKit)(pid, { db, log });
    } catch (err) {
      log({ event: 'db_error', status: err.status, message: err.message });
      return go(FALLBACK);
    }
    if (!member || member.status !== 'active') { log({ event: 'unknown' }); return go(FALLBACK); }
    const ua = String((req.headers && req.headers['user-agent']) || '');
    if (/Android/i.test(ua)) {
      if (!(deps.gwallet || gwallet).settings(env).enabled) return go(FALLBACK);
      log({ event: 'android', memberId: member.id });
      return go(`/api/gwallet/${encodeURIComponent(member.pass_serial)}?t=${encodeURIComponent(member.download_token)}`);
    }
    try {
      const buf = await (deps.buildPkpass || passLib.buildPkpass)(member);
      log({ event: 'pass', memberId: member.id, serial: member.pass_serial });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
      res.setHeader('Content-Disposition', 'inline; filename="la-bottega-milanese.pkpass"');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(buf);
    } catch (err) {
      log({ event: 'build_failed', message: err.message });
      return go(FALLBACK);
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;

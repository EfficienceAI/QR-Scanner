'use strict';

/**
 * GET /api/pass/:serial?t=<download token>        -> the signed .pkpass
 * GET /api/pass/:serial?t=<download token>&qr=1   -> an SVG QR code of the pass link (for desktop signups)
 *
 * The download token is per member and lives only in the link the signup
 * page shows; it is not the pass's authenticationToken.
 */

const members = require('../../lib/members');
const passLib = require('../../lib/pass');
const { send, query } = require('../../lib/wallet');

function createHandler(deps = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405, { ok: false, error: 'method_not_allowed' }); }
    const q = query(req);
    const serial = String(q.serial || '');
    const token = String(q.t || '');
    let member;
    try {
      member = await (deps.getBySerial || members.getBySerial)(serial, deps);
    } catch (err) {
      if (err.status === 0) return send(res, 503, { ok: false, error: 'not_configured', message: 'The members database is not configured yet.' });
      return send(res, 502, { ok: false, error: 'db_error', message: err.message });
    }
    if (!member || !members.timingSafeEqual(token, member.download_token)) return send(res, 404, { ok: false, error: 'not_found' });

    if (q.qr) {
      const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
      const link = `${base}/api/pass/${encodeURIComponent(serial)}?t=${encodeURIComponent(token)}`;
      const QRCode = deps.QRCode || require('qrcode');
      const svg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(svg);
    }

    try {
      const buf = await (deps.buildPkpass || passLib.buildPkpass)(member);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
      res.setHeader('Content-Disposition', 'inline; filename="la-bottega-milanese.pkpass"');
      res.setHeader('Last-Modified', new Date(member.pass_updated_at || Date.now()).toUTCString());
      res.setHeader('Cache-Control', 'no-store');
      return res.end(buf);
    } catch (err) {
      if (err.code === 'not_configured') return send(res, 503, { ok: false, error: 'not_configured', message: err.message, missing: err.missing });
      console.log(JSON.stringify({ src: 'pass', event: 'build_failed', serial, message: err.message }));
      return send(res, 500, { ok: false, error: 'build_failed', message: 'Could not build the pass.' });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;

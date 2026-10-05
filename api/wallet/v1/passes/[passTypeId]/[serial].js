'use strict';

/**
 * Apple pass web service: the latest version of a pass.
 *   GET /v1/passes/:passTypeIdentifier/:serialNumber   (Authorization: ApplePass <token>)
 * Honours If-Modified-Since with 304.
 */

const passLib = require('../../../../../lib/pass');
const { send, query, authorize, log } = require('../../../../../lib/wallet');

function createHandler(deps = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405); }
    const q = query(req);
    try {
      const member = await authorize(req, q.passTypeId, q.serial, deps);
      if (!member) return send(res, 401);
      const updated = new Date(member.pass_updated_at || Date.now());
      const ims = req.headers && req.headers['if-modified-since'] ? new Date(req.headers['if-modified-since']) : null;
      if (ims && !isNaN(ims) && Math.floor(updated.getTime() / 1000) <= Math.floor(ims.getTime() / 1000)) return send(res, 304);
      const buf = await (deps.buildPkpass || passLib.buildPkpass)(member);
      log('pass_fetched', { serial: q.serial });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
      res.setHeader('Last-Modified', updated.toUTCString());
      res.setHeader('Cache-Control', 'no-store');
      return res.end(buf);
    } catch (err) {
      log('error', { route: 'latest_pass', message: err.message, status: err.status, code: err.code });
      return send(res, err.status === 0 || err.code === 'not_configured' ? 503 : 500);
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;

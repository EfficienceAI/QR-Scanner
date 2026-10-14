'use strict';

/**
 * Apple pass web service: which of this device's passes changed.
 *   GET /v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier?passesUpdatedSince=<tag>
 * Answers { lastUpdated, serialNumbers } or 204 when nothing changed. No auth (per Apple).
 */

const members = require('../../../../../../lib/members');
const passLib = require('../../../../../../lib/pass');
const { send, query, log } = require('../../../../../../lib/wallet');

function createHandler(deps = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405); }
    const q = query(req);
    const s = deps.settings || passLib.settings();
    if (!q.passTypeId || q.passTypeId !== s.passTypeId) return send(res, 404);
    const since = q.passesUpdatedSince ? new Date(q.passesUpdatedSince) : null;
    const sinceIso = since && !isNaN(since) ? since.toISOString() : null;
    try {
      const rows = await (deps.updatedSerialsForDevice || members.updatedSerialsForDevice)(q.deviceId, sinceIso, deps);
      if (!rows.length) return send(res, 204);
      const lastUpdated = rows.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), rows[0].updated_at);
      log('updated_serials', { deviceId: String(q.deviceId).slice(0, 8), count: rows.length });
      return send(res, 200, { lastUpdated: new Date(lastUpdated).toISOString(), serialNumbers: rows.map((r) => r.serial) });
    } catch (err) {
      log('error', { route: 'updated_serials', message: err.message, status: err.status });
      return send(res, err.status === 0 ? 503 : 500);
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;

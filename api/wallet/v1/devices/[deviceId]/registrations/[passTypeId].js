'use strict';

/**
 * Apple pass web service: which of this device's passes changed.
 *   GET /v1/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier?passesUpdatedSince=<tag>
 * Answers { lastUpdated, serialNumbers } or 204 when nothing changed. No auth (per Apple).
 */

const members = require('../../../../../../lib/members');
const passLib = require('../../../../../../lib/pass');
const { send, query, log } = require('../../../../../../lib/wallet');

/**
 * A timestamp Postgres will accept, checked without reparsing it.
 *
 * Deliberately validate-only: the tag must reach the database exactly as
 * Wallet sent it. Postgres timestamptz keeps microseconds and the RPC
 * compares `m.pass_updated_at > p_since`, but a JS Date holds milliseconds,
 * so round-tripping the tag through `new Date(...).toISOString()` turned
 * .933456 into .933 -- making the comparison always true, so the 204
 * "nothing changed" branch below could never be reached by any pass whose
 * timestamp has sub-millisecond precision, which is all of them, since
 * now() yields microseconds. Every device therefore re-requested every pass
 * on every poll, forever, saved only by the If-Modified-Since 304 on the
 * pass fetch itself. Cost and battery, not wrong data -- but endless.
 */
function plausibleTimestamp(value) {
  if (typeof value !== 'string' || value.length > 64) return false;
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}(:?\d{2})?)?$/.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function createHandler(deps = {}) {
  return async function handler(req, res) {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return send(res, 405); }
    const q = query(req);
    const s = deps.settings || passLib.settings();
    if (!q.passTypeId || q.passTypeId !== s.passTypeId) return send(res, 404);
    // Verbatim, at full precision -- see plausibleTimestamp above.
    const since = plausibleTimestamp(q.passesUpdatedSince) ? q.passesUpdatedSince : null;
    try {
      const rows = await (deps.updatedSerialsForDevice || members.updatedSerialsForDevice)(q.deviceId, since, deps);
      if (!rows.length) return send(res, 204);
      // The RPC orders by pass_updated_at ascending, so the last row is the
      // newest. Returned as the database gave it to us, for the same reason.
      const lastUpdated = rows[rows.length - 1].updated_at;
      log('updated_serials', { deviceId: String(q.deviceId).slice(0, 8), count: rows.length });
      return send(res, 200, { lastUpdated, serialNumbers: rows.map((r) => r.serial) });
    } catch (err) {
      log('error', { route: 'updated_serials', message: err.message, status: err.status });
      return send(res, err.status === 0 ? 503 : 500);
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;

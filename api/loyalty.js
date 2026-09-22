'use strict';

/**
 * Loyalty Scanner API - replaces the Make.com webhook.
 *
 * The scanner page POSTs the same three payloads it always has:
 *   { action: 'lookup_customer', qr_data }
 *   { action: 'add_points',      qr_data, points }
 *   { action: 'redeem_points',   qr_data, points_to_remove }
 *
 * Every response carries a top-level `points` field (the member's balance
 * after the action) because that is the key the page reads.
 */

const passkit = require('../lib/passkit');

const SOURCE_TAG = 'loyalty-scanner';

function positiveInt(value, fallback) {
  const n = typeof value === 'string' ? parseInt(value, 10) : Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function settings() {
  return {
    redeemCost: positiveInt(process.env.LOYALTY_REDEEM_COST, 9),
    maxPointsPerScan: positiveInt(process.env.LOYALTY_MAX_POINTS_PER_SCAN, 99),
    idMode: (process.env.PASSKIT_ID_MODE || 'id').toLowerCase(),
  };
}

function readBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

/**
 * Turn whatever the QR code contained into a PassKit member reference.
 * PassKit member passes encode the member id by default. We also tolerate
 * a JSON blob or a URL whose last path segment is the id.
 */
function memberRefFromQr(raw, idMode) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;

  if (s[0] === '{') {
    try {
      const o = JSON.parse(s);
      const id = o.id || o.memberId || o.member_id || o.passkitId;
      if (typeof id === 'string' && id.trim()) return { id: id.trim() };
      const ext = o.externalId || o.external_id;
      if (typeof ext === 'string' && ext.trim()) return { externalId: ext.trim() };
    } catch {
      /* not JSON, fall through */
    }
  }

  if (/^https?:\/\//i.test(s)) {
    try {
      const last = new URL(s).pathname.split('/').filter(Boolean).pop();
      if (last) s = last;
    } catch {
      /* keep raw string */
    }
  }

  if (s.length > 200) return null;
  return idMode === 'externalid' ? { externalId: s } : { id: s };
}

function summarizeMember(m) {
  const p = m.person || {};
  const name = p.displayName || [p.forename, p.surname].filter(Boolean).join(' ') || null;
  return {
    id: m.id || null,
    externalId: m.externalId || null,
    name,
    tier: m.tierId || null,
    status: m.status || null,
    points: num(m.points),
  };
}

function eventDetails(action, amount) {
  const sign = action === 'add_points' ? '+' : '-';
  return {
    externalServiceId: SOURCE_TAG,
    notes: `Loyalty Scanner: ${sign}${amount} point${amount === 1 ? '' : 's'}`,
    metaData: { source: SOURCE_TAG, action },
  };
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return send(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  const cfg = settings();
  const body = readBody(req);
  const action = String(body.action || '').toLowerCase();
  const ref = memberRefFromQr(body.qr_data, cfg.idMode);
  const started = Date.now();
  const log = (extra) =>
    console.log(JSON.stringify({ src: SOURCE_TAG, action, ref, ms: Date.now() - started, ...extra }));

  if (!ref) {
    return send(res, 400, { ok: false, error: 'missing_qr_data', message: 'Scan a customer QR code first.' });
  }

  try {
    if (action === 'lookup_customer') {
      const member = summarizeMember(await passkit.getMember(ref));
      log({ points: member.points });
      return send(res, 200, { ok: true, action, points: member.points, member });
    }

    if (action === 'add_points') {
      const points = positiveInt(body.points, 0);
      if (!points || points > cfg.maxPointsPerScan) {
        return send(res, 400, {
          ok: false,
          error: 'invalid_points',
          message: `points must be a whole number between 1 and ${cfg.maxPointsPerScan}.`,
        });
      }
      const result = await passkit.earnPoints(ref, points, eventDetails(action, points));
      const balance = num(result.points);
      log({ added: points, points: balance });
      return send(res, 200, { ok: true, action, added: points, points: balance });
    }

    if (action === 'redeem_points') {
      // The server decides the redemption cost; the client value is only logged.
      const cost = cfg.redeemCost;
      const requested = positiveInt(body.points_to_remove, null);
      const before = summarizeMember(await passkit.getMember(ref));
      if (before.points < cost) {
        log({ denied: 'insufficient_points', balance: before.points, cost, requested });
        return send(res, 409, {
          ok: false,
          error: 'insufficient_points',
          message: `Customer has ${before.points} point${before.points === 1 ? '' : 's'}, needs ${cost} to redeem.`,
          points: before.points,
          required: cost,
        });
      }
      const result = await passkit.burnPoints(ref, cost, eventDetails(action, cost));
      const balance = num(result.points);
      log({ redeemed: cost, requested, points: balance });
      return send(res, 200, { ok: true, action, redeemed: cost, points: balance });
    }

    return send(res, 400, {
      ok: false,
      error: 'unknown_action',
      message: 'action must be lookup_customer, add_points or redeem_points.',
    });
  } catch (err) {
    if (err instanceof passkit.PassKitError) {
      log({ error: 'passkit', status: err.status, message: err.message, path: err.path });
      if (err.status === 404) {
        return send(res, 404, { ok: false, error: 'member_not_found', message: 'No loyalty member matches this QR code.' });
      }
      if (err.status === 401 || err.status === 403) {
        return send(res, 502, {
          ok: false,
          error: 'passkit_auth',
          message: 'PassKit rejected our credentials. Check PASSKIT_API_KEY / PASSKIT_API_SECRET.',
        });
      }
      return send(res, 502, { ok: false, error: 'passkit_error', message: err.message });
    }
    if (err instanceof passkit.ConfigError) {
      log({ error: 'config', message: err.message });
      return send(res, 500, { ok: false, error: 'not_configured', message: err.message });
    }
    console.error(err);
    return send(res, 500, { ok: false, error: 'internal', message: 'Unexpected error.' });
  }
};

module.exports._internals = { memberRefFromQr, summarizeMember, positiveInt };

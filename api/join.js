'use strict';

/**
 * POST /api/join  { full_name, email, phone, consent }
 * The signup form (public/join). Creates the member and answers with the
 * link that downloads their signed pass. An email that already has a member
 * is told to ask at the counter -- it does NOT get that member's pass back;
 * see existingResponse() for why that matters more than it looks.
 */

const members = require('../lib/members');
const { db: defaultDb } = require('../lib/db');

const RATE_LIMIT = { max: 20, windowMs: 10 * 60 * 1000, maxTracked: 2000 };
const hits = new Map();

function clientKey(req) {
  const h = (req && req.headers) || {};
  return String(h['x-forwarded-for'] || '').split(',')[0].trim() || String(h['x-real-ip'] || '') || 'unknown';
}
function limited(key, now = Date.now()) {
  if (hits.size > RATE_LIMIT.maxTracked) hits.clear();
  const rec = hits.get(key) || { n: 0, first: now };
  if (now - rec.first > RATE_LIMIT.windowMs) { rec.n = 0; rec.first = now; }
  rec.n += 1;
  hits.set(key, rec);
  return rec.n > RATE_LIMIT.max;
}

function allowedOrigin(req) {
  const origin = String((req.headers && req.headers.origin) || '');
  if (!origin) return null;
  const list = String(process.env.JOIN_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : null;
}

function send(res, status, payload, req) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  const origin = req && allowedOrigin(req);
  if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body); } catch { return {}; }
}

function passUrlFor(member) {
  return `/api/pass/${encodeURIComponent(member.pass_serial)}?t=${encodeURIComponent(member.download_token)}`;
}
/** The Google Wallet link, or null where Google Wallet is not configured. */
function googleUrlFor(member, env = process.env) {
  return require('../lib/gwallet').settings(env).enabled
    ? `/api/gwallet/${encodeURIComponent(member.pass_serial)}?t=${encodeURIComponent(member.download_token)}`
    : null;
}

/**
 * What a brand-new member gets: their own pass, which is theirs to have.
 */
function createdResponse(member, env) {
  return {
    ok: true,
    existing: false,
    member: { id: member.id, name: member.full_name, points: Number(member.points) || 0 },
    passUrl: passUrlFor(member),
    googleUrl: googleUrlFor(member, env),
  };
}

/**
 * What an email that already has a member gets: nothing identifying at all.
 *
 * This endpoint is public by design -- it replaces a Carrd form -- and an
 * email address is not a secret. Returning the existing member's details here
 * meant one unauthenticated request, with a made-up name and phone, handed
 * over everything needed to become that customer:
 *
 *   - `member.id`, which *is* the QR payload (`LBM:<uuid>`), so the caller
 *     can render the victim's card and spend their points at the counter;
 *   - `passUrl`, whose `?t=` download token fetches their signed .pkpass and
 *     with it the Apple authenticationToken for the pass web service;
 *   - their real name and their balance.
 *
 * validateJoin never checked the submitted name or phone against the stored
 * row -- it could not, they are only used when creating -- so the email was
 * the single secret involved. Hence: no member object, no passUrl, no
 * googleUrl, no id. The customer goes to the counter, where staff have
 * GET /api/admin/member for exactly this.
 *
 * One thing is still disclosed and cannot be helped here: that the address
 * belongs to a member, because a genuine new signup must get its pass back.
 * Knowing someone is a customer is not the same as holding their card.
 *
 * The better answer, once a mailer exists, is to email the link to the
 * address itself -- that makes the email a proof of control rather than a
 * lookup key, and restores the "repeat signup gets their pass" convenience.
 */
function existingResponse() {
  return {
    ok: true,
    existing: true,
    message: 'You are already a member. Ask a member of staff and they can bring your card up on the till.',
  };
}

function createHandler(deps = {}) {
  const db = deps.db || defaultDb;
  return async function handler(req, res) {
    if (req.method === 'OPTIONS') {
      const origin = allowedOrigin(req);
      res.statusCode = origin ? 204 : 403;
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      return res.end();
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return send(res, 405, { ok: false, error: 'method_not_allowed' }, req); }
    if (!db.enabled()) return send(res, 503, { ok: false, error: 'not_configured', message: 'The members database is not configured yet.' }, req);
    if (limited(clientKey(req), deps.now ? deps.now() : Date.now())) return send(res, 429, { ok: false, error: 'rate_limited', message: 'Too many attempts. Please try again in a few minutes.' }, req);

    const { ok, errors, values } = members.validateJoin(readBody(req));
    if (!ok) return send(res, 400, { ok: false, error: 'invalid', errors }, req);

    const log = (f) => console.log(JSON.stringify({ src: 'join', ...f }));
    try {
      let member = await members.findByEmail(values.email, { db });
      let existing = true;
      if (!member) {
        existing = false;
        member = await members.createMember(values, { db });
      }
      log({ event: existing ? 'join.existing' : 'join.created', memberId: member.id, serial: member.pass_serial });
      if (existing) return send(res, 200, existingResponse(), req);
      return send(res, 201, createdResponse(member, deps.env), req);
    } catch (err) {
      // A concurrent signup on the same address lands here. Same rule as the
      // path above: an existing member is never handed back to this caller.
      if (err.status === 409 || /duplicate key/i.test(String(err.message))) {
        const member = await members.findByEmail(values.email, { db }).catch(() => null);
        if (member) {
          log({ event: 'join.existing', memberId: member.id, serial: member.pass_serial, via: 'duplicate_key' });
          return send(res, 200, existingResponse(), req);
        }
      }
      log({ event: 'join.failed', status: err.status, message: err.message });
      return send(res, 502, { ok: false, error: 'db_error', message: 'Could not save your details. Please try again.' }, req);
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports._internals = { limited, passUrlFor, googleUrlFor, hits, createdResponse, existingResponse };

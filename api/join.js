'use strict';

/**
 * POST /api/join  { full_name, email, phone, consent }
 *
 * The signup form (public/join). A new member is created and gets the link
 * that downloads their signed pass.
 *
 * An email or mobile number that is already on a card gets *no* card back.
 * That used to be the behaviour, and it meant one unauthenticated request --
 * a made-up name and phone, and the victim's email -- returned their member
 * id (which *is* the QR payload, so the caller could render their card and
 * spend their points), their pass download token, their name and their
 * balance. An email address is not a secret, and neither is a mobile number.
 *
 * Instead a six-digit code goes to the email on the card and /api/recover
 * trades it for the link, which makes control of the inbox the proof rather
 * than knowledge of the address. Where recovery is not configured, the
 * customer is sent to the counter, where staff have GET /api/admin/member.
 */

const members = require('../lib/members');
const recovery = require('../lib/recovery');
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
      // One person, one card. An email or a mobile number that is already on
      // a card never gets that card's link straight back (anyone who knew a
      // friend's number could collect their points): a code goes to the
      // email on the card instead, and /api/recover trades it for the link.
      const existingCard = async (member) => {
        const rec = deps.recovery || recovery;
        const env = deps.env || process.env;
        if (!rec.settings(env).enabled || !member.email) {
          log({ event: 'join.existing', memberId: member.id, recovery: 'off' });
          return send(res, 200, { ok: true, existing: true, recovery: false, message: 'That email or mobile number is already on a card. Please ask a member of staff to help you get it back.' }, req);
        }
        const r = await rec.startRecovery(member, { db, env });
        log({ event: 'join.existing', memberId: member.id, recovery: r.sent ? 'sent' : r.reason });
        return send(res, 200, { ok: true, existing: true, recovery: true, sent: r.sent, hint: r.hint || recovery.maskEmail(member.email) }, req);
      };
      let member = await members.findByEmail(values.email, { db });
      if (!member) member = await members.findByPhone(values.phone, { db });
      if (member) return existingCard(member);
      member = await members.createMember(values, { db });
      log({ event: 'join.created', memberId: member.id, serial: member.pass_serial });
      return send(res, 201, {
        ok: true,
        existing: false,
        member: { id: member.id, name: member.full_name, points: Number(member.points) || 0 },
        passUrl: passUrlFor(member), googleUrl: googleUrlFor(member, deps.env),
      }, req);
    } catch (err) {
      if (err.status === 409 || /duplicate key/i.test(String(err.message))) {
        const member = await members.findByEmail(values.email, { db }).catch(() => null);
        if (member) return send(res, 200, { ok: true, existing: true, recovery: false, message: 'That email is already on a card. Please ask a member of staff to help you get it back.' }, req);
      }
      log({ event: 'join.failed', status: err.status, message: err.message });
      return send(res, 502, { ok: false, error: 'db_error', message: 'Could not save your details. Please try again.' }, req);
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports._internals = { limited, passUrlFor, googleUrlFor, hits, send, clientKey, readBody, allowedOrigin };

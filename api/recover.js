'use strict';

/**
 * Lost your pass?
 *   POST /api/recover { email | phone }         -> a six-digit code goes to the email on the card
 *   POST /api/recover { email | phone, code }   -> the card's links, when the code is right
 *
 * The first call answers the same way whether or not anything matched, so
 * it cannot be used to find out whose number is on a card. Same rate limit
 * and origin rules as /api/join.
 */

const members = require('../lib/members');
const recovery = require('../lib/recovery');
const { db: defaultDb } = require('../lib/db');
const join = require('./join');

const { send, limited, clientKey, readBody, passUrlFor, googleUrlFor } = join._internals;

function createHandler(deps = {}) {
  const db = deps.db || defaultDb;
  const rec = deps.recovery || recovery;
  const env = deps.env || process.env;
  return async function handler(req, res) {
    if (req.method === 'OPTIONS') return join(req, res);
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); return send(res, 405, { ok: false, error: 'method_not_allowed' }, req); }
    if (!db.enabled()) return send(res, 503, { ok: false, error: 'not_configured', message: 'The members database is not configured yet.' }, req);
    if (!rec.settings(env).enabled) return send(res, 503, { ok: false, error: 'not_configured', message: 'Pass recovery is not switched on yet. Please ask a member of staff.' }, req);
    const now = deps.now ? deps.now() : Date.now();
    if (limited(clientKey(req), now)) return send(res, 429, { ok: false, error: 'rate_limited', message: 'Too many attempts. Please try again in a few minutes.' }, req);

    const body = readBody(req);
    const email = members.normalizeEmail(body.email);
    const phone = members.normalizePhone(body.phone);
    if (!email && !phone) return send(res, 400, { ok: false, error: 'invalid', message: 'Enter the email or mobile number on your card.' }, req);
    const code = String(body.code || '').trim();
    const log = (f) => console.log(JSON.stringify({ src: 'recover', ...f }));

    try {
      let member = email ? await members.findByEmail(email, { db }) : null;
      if (!member && phone) member = await members.findByPhone(phone, { db });

      if (!code) {
        if (member && member.email) {
          const r = await rec.startRecovery(member, { db, env, now: () => now });
          log({ event: r.sent ? 'code_sent' : 'code_skipped', reason: r.reason || null, memberId: member.id });
          return send(res, 200, { ok: true, sent: true, hint: r.hint || null }, req);
        }
        log({ event: 'no_match' });
        return send(res, 200, { ok: true, sent: true, hint: null }, req);
      }

      const fresh = member ? await rec.verifyCode(member, code, { db, now: () => now }) : null;
      if (!fresh) {
        log({ event: 'bad_code', memberId: member ? member.id : null });
        return send(res, 400, { ok: false, error: 'bad_code', message: 'That code is not right or has expired. Check the email, or ask for a new code.' }, req);
      }
      log({ event: 'recovered', memberId: fresh.id, serial: fresh.pass_serial });
      return send(res, 200, {
        ok: true, existing: true, recovered: true,
        member: { id: fresh.id, name: fresh.full_name, points: Number(fresh.points) || 0 },
        passUrl: passUrlFor(fresh), googleUrl: googleUrlFor(fresh, env),
      }, req);
    } catch (err) {
      log({ event: 'failed', status: err.status, message: err.message });
      return send(res, err.status === 0 ? 503 : 502, { ok: false, error: 'recovery_failed', message: 'We could not send the code just now. Please try again in a minute.' }, req);
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;

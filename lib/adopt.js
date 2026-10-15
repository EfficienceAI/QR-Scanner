'use strict';

/**
 * A PassKit member we have not imported yet (joined after the last export)
 * meets the new system for the first time: through the upgrade link on the
 * back of their pass, or at the till. Rather than turn them away, fetch them
 * from PassKit and create their record on the spot, the same shape as the
 * import gives: PassKit id, name, email, phone, balance, and the PassKit id
 * as the pass serial so the new card replaces the old one in place.
 *
 * Resolves to the member row, or null when PassKit does not know the id
 * either (or is not configured here). Never throws.
 */

const members = require('./members');
const passkit = require('./passkit');
const { db: defaultDb } = require('./db');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

async function adoptFromPassKit(pid, { db = defaultDb, pk = passkit, log = () => {} } = {}) {
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(String(pid || ''))) return null;
  let raw;
  try {
    raw = await pk.getMember({ id: pid });
  } catch (err) {
    log({ event: 'adopt_lookup_failed', status: err.status, message: err.message });
    return null;
  }
  const p = (raw && raw.person) || {};
  const fullName = String(p.displayName || [p.forename, p.surname].filter(Boolean).join(' ') || '').trim().replace(/\s+/g, ' ') || 'Member';
  const points = num(raw.points);
  const values = {
    full_name: fullName.slice(0, 80),
    email: members.normalizeEmail(p.emailAddress),
    phone: members.normalizePhone(p.mobileNumber),
    consent_marketing: false,
    source: 'passkit-import',
    passkit_member_id: pid,
  };
  if (Number.isInteger(points) && points >= 0) values.points = points;
  try {
    const created = await members.createMember(values, { db, serial: pid });
    log({ event: 'adopted', memberId: created.id, points: values.points === undefined ? 'unknown' : values.points });
    return created;
  } catch (err) {
    // The email is already on a card that joined natively: link it instead.
    if ((err.status === 409 || /duplicate key/i.test(String(err.message))) && values.email) {
      const existing = await members.findByEmail(values.email, { db }).catch(() => null);
      if (existing && !existing.passkit_member_id) {
        await db.update('members', `id=eq.${encodeURIComponent(existing.id)}`, { passkit_member_id: pid, updated_at: new Date().toISOString() });
        log({ event: 'adopted_linked', memberId: existing.id });
        return { ...existing, passkit_member_id: pid };
      }
    }
    log({ event: 'adopt_failed', status: err.status, message: err.message });
    return null;
  }
}

module.exports = { adoptFromPassKit };

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
 * either, when it is not configured here, or when the balance it reports
 * cannot be read -- see the check below, which is the "null, not 0" rule in
 * CLAUDE.md on the one path that issues a card. Never throws.
 *
 * `points` lets a caller that has already read a balance supply it instead of
 * trusting the one on the PassKit record: lib/native-scan.js has checked the
 * scan's balance before it ever calls this.
 */

const members = require('./members');
const passkit = require('./passkit');
const { db: defaultDb } = require('./db');

const PASSKIT_ID = /^[A-Za-z0-9_-]{10,40}$/;

/** Set passkit_member_id on a card that joined natively. Writes no balance. */
async function link(existing, pid, { db, log }) {
  try {
    await db.update('members', `id=eq.${encodeURIComponent(existing.id)}`, { passkit_member_id: pid, updated_at: new Date().toISOString() });
  } catch (err) {
    log({ event: 'adopt_link_failed', status: err.status, message: err.message });
    return null;
  }
  log({ event: 'adopted_linked', memberId: existing.id });
  return { ...existing, passkit_member_id: pid };
}

async function adoptFromPassKit(pid, { db = defaultDb, pk = passkit, log = () => {}, points: known } = {}) {
  if (!PASSKIT_ID.test(String(pid || ''))) return null;
  let raw;
  try {
    raw = await pk.getMember({ id: pid });
  } catch (err) {
    log({ event: 'adopt_lookup_failed', status: err.status, message: err.message });
    return null;
  }
  const p = (raw && raw.person) || {};
  const fullName = String(p.displayName || [p.forename, p.surname].filter(Boolean).join(' ') || '').trim().replace(/\s+/g, ' ') || 'Member';
  const values = {
    full_name: fullName.slice(0, 80),
    email: members.normalizeEmail(p.emailAddress),
    phone: members.normalizePhone(p.mobileNumber),
    consent_marketing: false,
    source: 'passkit-import',
    passkit_member_id: pid,
  };

  // members.readAmount, not Number(): Number answers 0 for null, '', false
  // and [] alike, and PassKit leaves points off a record it has nothing for.
  // A fraction or a negative is no more writable than an unreadable one --
  // the column is `integer not null check (points >= 0)`.
  const supplied = known === undefined ? (raw && raw.points) : known;
  const points = members.readAmount(supplied);
  const writable = points !== null && Number.isInteger(points) && points >= 0;

  // An email already on a card that joined natively is linked rather than
  // duplicated. That writes no balance, so it is allowed whether or not the
  // PassKit one could be read -- and it is checked before creating because
  // the balance check below must not stand between that customer and the card
  // they already have.
  if (values.email) {
    const existing = await members.findByEmail(values.email, { db }).catch(() => null);
    if (existing && !existing.passkit_member_id) return link(existing, pid, { db, log });
    if (existing && existing.passkit_member_id !== pid) {
      // Their email is on a different PassKit member's card. The import
      // reports this and drops the email; here the only safe answer is to
      // hand over nobody, and let the counter sort out which card is whose.
      log({ event: 'adopt_refused', reason: 'email_on_another_card', memberId: existing.id });
      return null;
    }
    if (existing) return existing;
  }

  // This is the call that issues the card the customer walks away with, and
  // a 0 here is indistinguishable afterwards from a customer who really has
  // nothing. Refusing sends them to /upgrade and, past that, to the counter,
  // where staff have /api/admin/member and /api/admin/points. A card handed
  // over showing nothing is the one outcome nobody can tell went wrong.
  if (!writable) {
    log({ event: 'adopt_refused', reason: 'unreadable_points', got: JSON.stringify(supplied) || 'undefined' });
    return null;
  }
  values.points = points;
  try {
    const created = await members.createMember(values, { db, serial: pid });
    log({ event: 'adopted', memberId: created.id, points });
    return created;
  } catch (err) {
    // Belt and braces for a duplicate the lookup above could not see: a
    // second request for the same person in flight, or a clash on phone
    // rather than email.
    if ((err.status === 409 || /duplicate key/i.test(String(err.message))) && values.email) {
      const existing = await members.findByEmail(values.email, { db }).catch(() => null);
      if (existing && !existing.passkit_member_id) return link(existing, pid, { db, log });
    }
    log({ event: 'adopt_failed', status: err.status, message: err.message });
    return null;
  }
}

module.exports = { adoptFromPassKit };

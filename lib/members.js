'use strict';

/**
 * Native loyalty members: the customers who joined through our own signup
 * page and hold a pass we signed ourselves. Points for these members live in
 * our database, not PassKit.
 */

const crypto = require('crypto');
const { db: defaultDb, DbError } = require('./db');

class InsufficientPointsError extends Error {
  constructor(message = 'insufficient_points') {
    super(message);
    this.name = 'InsufficientPointsError';
  }
}
class NotFoundError extends Error {
  constructor(message = 'member_not_found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

const SERIAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const QR_PREFIX = 'LBM:';

function newSerial() {
  const bytes = crypto.randomBytes(10);
  let s = '';
  for (const b of bytes) s += SERIAL_ALPHABET[b % SERIAL_ALPHABET.length];
  return `LBM-${s}`;
}
function newToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}
function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function normalizeEmail(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254 ? s : null;
}

/** UK-first phone normalisation to E.164. Returns null when it does not look like a phone number. */
function normalizePhone(raw, defaultCountry = '44') {
  let s = String(raw || '').replace(/[\s().-]/g, '');
  if (!s) return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+')) {
    const digits = s.slice(1);
    if (!/^\d{8,15}$/.test(digits)) return null;
    return `+${digits}`;
  }
  if (!/^\d{7,15}$/.test(s)) return null;
  if (s.startsWith('0')) return `+${defaultCountry}${s.slice(1)}`;
  if (s.startsWith(defaultCountry) && s.length >= 11) return `+${s}`;
  return `+${defaultCountry}${s}`;
}

function validateJoin(input = {}) {
  const errors = {};
  const name = String(input.full_name || input.name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) errors.full_name = 'Please enter your full name.';
  const email = normalizeEmail(input.email);
  if (!email) errors.email = 'Please enter a valid email address.';
  const phone = normalizePhone(input.phone);
  if (!phone) errors.phone = 'Please enter a valid mobile number.';
  const consent = input.consent === true || input.consent === 'true' || input.consent === 'on' || input.consent === 1;
  return { ok: Object.keys(errors).length === 0, errors, values: { full_name: name, email, phone, consent_marketing: consent } };
}

const enc = encodeURIComponent;

async function findByEmail(email, { db = defaultDb } = {}) {
  const e = normalizeEmail(email);
  return e ? db.selectOne('members', `email_norm=eq.${enc(e)}`) : null;
}
async function findByPhone(phone, { db = defaultDb } = {}) {
  const p = normalizePhone(phone);
  return p ? db.selectOne('members', `phone=eq.${enc(p)}`) : null;
}
async function getBySerial(serial, { db = defaultDb } = {}) {
  return serial ? db.selectOne('members', `pass_serial=eq.${enc(serial)}`) : null;
}
async function getById(id, { db = defaultDb } = {}) {
  return /^[0-9a-f-]{36}$/i.test(String(id || '')) ? db.selectOne('members', `id=eq.${enc(id)}`) : null;
}

/** The QR on our passes encodes "LBM:<member uuid>". */
function memberIdFromQr(qrData) {
  const s = String(qrData || '').trim();
  if (!s.startsWith(QR_PREFIX)) return null;
  const id = s.slice(QR_PREFIX.length).trim();
  return /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null;
}
function qrMessage(member) {
  return `${QR_PREFIX}${member.id}`;
}

/** A new member's row, with fresh pass credentials. */
function newMemberRow(values, { serial } = {}) {
  const row = {
    full_name: values.full_name,
    email: values.email || null,
    phone: values.phone || null,
    consent_marketing: Boolean(values.consent_marketing),
    source: values.source || 'join',
    // Imported members keep the PassKit member id as their serial, so the
    // pass we issue replaces the PassKit card in place.
    pass_serial: serial || newSerial(),
    pass_auth_token: newToken(24),
    download_token: newToken(24),
  };
  if (values.passkit_member_id) row.passkit_member_id = values.passkit_member_id;
  if (Number.isInteger(values.points)) row.points = values.points;
  return row;
}
async function createMember(values, { db = defaultDb, serial } = {}) {
  return db.insert('members', newMemberRow(values, { serial }));
}

/** Change a member's balance atomically. Resolves to the new balance. */
async function adjustPoints(memberId, delta, { db = defaultDb } = {}) {
  try {
    const rows = await db.rpc('adjust_member_points', { p_member: memberId, p_delta: delta });
    const r = Array.isArray(rows) ? rows[0] : rows;
    return Number(r && r.points);
  } catch (err) {
    const msg = String((err && err.message) || '');
    if (/insufficient_points/.test(msg)) throw new InsufficientPointsError();
    if (/member_not_found/.test(msg)) throw new NotFoundError();
    throw err;
  }
}

/** The imported row for a PassKit member, if that person has been imported. */
async function findByPasskitId(passkitId, { db = defaultDb } = {}) {
  const s = String(passkitId || '').trim();
  return /^[A-Za-z0-9_-]{10,40}$/.test(s) ? db.selectOne('members', `passkit_member_id=eq.${enc(s)}`) : null;
}

/**
 * The serial to print on the card, or null when there is nothing to print.
 *
 * Only our own short serials are shown. An imported member's pass_serial *is*
 * their old PassKit member id -- kept deliberately, so Wallet swaps the new
 * card in place of the old one -- and printing a 22-character PassKit id
 * under the new QR made the upgraded pass look unchanged, which is the exact
 * confusion the upgrade was meant to remove.
 *
 * Shared between lib/pass.js and lib/gwallet.js so that the next fix to this
 * format cannot land on one platform only, which is how the Android card
 * ended up still showing it.
 */
function printableSerial(member) {
  const serial = String((member && member.pass_serial) || '');
  return /^LBM-/.test(serial) ? serial : null;
}

/**
 * The amount as a number, or null when it cannot be read.
 *
 * Deliberately stricter than Number(), which answers 0 for null, '', [] and
 * false alike -- and a 0 written over a real balance is exactly the bug this
 * exists to stop. Only a finite number, or a non-blank string that parses to
 * one, is an amount. Everything else is "we do not know", which per
 * CLAUDE.md is null and must never be written as a balance.
 */
function readAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Overwrite a balance with the one PassKit just reported. Used only while both
 * systems run: a scan of a PassKit pass also lands on the imported member's
 * row, so the pass they upgrade to already shows the right stamps.
 *
 * This is an absolute SET, not an adjustment, so it is the one call here that
 * can destroy a balance. `Number(points) || 0` used to turn undefined, null,
 * '' or 'n/a' into 0 and write it -- for imported members, the longest-standing
 * customers, with the zero pushed straight to their phone. An amount that
 * cannot be read is not a balance: callers must not reach this with one.
 */
async function syncPoints(memberId, points, { db = defaultDb, visited = false } = {}) {
  const n = readAmount(points);
  if (n === null) throw new TypeError(`syncPoints: refusing to set an unreadable balance (${JSON.stringify(points) || String(points)})`);
  const now = new Date().toISOString();
  const patch = { points: Math.max(0, Math.round(n)), updated_at: now, pass_updated_at: now };
  if (visited) patch.last_visit_at = now;
  const rows = await db.update('members', `id=eq.${enc(memberId)}`, patch);
  return Array.isArray(rows) ? rows[0] || null : rows;
}

/** Mark a pass as changed (so Wallet re-fetches it) without touching the balance, e.g. after an artwork or theme change. */
async function touchPass(serial, { db = defaultDb } = {}) {
  const rows = await db.update('members', `pass_serial=eq.${enc(serial)}`, { pass_updated_at: new Date().toISOString() });
  return Array.isArray(rows) ? rows[0] || null : rows;
}

/**
 * A page of passes for a refresh-everything run, as a keyset scan over
 * `members` ordered by serial. Returns at most `limit` serials; pass the last
 * one back as `after` for the next page, and stop when a page comes back
 * short.
 *
 * This replaced registeredSerials, which walked `pass_registrations` instead,
 * and was wrong twice over:
 *
 *  - That table is Apple-only. A customer who saved only the Google Wallet
 *    card has a gwallet_object_id and no registration row, so a
 *    refresh-everything run never touched them and their card kept the old
 *    artwork indefinitely. `members` is where both pass_serial and
 *    gwallet_object_id live, so enumerating it reaches both platforms.
 *  - It paged by offset while de-duplicating the result, so the page size
 *    applied to rows and the "is there another page" test applied to the
 *    shorter de-duplicated array. One customer with an iPhone and an Apple
 *    Watch -- or a reinstall leaving two registrations -- made a full page
 *    look short, the walk stopped, and the operator was told the refresh had
 *    finished. Every pass past the first page was silently never touched.
 *
 * A cursor rather than an offset, so rows written during the walk cannot
 * make it skip or repeat. One row per member, so there is nothing to
 * de-duplicate and the page-size test is sound.
 */
async function passPage({ limit = 200, after = null } = {}, { db = defaultDb } = {}) {
  const cap = Math.max(1, Math.min(Number(limit) || 200, 500));
  const cursor = after ? `&pass_serial=gt.${enc(String(after))}` : '';
  const rows = await db.select('members', `select=pass_serial&order=pass_serial.asc&limit=${cap}${cursor}`);
  return (Array.isArray(rows) ? rows : []).map((r) => r.pass_serial).filter(Boolean);
}

// ---- Wallet device registrations ----
async function registerDevice({ deviceId, serial, pushToken }, { db = defaultDb } = {}) {
  const existing = await db.selectOne('pass_registrations', `device_library_id=eq.${enc(deviceId)}&pass_serial=eq.${enc(serial)}`);
  await db.upsert('pass_registrations', [{ device_library_id: deviceId, pass_serial: serial, push_token: pushToken }], 'device_library_id,pass_serial');
  return { created: !existing };
}
async function unregisterDevice({ deviceId, serial }, { db = defaultDb } = {}) {
  await db.remove('pass_registrations', `device_library_id=eq.${enc(deviceId)}&pass_serial=eq.${enc(serial)}`);
}
async function registrationsForSerial(serial, { db = defaultDb } = {}) {
  const rows = await db.select('pass_registrations', `pass_serial=eq.${enc(serial)}&select=device_library_id,push_token`);
  return Array.isArray(rows) ? rows : [];
}
async function removeRegistrationByToken(pushToken, { db = defaultDb } = {}) {
  await db.remove('pass_registrations', `push_token=eq.${enc(pushToken)}`);
}
async function updatedSerialsForDevice(deviceId, since, { db = defaultDb } = {}) {
  const rows = await db.rpc('pass_updated_serials', { p_device: deviceId, p_since: since || null });
  return Array.isArray(rows) ? rows : [];
}

module.exports = {
  QR_PREFIX, newSerial, newToken, timingSafeEqual,
  normalizeEmail, normalizePhone, validateJoin,
  findByEmail, findByPhone, getBySerial, getById, memberIdFromQr, qrMessage,
  newMemberRow, createMember, adjustPoints, touchPass, passPage, findByPasskitId, syncPoints, readAmount,
  printableSerial,
  registerDevice, unregisterDevice, registrationsForSerial, removeRegistrationByToken, updatedSerialsForDevice,
  InsufficientPointsError, NotFoundError, DbError,
};

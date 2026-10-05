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

async function createMember(values, { db = defaultDb } = {}) {
  const row = {
    full_name: values.full_name,
    email: values.email,
    phone: values.phone,
    consent_marketing: Boolean(values.consent_marketing),
    source: values.source || 'join',
    pass_serial: newSerial(),
    pass_auth_token: newToken(24),
    download_token: newToken(24),
  };
  if (values.passkit_member_id) row.passkit_member_id = values.passkit_member_id;
  if (Number.isInteger(values.points)) row.points = values.points;
  return db.insert('members', row);
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
  createMember, adjustPoints,
  registerDevice, unregisterDevice, registrationsForSerial, removeRegistrationByToken, updatedSerialsForDevice,
  InsufficientPointsError, NotFoundError, DbError,
};

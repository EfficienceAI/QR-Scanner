'use strict';

/**
 * Pass recovery.
 *
 * An email or a mobile number that is already on a card never hands the
 * card's link straight back: anyone who knew a friend's number could
 * collect their card and their points. Instead a six-digit code goes to
 * the email on the card, through Resend, and the link is handed out only
 * against that code. A code lives ten minutes and allows five tries; a new
 * one is sent at most once a minute; a successful recovery rotates the
 * card's link so any older link stops working.
 *
 * Configuration: RESEND_API_KEY and RESEND_FROM (e.g. "La Bottega Milanese
 * <loyalty@example.com>", a sender on a domain verified in Resend).
 */

const crypto = require('crypto');
const { db: defaultDb } = require('./db');
const members = require('./members');

const CODE_TTL_MS = 10 * 60 * 1000;
const RESEND_EVERY_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_URL = 'https://api.resend.com/emails';

function settings(env = process.env) {
  const apiKey = String(env.RESEND_API_KEY || '').trim();
  const from = String(env.RESEND_FROM || '').trim();
  return { apiKey, from, brand: env.RECOVERY_BRAND || 'La Bottega Milanese', enabled: Boolean(apiKey && from) };
}
function newCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
function hashCode(memberId, code) {
  return crypto.createHash('sha256').update(`${memberId}:${code}`).digest('hex');
}
/** "y•••@gmail.com": enough to recognise, not enough to learn. */
function maskEmail(email) {
  const [user, domain] = String(email || '').split('@');
  return domain ? `${user.slice(0, 1)}•••@${domain}` : null;
}

async function sendCode(member, code, { env = process.env, fetchImpl = (...a) => fetch(...a) } = {}) {
  const s = settings(env);
  const text = `Your ${s.brand} code is ${code}. It works for 10 minutes. If you did not ask for it, you can ignore this email.`;
  const html = `<p style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:16px">Your ${s.brand} code is</p>` +
    `<p style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>` +
    `<p style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:14px;color:#555">It works for 10 minutes. If you did not ask for it, you can ignore this email.</p>`;
  const resp = await fetchImpl(RESEND_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: s.from, to: [member.email], subject: `${code} is your ${s.brand} code`, text, html }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    const err = new Error(`Resend ${resp.status}: ${body.slice(0, 200)}`);
    err.status = resp.status;
    throw err;
  }
  return true;
}

/** Issue a code to the email on the card, at most once a minute. */
async function startRecovery(member, { db = defaultDb, env = process.env, fetchImpl, now = Date.now } = {}) {
  if (!member || !member.email) return { sent: false, reason: 'no_email', hint: null };
  const t = now();
  const last = Date.parse(member.recovery_sent_at || '');
  if (Number.isFinite(last) && t - last < RESEND_EVERY_MS) return { sent: false, reason: 'throttled', hint: maskEmail(member.email) };
  const code = newCode();
  await db.update('members', `id=eq.${encodeURIComponent(member.id)}`, {
    recovery_code_hash: hashCode(member.id, code),
    recovery_expires_at: new Date(t + CODE_TTL_MS).toISOString(),
    recovery_attempts: 0,
    recovery_sent_at: new Date(t).toISOString(),
  });
  await sendCode(member, code, { env, fetchImpl });
  return { sent: true, hint: maskEmail(member.email) };
}

/**
 * Check a code. On success the card's link is rotated, the code is cleared
 * and the fresh row comes back; on any failure, null.
 */
async function verifyCode(member, code, { db = defaultDb, now = Date.now } = {}) {
  const c = String(code || '').replace(/\D/g, '');
  if (!member || c.length !== 6 || !member.recovery_code_hash) return null;
  const t = now();
  if (!(Date.parse(member.recovery_expires_at || '') > t)) return null;
  if ((member.recovery_attempts || 0) >= MAX_ATTEMPTS) return null;
  if (!members.timingSafeEqual(hashCode(member.id, c), member.recovery_code_hash)) {
    await db.update('members', `id=eq.${encodeURIComponent(member.id)}`, { recovery_attempts: (member.recovery_attempts || 0) + 1 });
    return null;
  }
  const rows = await db.update('members', `id=eq.${encodeURIComponent(member.id)}`, {
    download_token: members.newToken(24),
    recovery_code_hash: null,
    recovery_expires_at: null,
    recovery_attempts: 0,
    updated_at: new Date(t).toISOString(),
  });
  return Array.isArray(rows) ? rows[0] || null : rows;
}

module.exports = { settings, startRecovery, verifyCode, sendCode, maskEmail, _internals: { newCode, hashCode, CODE_TTL_MS, RESEND_EVERY_MS, MAX_ATTEMPTS } };

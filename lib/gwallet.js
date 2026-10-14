'use strict';

/**
 * Google Wallet, the Android side of the loyalty card.
 *
 * Google keeps the card design (a "loyalty class") and one "loyalty object"
 * per member on its own servers; we create and update them through the
 * Wallet Objects API as the issuer's service account, and a customer adds
 * the card by opening a signed "save" link. There are no certificates to
 * renew and no device registrations: when we update an object, Google
 * updates every phone that holds it.
 *
 * Configuration: GOOGLE_WALLET_ISSUER_ID (from the Pay & Wallet Console) and
 * GOOGLE_WALLET_SA_JSON_B64 (the service account's JSON key, base64). Without
 * both, everything here is a no-op and the join page shows no Android button.
 */

const crypto = require('crypto');
const passLib = require('./pass');
const members = require('./members');
const { db: defaultDb } = require('./db');

const API = 'https://walletobjects.googleapis.com/walletobjects/v1';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/wallet_object.issuer';
const SAVE_URL = 'https://pay.google.com/gp/v/save/';

class GWalletError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'GWalletError';
    this.status = status;
    this.body = body;
  }
}

function settings(env = process.env) {
  const issuerId = String(env.GOOGLE_WALLET_ISSUER_ID || '').trim();
  let sa = null;
  if (env.GOOGLE_WALLET_SA_JSON_B64) {
    try { sa = JSON.parse(Buffer.from(String(env.GOOGLE_WALLET_SA_JSON_B64), 'base64').toString('utf8')); } catch { sa = null; }
  }
  const ps = passLib.settings(env);
  return {
    issuerId,
    clientEmail: (sa && sa.client_email) || '',
    privateKey: (sa && sa.private_key) || '',
    classSuffix: String(env.GOOGLE_WALLET_CLASS_ID || 'lbm-loyalty'),
    baseUrl: String(env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    issuerName: env.GOOGLE_WALLET_ISSUER_NAME || 'La Bottega Milanese',
    programName: env.GOOGLE_WALLET_PROGRAM_NAME || 'Loyalty Card',
    website: env.GOOGLE_WALLET_WEBSITE || 'https://www.labottegamilanese.co.uk',
    redeemCost: ps.redeemCost,
    theme: ps.theme,
    enabled: Boolean(issuerId && sa && sa.client_email && sa.private_key),
  };
}

function b64url(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
}
function signJwt(claims, s) {
  const unsigned = `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(claims)}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(unsigned), s.privateKey).toString('base64url');
  return `${unsigned}.${sig}`;
}

let tokenCache = { email: null, token: null, exp: 0 };
const classReady = new Set();
function resetCaches() {
  tokenCache = { email: null, token: null, exp: 0 };
  classReady.clear();
}

/** An OAuth access token for the service account, cached until shortly before it expires. */
async function accessToken(s, { fetchImpl = (...a) => fetch(...a), now = Date.now } = {}) {
  const t = Math.floor(now() / 1000);
  if (tokenCache.token && tokenCache.email === s.clientEmail && tokenCache.exp - 60 > t) return tokenCache.token;
  const assertion = signJwt({ iss: s.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: t, exp: t + 3600 }, s);
  const resp = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) throw new GWalletError(resp.status, data.error_description || data.error || 'Google token exchange failed', data);
  tokenCache = { email: s.clientEmail, token: data.access_token, exp: t + (Number(data.expires_in) || 3600) };
  return data.access_token;
}

async function api(method, path, body, s, opts = {}) {
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const token = await accessToken(s, opts);
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  if (body !== undefined && body !== null) headers['Content-Type'] = 'application/json';
  const resp = await fetchImpl(`${API}${path}`, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 300) }; }
  if (!resp.ok) throw new GWalletError(resp.status, (data && data.error && data.error.message) || `Google Wallet ${resp.status}`, data);
  return data;
}

function classId(s) { return `${s.issuerId}.${s.classSuffix}`; }
function objectId(member, s) { return `${s.issuerId}.${member.id}`; }
function text(value) { return { defaultValue: { language: 'en-GB', value } }; }

function rewardText(points, cost) {
  if (points >= cost) return 'Free drink ready. Show this card at the counter.';
  const left = cost - points;
  return `${left} more stamp${left === 1 ? '' : 's'} to a free drink.`;
}

/** The card design. reviewStatus UNDER_REVIEW is what a new class must carry in demo mode. */
function buildClass(s) {
  return {
    id: classId(s),
    issuerName: s.issuerName,
    programName: s.programName,
    reviewStatus: 'UNDER_REVIEW',
    countryCode: 'GB',
    hexBackgroundColor: '#000000',
    programLogo: { sourceUri: { uri: `${s.baseUrl}/join/wallet-logo.png` }, contentDescription: text(`${s.issuerName} logo`) },
    localizedIssuerName: text(s.issuerName),
    localizedProgramName: text(s.programName),
    linksModuleData: { uris: [{ uri: s.website, description: s.issuerName, id: 'website' }] },
  };
}

/** One member's card: balance, free drinks, the stamp photo for their balance, and the same QR as the Apple pass. */
function buildObject(member, s) {
  const points = Math.max(0, Number(member.points) || 0);
  const filled = passLib.filledStamps(points, s.redeemCost);
  return {
    id: objectId(member, s),
    classId: classId(s),
    state: 'ACTIVE',
    // Not pass_serial: for an imported member that is their old PassKit id,
    // and accountId is user-visible on some Google surfaces.
    accountId: members.printableSerial(member) || objectId(member, s),
    accountName: member.full_name || 'Member',
    loyaltyPoints: { label: 'Points', balance: { int: points } },
    secondaryLoyaltyPoints: { label: 'Free drinks', balance: { int: Math.floor(points / s.redeemCost) } },
    barcode: { type: 'QR_CODE', value: members.qrMessage(member), alternateText: members.printableSerial(member) || undefined },
    imageModulesData: [{
      id: 'stamps',
      mainImage: { sourceUri: { uri: `${s.baseUrl}/join/stamps/${s.theme}/strip-${filled}.png` }, contentDescription: text(`${filled} of ${s.redeemCost} stamps`) },
    }],
    textModulesData: [{ id: 'reward', header: 'Your next free drink', body: rewardText(points, s.redeemCost) }],
  };
}

/** The "Add to Google Wallet" link: a JWT signed by the service account naming the member's object. */
function saveUrl(member, s, { now = Date.now } = {}) {
  const claims = {
    iss: s.clientEmail,
    aud: 'google',
    typ: 'savetowallet',
    iat: Math.floor(now() / 1000),
    origins: s.baseUrl ? [s.baseUrl] : [],
    payload: { loyaltyObjects: [{ id: objectId(member, s) }] },
  };
  return SAVE_URL + signJwt(claims, s);
}

/** Make sure the class exists (once per function instance). An existing class is left as it is: see syncClass. */
async function ensureClass(s, opts = {}) {
  const id = classId(s);
  if (classReady.has(id)) return false;
  try {
    await api('GET', `/loyaltyClass/${encodeURIComponent(id)}`, null, s, opts);
  } catch (err) {
    if (err.status !== 404) throw err;
    await api('POST', '/loyaltyClass', buildClass(s), s, opts);
  }
  classReady.add(id);
  return true;
}

/** Push the current design to Google, keeping an approved class approved. */
async function syncClass(s, opts = {}) {
  const id = classId(s);
  const body = buildClass(s);
  try {
    const existing = await api('GET', `/loyaltyClass/${encodeURIComponent(id)}`, null, s, opts);
    if (existing && String(existing.reviewStatus).toUpperCase() === 'APPROVED') body.reviewStatus = 'APPROVED';
    return await api('PUT', `/loyaltyClass/${encodeURIComponent(id)}`, body, s, opts);
  } catch (err) {
    if (err.status !== 404) throw err;
    return api('POST', '/loyaltyClass', body, s, opts);
  }
}

/** Create the member's object, or bring an existing one fully up to date. */
async function upsertObject(member, s, opts = {}) {
  const id = objectId(member, s);
  const body = buildObject(member, s);
  try {
    await api('GET', `/loyaltyObject/${encodeURIComponent(id)}`, null, s, opts);
    return await api('PUT', `/loyaltyObject/${encodeURIComponent(id)}`, body, s, opts);
  } catch (err) {
    if (err.status !== 404) throw err;
    return api('POST', '/loyaltyObject', body, s, opts);
  }
}

/** The parts of an object that change with the balance. */
async function updateObject(member, s, opts = {}) {
  const full = buildObject(member, s);
  const patch = {
    loyaltyPoints: full.loyaltyPoints,
    secondaryLoyaltyPoints: full.secondaryLoyaltyPoints,
    imageModulesData: full.imageModulesData,
    textModulesData: full.textModulesData,
  };
  return api('PATCH', `/loyaltyObject/${encodeURIComponent(objectId(member, s))}`, patch, s, opts);
}

/**
 * After a balance change: update the member's Google card, if they have one.
 * Never throws; Google being down must not touch a scan.
 */
async function syncAfterChange(member, { log = () => {}, env = process.env, db = defaultDb, fetchImpl } = {}) {
  const s = settings(env);
  if (!s.enabled || !member || !member.gwallet_object_id) return false;
  try {
    await updateObject(member, s, { fetchImpl });
    await db.update('members', `id=eq.${encodeURIComponent(member.id)}`, { gwallet_updated_at: new Date().toISOString() });
    log({ gwallet: 'updated', points: Number(member.points) || 0 });
    return true;
  } catch (err) {
    log({ warn: 'gwallet_update_failed', status: err.status, message: err.message });
    return false;
  }
}

module.exports = {
  settings, buildClass, buildObject, saveUrl, ensureClass, syncClass, upsertObject, updateObject, syncAfterChange,
  classId, objectId, GWalletError,
  _internals: { signJwt, accessToken, api, rewardText, resetCaches },
};

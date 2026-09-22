'use strict';

/**
 * Minimal PassKit Membership REST client.
 *
 * Auth: HS256 JWT signed with the REST API key + secret from
 * app.passkit.com > Developer Tools > REST Credentials, sent as the
 * Authorization header (this mirrors PassKit's own sample code).
 *
 * Docs: https://docs.passkit.io/protocols/member/
 */

const crypto = require('crypto');

class PassKitError extends Error {
  constructor(status, message, body, path) {
    super(message);
    this.name = 'PassKitError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const TOKEN_TTL_SECONDS = 3600;
const TOKEN_REFRESH_MARGIN_SECONDS = 300;
let cachedToken = null; // { token, exp } - reused across warm invocations

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function baseUrl() {
  return env('PASSKIT_API_BASE', 'https://api.pub1.passkit.io').replace(/\/+$/, '');
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function getToken() {
  const key = env('PASSKIT_API_KEY');
  const secret = env('PASSKIT_API_SECRET');
  if (!key || !secret) {
    throw new ConfigError('PASSKIT_API_KEY and PASSKIT_API_SECRET must be set.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - now > TOKEN_REFRESH_MARGIN_SECONDS) {
    return cachedToken.token;
  }
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ uid: key, iat: now, exp: now + TOKEN_TTL_SECONDS }));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  cachedToken = { token: `${header}.${payload}.${signature}`, exp: now + TOKEN_TTL_SECONDS };
  return cachedToken.token;
}

function authHeader() {
  // PassKit's sample sends the bare JWT. Set PASSKIT_AUTH_SCHEME=Bearer if
  // your account expects "Bearer <token>" instead.
  const scheme = env('PASSKIT_AUTH_SCHEME', '').trim();
  const token = getToken();
  return scheme ? `${scheme} ${token}` : token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(method, path, body, attempt = 0) {
  const headers = { Authorization: authHeader(), Accept: 'application/json' };
  const init = { method, headers };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let resp;
  try {
    resp = await fetch(baseUrl() + path, init);
  } catch (err) {
    if (attempt < 2) {
      await sleep(250 * (attempt + 1));
      return request(method, path, body, attempt + 1);
    }
    throw new PassKitError(0, `PassKit unreachable: ${err.message}`, null, path);
  }

  // PassKit docs: on 503 back off 250ms and retry.
  if (resp.status === 503 && attempt < 3) {
    await sleep(250);
    return request(method, path, body, attempt + 1);
  }

  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!resp.ok) {
    const message = (data && (data.message || data.error)) || `PassKit responded ${resp.status}`;
    throw new PassKitError(resp.status, message, data, path);
  }
  return data;
}

/**
 * A member reference is either { id } (PassKit member id, what the pass
 * barcode encodes by default) or { externalId, programId }.
 */
function normalizeRef(ref) {
  if (ref && typeof ref.id === 'string' && ref.id) return { id: ref.id };
  if (ref && typeof ref.externalId === 'string' && ref.externalId) {
    const programId = ref.programId || env('PASSKIT_PROGRAM_ID');
    if (!programId) {
      throw new ConfigError('PASSKIT_PROGRAM_ID is required when looking members up by external ID.');
    }
    return { externalId: ref.externalId, programId };
  }
  throw new ConfigError('Member reference must contain an id or externalId.');
}

async function getMember(ref) {
  const r = normalizeRef(ref);
  if (r.id) {
    return request('GET', `/members/member/id/${encodeURIComponent(r.id)}`);
  }
  return request(
    'GET',
    `/members/member/externalId/${encodeURIComponent(r.programId)}/${encodeURIComponent(r.externalId)}`
  );
}

async function earnPoints(ref, points, eventDetails) {
  const body = { ...normalizeRef(ref), points };
  if (eventDetails) body.eventDetails = eventDetails;
  return request('PUT', '/members/member/points/earn', body);
}

async function burnPoints(ref, points, eventDetails) {
  const body = { ...normalizeRef(ref), points };
  if (eventDetails) body.eventDetails = eventDetails;
  return request('PUT', '/members/member/points/burn', body);
}

module.exports = {
  getMember,
  earnPoints,
  burnPoints,
  PassKitError,
  ConfigError,
  _internals: { getToken, normalizeRef, baseUrl },
};

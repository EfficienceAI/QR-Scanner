'use strict';

/** Shared bits of Apple's pass web service (the /api/wallet/v1/* routes). */

const members = require('./members');
const passLib = require('./pass');

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Cache-Control', 'no-store');
  if (payload === undefined) return res.end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.end(JSON.stringify(payload));
}

function query(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  try {
    return Object.fromEntries(new URL(req.url, 'http://x').searchParams.entries());
  } catch {
    return {};
  }
}

function readBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body);
  } catch {
    return {};
  }
}

function applePassToken(req) {
  const h = String((req.headers && req.headers.authorization) || '');
  const m = /^ApplePass\s+(\S+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/** Resolves the member when the pass type id matches and the ApplePass token is right; otherwise null. */
async function authorize(req, passTypeId, serial, deps = {}) {
  const s = deps.settings || passLib.settings();
  if (!passTypeId || passTypeId !== s.passTypeId) return null;
  const token = applePassToken(req);
  if (!token) return null;
  const member = await (deps.getBySerial || members.getBySerial)(serial, deps);
  if (!member || !members.timingSafeEqual(token, member.pass_auth_token)) return null;
  return member;
}

function log(event, fields) {
  console.log(JSON.stringify({ src: 'wallet-service', event, ...(fields || {}) }));
}

module.exports = { send, query, readBody, applePassToken, authorize, log };

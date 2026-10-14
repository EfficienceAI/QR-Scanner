const { test } = require('node:test');
const assert = require('node:assert/strict');
const registration = require('../api/wallet/v1/devices/[deviceId]/registrations/[passTypeId]/[serial].js').createHandler;
const updated = require('../api/wallet/v1/devices/[deviceId]/registrations/[passTypeId].js').createHandler;
const latest = require('../api/wallet/v1/passes/[passTypeId]/[serial].js').createHandler;
const passLib = require('../lib/pass');

const settings = passLib.settings({ APPLE_TEAM_ID: 'T', PASS_TYPE_ID: 'pass.com.example.loyalty', PUBLIC_BASE_URL: 'https://x' });
const member = { id: 'u1', pass_serial: 'LBM-1', pass_auth_token: 'secret-token-1234567', pass_updated_at: '2026-10-05T10:00:00.000Z', points: 3, full_name: 'A' };
const getBySerial = async (s) => (s === 'LBM-1' ? member : null);
function res() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } }; }
const req = (method, query, headers = {}, body) => ({ method, query, headers, body, url: '/x' });

test('registration requires the pass type and the ApplePass token', async () => {
  const regs = [];
  const h = registration({ settings, getBySerial, registerDevice: async (r) => { regs.push(r); return { created: regs.length === 1 }; }, unregisterDevice: async () => {} });
  let r = res(); await h(req('POST', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty', serial: 'LBM-1' }, { authorization: 'ApplePass wrong' }, { pushToken: 'p' }), r);
  assert.equal(r.statusCode, 401);
  r = res(); await h(req('POST', { deviceId: 'd1', passTypeId: 'pass.com.other', serial: 'LBM-1' }, { authorization: 'ApplePass secret-token-1234567' }, { pushToken: 'p' }), r);
  assert.equal(r.statusCode, 401);
  r = res(); await h(req('POST', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty', serial: 'LBM-1' }, { authorization: 'ApplePass secret-token-1234567' }, { pushToken: 'p' }), r);
  assert.equal(r.statusCode, 201); assert.deepEqual(regs[0], { deviceId: 'd1', serial: 'LBM-1', pushToken: 'p' });
  r = res(); await h(req('POST', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty', serial: 'LBM-1' }, { authorization: 'ApplePass secret-token-1234567' }, { pushToken: 'p' }), r);
  assert.equal(r.statusCode, 200, 'already registered');
  r = res(); await h(req('DELETE', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty', serial: 'LBM-1' }, { authorization: 'ApplePass secret-token-1234567' }), r);
  assert.equal(r.statusCode, 200);
});

test('updated serials: 204 when nothing changed, else the list and the latest tag', async () => {
  const h = updated({ settings, updatedSerialsForDevice: async (d, since) => (since ? [] : [{ serial: 'LBM-1', updated_at: '2026-10-05T10:00:00+00:00' }, { serial: 'LBM-2', updated_at: '2026-10-05T11:00:00+00:00' }]) });
  let r = res(); await h(req('GET', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty' }), r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { lastUpdated: '2026-10-05T11:00:00.000Z', serialNumbers: ['LBM-1', 'LBM-2'] });
  r = res(); await h(req('GET', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty', passesUpdatedSince: '2026-10-05T11:00:00.000Z' }), r);
  assert.equal(r.statusCode, 204);
  r = res(); await h(req('GET', { deviceId: 'd1', passTypeId: 'pass.com.other' }), r);
  assert.equal(r.statusCode, 404);
});

test('latest pass: 401 without the token, 304 when unchanged, pkpass otherwise', async () => {
  const h = latest({ settings, getBySerial, buildPkpass: async () => Buffer.from('PK-fake') });
  let r = res(); await h(req('GET', { passTypeId: 'pass.com.example.loyalty', serial: 'LBM-1' }), r);
  assert.equal(r.statusCode, 401);
  r = res(); await h(req('GET', { passTypeId: 'pass.com.example.loyalty', serial: 'LBM-1' }, { authorization: 'ApplePass secret-token-1234567', 'if-modified-since': 'Mon, 05 Oct 2026 10:00:00 GMT' }), r);
  assert.equal(r.statusCode, 304);
  r = res(); await h(req('GET', { passTypeId: 'pass.com.example.loyalty', serial: 'LBM-1' }, { authorization: 'ApplePass secret-token-1234567', 'if-modified-since': 'Mon, 05 Oct 2026 09:00:00 GMT' }), r);
  assert.equal(r.statusCode, 200); assert.equal(r.headers['Content-Type'], 'application/vnd.apple.pkpass'); assert.equal(r.headers['Last-Modified'], 'Mon, 05 Oct 2026 10:00:00 GMT');
});

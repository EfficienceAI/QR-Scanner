const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../api/gwallet/[serial]');
const passHandler = require('../api/pass/[serial]');

function res() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } }; }
const member = { id: 'b24101aa-16a1-4d8d-a42f-5610b6cf787a', full_name: 'Yunus', pass_serial: 'LBM-HAXM9Z7KW4', download_token: 'tok', points: 5, gwallet_object_id: null };
function world({ enabled = true } = {}) {
  const calls = [];
  const db = {
    enabled: () => true,
    selectOne: async (table, q) => (q.includes('pass_serial=eq.LBM-HAXM9Z7KW4') ? { ...member } : null),
    update: async (table, q, patch) => { calls.push(['db.update', q, patch]); return [{ ...member, ...patch }]; },
  };
  const gwallet = {
    settings: () => ({ enabled, issuerId: '338' }),
    ensureClass: async () => { calls.push(['ensureClass']); return true; },
    upsertObject: async (m) => { calls.push(['upsertObject', m.id]); return {}; },
    objectId: (m) => '338.' + m.id,
    saveUrl: (m) => 'https://pay.google.com/gp/v/save/jwt-for-' + m.id,
  };
  return { calls, handler: createHandler({ db, gwallet, env: {} }), db, gwallet };
}

test('a valid link creates the card, remembers it, and redirects to Google', async () => {
  const w = world();
  const r = res();
  await w.handler({ method: 'GET', query: { serial: 'LBM-HAXM9Z7KW4', t: 'tok' }, headers: {} }, r);
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.Location, 'https://pay.google.com/gp/v/save/jwt-for-' + member.id);
  assert.deepEqual(w.calls.map((c) => c[0]), ['ensureClass', 'upsertObject', 'db.update']);
  assert.equal(w.calls[2][2].gwallet_object_id, '338.' + member.id);
});

test('wrong token, unknown serial, not configured', async () => {
  const w = world();
  let r = res(); await w.handler({ method: 'GET', query: { serial: 'LBM-HAXM9Z7KW4', t: 'nope' }, headers: {} }, r); assert.equal(r.statusCode, 404);
  r = res(); await w.handler({ method: 'GET', query: { serial: 'LBM-OTHER', t: 'tok' }, headers: {} }, r); assert.equal(r.statusCode, 404);
  assert.equal(w.calls.length, 0, 'nothing touched Google');
  const off = world({ enabled: false });
  r = res(); await off.handler({ method: 'GET', query: { serial: 'LBM-HAXM9Z7KW4', t: 'tok' }, headers: {} }, r); assert.equal(r.statusCode, 503);
  r = res(); await w.handler({ method: 'POST', query: {}, headers: {} }, r); assert.equal(r.statusCode, 405);
});

test('the Apple pass link sends an Android phone to the Google link, and only when Google Wallet is on', async () => {
  const deps = { getBySerial: async () => ({ ...member }), gwallet: { settings: () => ({ enabled: true }) }, buildPkpass: async () => Buffer.from('pk') };
  const h = passHandler.createHandler(deps);
  let r = res();
  await h({ method: 'GET', query: { serial: 'LBM-HAXM9Z7KW4', t: 'tok' }, headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile' } }, r);
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.Location, '/api/gwallet/LBM-HAXM9Z7KW4?t=tok');
  const off = passHandler.createHandler({ ...deps, gwallet: { settings: () => ({ enabled: false }) } });
  r = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.raw = b; } };
  await off({ method: 'GET', query: { serial: 'LBM-HAXM9Z7KW4', t: 'tok' }, headers: { 'user-agent': 'Android' } }, r);
  assert.equal(r.statusCode, 200, 'without Google Wallet the pass is served as before');
  r = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.raw = b; } };
  await h({ method: 'GET', query: { serial: 'LBM-HAXM9Z7KW4', t: 'tok' }, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } }, r);
  assert.equal(r.statusCode, 200, 'an iPhone still gets the .pkpass');
});

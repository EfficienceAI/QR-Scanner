const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const gw = require('../lib/gwallet');

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = {
  GOOGLE_WALLET_ISSUER_ID: '3388000000000000001',
  GOOGLE_WALLET_SA_JSON_B64: Buffer.from(JSON.stringify({ client_email: 'robot@x.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) })).toString('base64'),
  PUBLIC_BASE_URL: 'https://lbm-loyalty.vercel.app/',
  PASS_THEME: 'default',
};
const member = { id: 'b24101aa-16a1-4d8d-a42f-5610b6cf787a', full_name: 'Yunus Tufail', pass_serial: 'LBM-HAXM9Z7KW4', points: 5 };
const CLASS = '3388000000000000001.lbm-loyalty';
const OBJECT = '3388000000000000001.' + member.id;

test('settings: off without the issuer id and key, on with both', () => {
  assert.equal(gw.settings({}).enabled, false);
  assert.equal(gw.settings({ GOOGLE_WALLET_ISSUER_ID: '1', GOOGLE_WALLET_SA_JSON_B64: 'not-json' }).enabled, false);
  const s = gw.settings(env);
  assert.equal(s.enabled, true);
  assert.equal(s.baseUrl, 'https://lbm-loyalty.vercel.app');
  assert.equal(s.clientEmail, 'robot@x.iam.gserviceaccount.com');
});

test('the class is the card design, the object is one member', () => {
  const s = gw.settings(env);
  const c = gw.buildClass(s);
  assert.equal(c.id, CLASS);
  assert.equal(c.reviewStatus, 'UNDER_REVIEW');
  assert.equal(c.issuerName, 'La Bottega Milanese');
  assert.equal(c.programLogo.sourceUri.uri, 'https://lbm-loyalty.vercel.app/join/wallet-logo.png');
  const o = gw.buildObject(member, s);
  assert.equal(o.id, OBJECT);
  assert.equal(o.classId, CLASS);
  assert.equal(o.state, 'ACTIVE');
  assert.equal(o.accountName, 'Yunus Tufail');
  assert.equal(o.accountId, 'LBM-HAXM9Z7KW4');
  assert.deepEqual(o.barcode, { type: 'QR_CODE', value: 'LBM:' + member.id, alternateText: 'LBM-HAXM9Z7KW4' });
  assert.equal(o.loyaltyPoints.balance.int, 5);
  assert.equal(o.secondaryLoyaltyPoints.balance.int, 0);
  assert.equal(o.imageModulesData[0].mainImage.sourceUri.uri, 'https://lbm-loyalty.vercel.app/join/stamps/default/strip-5.png');
  assert.match(o.textModulesData[0].body, /4 more stamps/);
  const full = gw.buildObject({ ...member, points: 27 }, s);
  assert.equal(full.secondaryLoyaltyPoints.balance.int, 3);
  assert.match(full.imageModulesData[0].mainImage.sourceUri.uri, /strip-9\.png$/, 'stamps cap at nine');
  assert.match(full.textModulesData[0].body, /Free drink ready/);
  assert.match(gw.buildObject({ ...member, points: 0 }, s).imageModulesData[0].mainImage.sourceUri.uri, /strip-0\.png$/);
});

test('the save link is a JWT signed by the service account naming the member\'s object', () => {
  const s = gw.settings(env);
  const url = gw.saveUrl(member, s, { now: () => 1791900000000 });
  assert.ok(url.startsWith('https://pay.google.com/gp/v/save/'));
  const [h, p, sig] = url.slice('https://pay.google.com/gp/v/save/'.length).split('.');
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url')), 'signature verifies with the public key');
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(claims.iss, 'robot@x.iam.gserviceaccount.com');
  assert.equal(claims.aud, 'google');
  assert.equal(claims.typ, 'savetowallet');
  assert.equal(claims.iat, 1791900000);
  assert.deepEqual(claims.origins, ['https://lbm-loyalty.vercel.app']);
  assert.deepEqual(claims.payload, { loyaltyObjects: [{ id: OBJECT }] });
});

function fakeGoogle({ classExists = false, objectExists = false, fail = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const method = init.method || 'GET';
    calls.push(method + ' ' + u.replace('https://walletobjects.googleapis.com/walletobjects/v1', '').replace('https://oauth2.googleapis.com/token', 'TOKEN'));
    if (u.includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_in: 3600 }) };
    if (fail) return { ok: false, status: fail, text: async () => JSON.stringify({ error: { message: 'denied' } }) };
    const isGet = method === 'GET';
    if (isGet && u.includes('/loyaltyClass/')) return classExists ? { ok: true, status: 200, text: async () => JSON.stringify({ id: CLASS, reviewStatus: 'approved' }) } : { ok: false, status: 404, text: async () => '{"error":{"message":"not found"}}' };
    if (isGet && u.includes('/loyaltyObject/')) return objectExists ? { ok: true, status: 200, text: async () => JSON.stringify({ id: OBJECT }) } : { ok: false, status: 404, text: async () => '{"error":{"message":"not found"}}' };
    return { ok: true, status: 200, text: async () => JSON.stringify(init.body ? JSON.parse(init.body) : {}) };
  };
  return { calls, fetchImpl };
}

test('one token exchange, class created on 404 and then remembered, object created or replaced', async () => {
  gw._internals.resetCaches();
  const s = gw.settings(env);
  const g = fakeGoogle();
  assert.equal(await gw.ensureClass(s, { fetchImpl: g.fetchImpl }), true);
  assert.equal(await gw.ensureClass(s, { fetchImpl: g.fetchImpl }), false, 'second call does nothing');
  await gw.upsertObject(member, s, { fetchImpl: g.fetchImpl });
  assert.deepEqual(g.calls, ['POST TOKEN', `GET /loyaltyClass/${encodeURIComponent(CLASS)}`, 'POST /loyaltyClass', `GET /loyaltyObject/${encodeURIComponent(OBJECT)}`, 'POST /loyaltyObject']);
  const g2 = fakeGoogle({ objectExists: true });
  await gw.upsertObject(member, s, { fetchImpl: g2.fetchImpl });
  assert.deepEqual(g2.calls, [`GET /loyaltyObject/${encodeURIComponent(OBJECT)}`, `PUT /loyaltyObject/${encodeURIComponent(OBJECT)}`], 'token reused, existing object replaced');
});

test('syncClass keeps an approved class approved', async () => {
  gw._internals.resetCaches();
  const s = gw.settings(env);
  const sent = [];
  const g = fakeGoogle({ classExists: true });
  const fetchImpl = async (url, init = {}) => { if ((init.method || 'GET') === 'PUT') sent.push(JSON.parse(init.body)); return g.fetchImpl(url, init); };
  await gw.syncClass(s, { fetchImpl });
  assert.equal(sent[0].reviewStatus, 'APPROVED');
});

test('syncAfterChange patches the card for a member who has one, and never throws', async () => {
  gw._internals.resetCaches();
  const patches = [];
  const updates = [];
  const g = fakeGoogle();
  const fetchImpl = async (url, init = {}) => { if ((init.method || 'GET') === 'PATCH') patches.push([String(url), JSON.parse(init.body)]); return g.fetchImpl(url, init); };
  const db = { update: async (table, q, patch) => { updates.push([q, patch]); return [{}]; } };
  assert.equal(await gw.syncAfterChange({ ...member, points: 7 }, { env, db, fetchImpl }), false, 'no object id yet: nothing to update');
  assert.equal(await gw.syncAfterChange({ ...member, points: 7, gwallet_object_id: OBJECT }, { env, db, fetchImpl }), true);
  assert.equal(patches.length, 1);
  assert.equal(patches[0][1].loyaltyPoints.balance.int, 7);
  assert.match(patches[0][1].imageModulesData[0].mainImage.sourceUri.uri, /strip-7\.png$/);
  assert.ok(updates[0][1].gwallet_updated_at);
  assert.equal(await gw.syncAfterChange({ ...member, gwallet_object_id: OBJECT }, { env: {}, db, fetchImpl }), false, 'not configured: no-op');
  const bad = fakeGoogle({ fail: 403 });
  const log = [];
  assert.equal(await gw.syncAfterChange({ ...member, gwallet_object_id: OBJECT }, { env, db, fetchImpl: bad.fetchImpl, log: (x) => log.push(x) }), false);
  assert.ok(log.some((x) => x.warn === 'gwallet_update_failed' && x.status === 403));
});

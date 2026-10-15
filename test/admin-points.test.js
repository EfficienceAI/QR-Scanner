const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../api/admin/points');
const members = require('../lib/members');

function res() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } }; }
const member = { id: 'u1', pass_serial: 'LBM-1', full_name: 'A B', points: 3 };
const base = { env: { ADMIN_SECRET: 's3cret' }, getBySerial: async (s) => (s === 'LBM-1' ? member : null), findByEmail: async (e) => (e === 'a@b.co' ? member : null), pushPassUpdate: async (serial) => ({ serial, sent: 1, failed: 0, removed: 0, skipped: false }) };

test('admin points: gate, validation, adjust and push', async () => {
  const h = createHandler({ ...base, adjustPoints: async (id, d) => { if (d < -3) throw new members.InsufficientPointsError(); return 3 + d; } });
  let r = res(); await h({ method: 'POST', headers: {}, body: { serial: 'LBM-1', delta: 1 } }, r); assert.equal(r.statusCode, 401);
  r = res(); await h({ method: 'POST', headers: { 'x-admin-secret': 's3cret' }, body: { serial: 'LBM-1', delta: 0 } }, r); assert.equal(r.statusCode, 400);
  r = res(); await h({ method: 'POST', headers: { 'x-admin-secret': 's3cret' }, body: { serial: 'LBM-1', delta: 2 } }, r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.member.points, 5); assert.equal(r.body.push.sent, 1);
  r = res(); await h({ method: 'POST', headers: { 'x-admin-secret': 's3cret' }, body: { email: 'a@b.co', delta: -9 } }, r); assert.equal(r.statusCode, 409);
  r = res(); await h({ method: 'POST', headers: { 'x-admin-secret': 's3cret' }, body: { serial: 'nope', delta: 1 } }, r); assert.equal(r.statusCode, 404);
  const off = createHandler({ ...base, env: {} }); r = res(); await off({ method: 'POST', headers: {}, body: {} }, r); assert.equal(r.statusCode, 503);
});

test('the admin endpoints are behind the shared gate, so guesses are throttled', async () => {
  // M1. All four new admin endpoints carried a private copy of the gate. The
  // copy compared correctly, so this was never an auth bypass -- but it had no
  // throttle, which left unlimited guessing against endpoints that move any
  // member's balance and return their pass link. ADMIN_SECRET is a hand-set
  // env var with no enforced entropy, so the brake is the protection.
  const auth = require('../lib/auth');
  auth._internals.failures.clear();
  const h = createHandler({ ...base, adjustPoints: async (id, d) => 3 + d });
  const headers = { 'x-forwarded-for': '9.9.9.9', 'x-admin-secret': 'wrong' };
  const call = async () => { const r = res(); await h({ method: 'POST', headers, body: { serial: 'LBM-1', delta: 1 } }, r); return r; };

  for (let i = 0; i < 10; i += 1) {
    const r = await call();
    assert.equal(r.statusCode, 401, `guess ${i + 1} is refused`);
  }
  const brake = await call();
  assert.equal(brake.statusCode, 429, 'the eleventh guess hits the brake, not another 401');
  assert.equal(brake.body.error, 'too_many_attempts');

  // And the brake does not lock out the real secret holder on another address.
  const ok = res();
  await h({ method: 'POST', headers: { 'x-forwarded-for': '1.2.3.4', 'x-admin-secret': 's3cret' }, body: { serial: 'LBM-1', delta: 1 } }, ok);
  assert.equal(ok.statusCode, 200);
  auth._internals.failures.clear();
});

test('the gate no longer leaks the secret length through a fast path', async () => {
  // The private copies compared raw buffer lengths first, so a wrong-length
  // guess returned before any comparison. lib/auth.js hashes both sides to 32
  // bytes precisely to close that oracle; it is reachable from here now.
  const auth = require('../lib/auth');
  assert.equal(auth._internals.secretsMatch('s3cret', 's3cret'), true);
  assert.equal(auth._internals.secretsMatch('s', 's3cret'), false, 'a short guess is compared, not short-circuited');
  assert.equal(auth._internals.secretsMatch('s3cret-and-then-some', 's3cret'), false);
  assert.equal(auth._internals.secretsMatch('', 's3cret'), false);
  assert.equal(auth._internals.secretsMatch('', ''), true, 'which is why requireAdmin refuses an unset secret before comparing');
});

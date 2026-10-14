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

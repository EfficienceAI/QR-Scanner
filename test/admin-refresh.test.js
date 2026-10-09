const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../api/admin/refresh');
const members = require('../lib/members');

function res() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } }; }

test('refresh one pass or every registered pass, gated by the admin secret', async () => {
  const touched = [];
  const h = createHandler({
    env: { ADMIN_SECRET: 's3cret' },
    touchPass: async (serial) => { touched.push(serial); return serial === 'LBM-MISSING' ? null : { pass_serial: serial }; },
    registeredSerials: async ({ limit, offset }) => (offset === 0 ? Array.from({ length: 200 }, (_, i) => 'LBM-' + i) : ['LBM-200']),
    pushPassUpdate: async (serial) => ({ serial, sent: 1, failed: 0, removed: 0, skipped: false }),
  });
  let r = res(); await h({ method: 'POST', headers: {}, body: { serial: 'LBM-1' } }, r); assert.equal(r.statusCode, 401);
  r = res(); await h({ method: 'POST', headers: { 'x-admin-secret': 's3cret' }, body: {} }, r); assert.equal(r.statusCode, 400);
  r = res(); await h({ method: 'POST', headers: { 'x-admin-secret': 's3cret' }, body: { serial: 'LBM-1' } }, r);
  assert.equal(r.statusCode, 200); assert.deepEqual(r.body.results, [{ serial: 'LBM-1', found: true, sent: 1, failed: 0, removed: 0, skipped: false }]);
  r = res(); await h({ method: 'POST', headers: { 'x-admin-secret': 's3cret' }, body: { serial: 'LBM-MISSING' } }, r);
  assert.deepEqual(r.body.results, [{ serial: 'LBM-MISSING', found: false }]);
  r = res(); await h({ method: 'POST', headers: { 'x-admin-secret': 's3cret' }, body: { all: true } }, r);
  assert.equal(r.body.refreshed, 200); assert.equal(r.body.nextOffset, 200);
  r = res(); await h({ method: 'POST', headers: { 'x-admin-secret': 's3cret' }, body: { all: true, offset: 200 } }, r);
  assert.equal(r.body.refreshed, 1); assert.equal(r.body.nextOffset, null);
});

test('touchPass and registeredSerials talk to the right tables', async () => {
  const calls = [];
  const db = {
    update: async (table, q, patch) => { calls.push(['update', table, q, Object.keys(patch)]); return [{ pass_serial: 'LBM-1' }]; },
    select: async (table, q) => { calls.push(['select', table, q]); return [{ pass_serial: 'LBM-1' }, { pass_serial: 'LBM-1' }, { pass_serial: 'LBM-2' }]; },
  };
  assert.deepEqual(await members.touchPass('LBM-1', { db }), { pass_serial: 'LBM-1' });
  assert.deepEqual(calls[0], ['update', 'members', 'pass_serial=eq.LBM-1', ['pass_updated_at']]);
  assert.deepEqual(await members.registeredSerials({ limit: 50, offset: 0 }, { db }), ['LBM-1', 'LBM-2']);
  assert.match(calls[1][2], /limit=50&offset=0/);
});

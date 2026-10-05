const { test } = require('node:test');
const assert = require('node:assert/strict');
const apns = require('../lib/apns');
const passLib = require('../lib/pass');

test('pushPassUpdate pushes to every registered device and drops dead tokens', async () => {
  const settings = passLib.settings({ PASS_TYPE_ID: 'pass.com.example.loyalty', PASS_CERT_PEM_B64: Buffer.from('-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----').toString('base64'), PASS_KEY_PEM_B64: Buffer.from('-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----').toString('base64') });
  const removed = [];
  const db = {
    select: async () => [{ device_library_id: 'd1', push_token: 'good' }, { device_library_id: 'd2', push_token: 'dead' }, { device_library_id: 'd3', push_token: 'flaky' }],
    remove: async (table, q) => { removed.push(q); },
  };
  const sent = [];
  const sendImpl = async (token, opts) => { sent.push({ token, topic: opts.topic }); return token === 'good' ? { status: 200 } : token === 'dead' ? { status: 410, reason: 'Unregistered' } : { status: 500, reason: 'InternalServerError' }; };
  const warns = [];
  const s = await apns.pushPassUpdate('LBM-1', { settings, db, sendImpl, log: (w) => warns.push(w) });
  assert.deepEqual(s, { serial: 'LBM-1', sent: 1, failed: 1, removed: 1, skipped: false });
  assert.equal(sent[0].topic, 'pass.com.example.loyalty');
  assert.equal(removed.length, 1); assert.match(removed[0], /push_token=eq\.dead/);
  assert.equal(warns[0].warn, 'apns_push_failed');
});

test('pushPassUpdate skips cleanly when signing is not configured', async () => {
  const s = await apns.pushPassUpdate('LBM-1', { settings: passLib.settings({}), db: { select: async () => [] } });
  assert.equal(s.skipped, true);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { after } = require('../lib/after');

test('after registers the work with the platform and never rejects', async () => {
  const registered = [];
  const p = after(Promise.reject(new Error('ledger down')), { waitUntil: (x) => registered.push(x) });
  assert.equal(registered.length, 1);
  assert.equal(await p, undefined, 'a failure is logged, not thrown');
  const ok = after(Promise.resolve(42), { waitUntil: (x) => registered.push(x) });
  assert.equal(await ok, 42);
  assert.equal(await after(7, { waitUntil: null }), 7, 'works without a platform too');
  assert.equal(await after(Promise.resolve(1), { waitUntil: () => { throw new Error('no request context'); } }), 1);
});

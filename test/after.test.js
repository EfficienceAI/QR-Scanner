const { test } = require('node:test');
const assert = require('node:assert/strict');
const { after, _internals } = require('../lib/after');

test('after registers the work with the platform and never rejects', async () => {
  const registered = [];
  const waitUntil = (x) => registered.push(x);

  const p = after(Promise.reject(new Error('ledger down')), { waitUntil, log: () => {} });
  assert.equal(registered.length, 1, 'a failing job is still registered');
  assert.equal(await p, undefined, 'a failure is logged, not thrown');

  const ok = after(Promise.resolve(42), { waitUntil });
  assert.equal(registered.length, 2, 'the success path registers too');
  assert.equal(await ok, 42, 'and resolves to the work\'s value');

  assert.equal(await after(7, { waitUntil: null }), 7, 'works without a platform too');
  assert.equal(registered.length, 2, 'and registers nothing when there is no waitUntil');
});

test('a failure is reported through the caller\'s logger, with its request context', async () => {
  const lines = [];
  await after(Promise.reject(new Error('ledger down')), { waitUntil: null, log: (f) => lines.push(f) });
  assert.deepEqual(lines, [{ warn: 'after_failed', message: 'ledger down' }]);
});

test('a thunk is started rather than silently dropped', async () => {
  let ran = false;
  const value = await after(() => { ran = true; return Promise.resolve('done'); }, { waitUntil: null });
  assert.equal(ran, true, 'the function is invoked, not resolved as a value');
  assert.equal(value, 'done');
});

test('a waitUntil that throws is reported, not swallowed into a lost write', async () => {
  // waitUntil returns undefined rather than throwing when there is no request
  // context, so this only happens if the platform changes under us. The work
  // must still settle.
  assert.equal(await after(Promise.resolve(1), { waitUntil: () => { throw new Error('no request context'); } }), 1);
});

test('the request-context fallback is what registers the work when the package is absent', async () => {
  // lib/after.js prefers @vercel/functions but falls back to the platform's
  // request-context symbol, which is all that package does. The fallback is
  // why a deployment missing the package still records its scans.
  const sym = _internals.REQUEST_CONTEXT;
  const before = globalThis[sym];
  const registered = [];
  globalThis[sym] = { get: () => ({ waitUntil: (p) => registered.push(p) }) };
  try {
    await _internals.contextWaitUntil(Promise.resolve('x'));
    assert.equal(registered.length, 1, 'the promise reaches the request context');
  } finally {
    if (before === undefined) delete globalThis[sym];
    else globalThis[sym] = before;
  }

  // No context at all: a no-op, not a throw.
  assert.equal(_internals.contextWaitUntil(Promise.resolve('x')), undefined);
});

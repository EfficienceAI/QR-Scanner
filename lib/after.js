'use strict';

/**
 * Work that must finish after the reply has gone out: the scan ledger row
 * (respondThenRecord in api/loyalty.js) and, on the native path, the Wallet
 * push, the PassKit mirror and the Google Wallet patch (settle in
 * lib/native-scan.js).
 *
 * On Vercel a function can be frozen the moment its response is sent, so work
 * still in flight at that point may never finish: the write is lost and the
 * scan is undercounted, or the balance moves and the push that tells the phone
 * is cut off -- the 13-points pass. The platform's waitUntil keeps the
 * invocation alive until the registered work settles.
 *
 * Elsewhere -- `node --test` and the dev server -- there is no request context,
 * waitUntil is a no-op, and the caller awaits the returned promise instead.
 * That is why respondThenRecord and settle return it: scripts/dev-server.mjs
 * awaits the handler, and the tests await the work to know it landed.
 *
 * The returned promise never rejects.
 */

const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

/**
 * Hand the promise to the request context directly.
 *
 * This is the whole of what @vercel/functions' waitUntil does. Keeping it as a
 * fallback means a deployment where the package did not make it into the
 * function bundle degrades to working code rather than to silently dropped
 * writes -- which was the failure this module exists to prevent.
 */
function contextWaitUntil(p) {
  const ctx = globalThis[REQUEST_CONTEXT];
  const waitUntil = ctx && typeof ctx.get === 'function' ? (ctx.get() || {}).waitUntil : null;
  return typeof waitUntil === 'function' ? waitUntil(p) : undefined;
}

let platformWaitUntil = contextWaitUntil;
try {
  const fns = require('@vercel/functions');
  if (typeof fns.waitUntil === 'function') platformWaitUntil = fns.waitUntil;
} catch {
  // Tests and the dev server run with no install step, by design. A deployment
  // never should: the fallback above still registers the work, but a missing
  // package means the bundle is not what we think it is, so say so once rather
  // than let it pass unnoticed.
  if (process.env.VERCEL) {
    console.error(JSON.stringify({
      src: 'after',
      warn: 'vercel_functions_missing',
      message: '@vercel/functions is not in the bundle; falling back to the request-context symbol',
    }));
  }
}

/**
 * Register `work` so the platform keeps the invocation alive until it settles.
 *
 * Pass a promise (or a thunk returning one -- it is invoked immediately, since
 * Promise.resolve would otherwise resolve to the function itself and the work
 * would vanish without a trace). `log` is the caller's structured logger, so a
 * failure is reported with the request's own context.
 */
function after(work, { waitUntil = platformWaitUntil, log = null } = {}) {
  const started = typeof work === 'function' ? work() : work;
  const p = Promise.resolve(started).catch((err) => {
    const message = (err && err.message) || String(err);
    if (log) log({ warn: 'after_failed', message });
    else console.error(JSON.stringify({ src: 'after', warn: 'after_failed', message }));
  });
  if (typeof waitUntil === 'function') {
    try {
      waitUntil(p);
    } catch (err) {
      // waitUntil returns undefined rather than throwing when there is no
      // request context, so this catches only a future platform change. Report
      // it: swallowing it here would hide the loss of every after-reply write.
      console.error(JSON.stringify({
        src: 'after',
        warn: 'wait_until_failed',
        message: (err && err.message) || String(err),
      }));
    }
  }
  return p;
}

module.exports = { after, _internals: { contextWaitUntil, REQUEST_CONTEXT } };

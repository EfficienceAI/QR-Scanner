'use strict';

/**
 * Work that must finish after the reply has gone out: the ledger row, the
 * Wallet push, the PassKit mirror.
 *
 * On Vercel a function can be frozen the moment its response is sent, so
 * anything still running at that point may never finish (the 13-points pass:
 * the balance moved, but the push that tells the phone was cut off). The
 * platform's waitUntil keeps the invocation alive until the registered work
 * settles. Elsewhere (dev server, tests) there is no waitUntil and the caller
 * simply awaits the returned promise. The promise never rejects.
 */

let platformWaitUntil = null;
try {
  ({ waitUntil: platformWaitUntil } = require('@vercel/functions'));
} catch {
  platformWaitUntil = null;
}

function after(work, { waitUntil = platformWaitUntil } = {}) {
  const p = Promise.resolve(work).catch((err) => {
    console.error(JSON.stringify({ src: 'after', error: (err && err.message) || String(err) }));
  });
  if (typeof waitUntil === 'function') {
    try { waitUntil(p); } catch { /* outside a request context */ }
  }
  return p;
}

module.exports = { after };

'use strict';

/**
 * Apple pass web service: POST /v1/log { logs: [...] }. Wallet reports
 * problems here and we just record them.
 *
 * Unauthenticated, which is correct: Apple's specification defines this
 * endpoint that way, and a device whose pass is broken may have no working
 * credential to authenticate with. But that makes it a public, unthrottled
 * write into the function logs, where log volume is billable and where it
 * shared `src: 'wallet-service'` with our own diagnostics -- so device noise,
 * or someone posting a megabyte of it, was indistinguishable from the real
 * thing. Hence: its own `src`, a cap on each entry as well as the count, and
 * a note of what was dropped rather than a silent truncation.
 */

const { send, readBody } = require('../../../lib/wallet');

const MAX_ENTRIES = 20;
const MAX_ENTRY_CHARS = 500;

function entries(logs) {
  if (!Array.isArray(logs)) return { kept: [], received: 0, dropped: 0, truncated: 0 };
  const kept = [];
  let truncated = 0;
  for (const entry of logs.slice(0, MAX_ENTRIES)) {
    const text = typeof entry === 'string' ? entry : JSON.stringify(entry) || String(entry);
    if (text.length > MAX_ENTRY_CHARS) {
      truncated += 1;
      kept.push(text.slice(0, MAX_ENTRY_CHARS) + '…');
    } else {
      kept.push(text);
    }
  }
  return { kept, received: logs.length, dropped: Math.max(0, logs.length - MAX_ENTRIES), truncated };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405); }
  const { kept, received, dropped, truncated } = entries(readBody(req).logs);
  // src: 'wallet-device' so this can be filtered out without losing the
  // service's own diagnostics, which stay on 'wallet-service'.
  console.log(JSON.stringify({ src: 'wallet-device', event: 'device_log', received, dropped, truncated, logs: kept }));
  return send(res, 200);
};

module.exports._internals = { entries, MAX_ENTRIES, MAX_ENTRY_CHARS };

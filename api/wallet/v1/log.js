'use strict';

/** Apple pass web service: POST /v1/log { logs: [...] }. Wallet reports problems here; we just record them. */

const { send, readBody, log } = require('../../../lib/wallet');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405); }
  const logs = readBody(req).logs;
  log('device_log', { logs: Array.isArray(logs) ? logs.slice(0, 20) : logs });
  return send(res, 200);
};

'use strict';

/**
 * Tells Wallet that a pass changed. Apple's rule: send an empty push to every
 * device registered for the pass, with the pass type id as the topic, over
 * HTTP/2 using the Pass Type ID certificate as the client certificate. Wallet
 * then calls our web service to fetch the new version.
 *
 * Never throws: a push failure must not break a scan.
 */

const http2 = require('http2');
const members = require('./members');
const passLib = require('./pass');

const APNS_HOST = 'https://api.push.apple.com';

function sendOnce(pushToken, { host = APNS_HOST, topic, certs, pushType = '', connectImpl = http2.connect, timeoutMs = 8000 }) {
  return new Promise((resolve) => {
    let client;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try {
        if (client) client.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    try {
      client = connectImpl(host, { cert: certs.signerCert, key: certs.signerKey, passphrase: certs.signerKeyPassphrase });
    } catch (err) {
      return finish({ status: 0, error: err.message });
    }
    const timer = setTimeout(() => finish({ status: 0, error: 'timeout' }), timeoutMs);
    client.on('error', (err) => { clearTimeout(timer); finish({ status: 0, error: err.message }); });
    const headers = { ':method': 'POST', ':path': `/3/device/${pushToken}`, 'apns-topic': topic, 'apns-priority': '10', 'content-type': 'application/json' };
    if (pushType) headers['apns-push-type'] = pushType;
    const req = client.request(headers);
    let status = 0;
    let body = '';
    req.on('response', (h) => { status = Number(h[':status']) || 0; });
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => { clearTimeout(timer); let reason = ''; try { reason = JSON.parse(body).reason || ''; } catch { /* empty */ } finish({ status, reason }); });
    req.on('error', (err) => { clearTimeout(timer); finish({ status: 0, error: err.message }); });
    req.end('{}');
  });
}

/** Notify every device holding this pass. Resolves to a summary; never rejects. */
async function pushPassUpdate(serial, opts = {}) {
  const s = opts.settings || passLib.settings();
  const log = opts.log || (() => {});
  const summary = { serial, sent: 0, failed: 0, removed: 0, skipped: false };
  if (!s.certs.signerCert || !s.certs.signerKey || !s.passTypeId || process.env.APNS_ENABLED === 'false') {
    summary.skipped = true;
    return summary;
  }
  let regs = [];
  try {
    regs = await members.registrationsForSerial(serial, opts);
  } catch (err) {
    log({ warn: 'apns_registrations_failed', serial, message: err.message });
    summary.skipped = true;
    return summary;
  }
  for (const r of regs) {
    const res = await (opts.sendImpl || sendOnce)(r.push_token, { topic: s.passTypeId, certs: s.certs, pushType: process.env.APNS_PUSH_TYPE || '', connectImpl: opts.connectImpl, host: opts.host });
    if (res.status === 200) {
      summary.sent += 1;
    } else if (res.status === 410 || res.reason === 'BadDeviceToken' || res.reason === 'Unregistered') {
      summary.removed += 1;
      try {
        await members.removeRegistrationByToken(r.push_token, opts);
      } catch {
        /* best effort */
      }
    } else {
      summary.failed += 1;
      log({ warn: 'apns_push_failed', serial, status: res.status, reason: res.reason || res.error });
    }
  }
  return summary;
}

module.exports = { pushPassUpdate, _internals: { sendOnce } };

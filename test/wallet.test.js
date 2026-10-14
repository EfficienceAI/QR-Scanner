const { test } = require('node:test');
const assert = require('node:assert/strict');
const registration = require('../api/wallet/v1/devices/[deviceId]/registrations/[passTypeId]/[serial].js').createHandler;
const updated = require('../api/wallet/v1/devices/[deviceId]/registrations/[passTypeId].js').createHandler;
const latest = require('../api/wallet/v1/passes/[passTypeId]/[serial].js').createHandler;
const passLib = require('../lib/pass');

const settings = passLib.settings({ APPLE_TEAM_ID: 'T', PASS_TYPE_ID: 'pass.com.example.loyalty', PUBLIC_BASE_URL: 'https://x' });
const member = { id: 'u1', pass_serial: 'LBM-1', pass_auth_token: 'secret-token-1234567', pass_updated_at: '2026-10-05T10:00:00.000Z', points: 3, full_name: 'A' };
const getBySerial = async (s) => (s === 'LBM-1' ? member : null);
function res() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } }; }
const req = (method, query, headers = {}, body) => ({ method, query, headers, body, url: '/x' });

test('registration requires the pass type and the ApplePass token', async () => {
  const regs = [];
  const h = registration({ settings, getBySerial, registerDevice: async (r) => { regs.push(r); return { created: regs.length === 1 }; }, unregisterDevice: async () => {} });
  let r = res(); await h(req('POST', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty', serial: 'LBM-1' }, { authorization: 'ApplePass wrong' }, { pushToken: 'p' }), r);
  assert.equal(r.statusCode, 401);
  r = res(); await h(req('POST', { deviceId: 'd1', passTypeId: 'pass.com.other', serial: 'LBM-1' }, { authorization: 'ApplePass secret-token-1234567' }, { pushToken: 'p' }), r);
  assert.equal(r.statusCode, 401);
  r = res(); await h(req('POST', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty', serial: 'LBM-1' }, { authorization: 'ApplePass secret-token-1234567' }, { pushToken: 'p' }), r);
  assert.equal(r.statusCode, 201); assert.deepEqual(regs[0], { deviceId: 'd1', serial: 'LBM-1', pushToken: 'p' });
  r = res(); await h(req('POST', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty', serial: 'LBM-1' }, { authorization: 'ApplePass secret-token-1234567' }, { pushToken: 'p' }), r);
  assert.equal(r.statusCode, 200, 'already registered');
  r = res(); await h(req('DELETE', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty', serial: 'LBM-1' }, { authorization: 'ApplePass secret-token-1234567' }), r);
  assert.equal(r.statusCode, 200);
});

test('updated serials: 204 when nothing changed, else the list and the latest tag', async () => {
  const h = updated({ settings, updatedSerialsForDevice: async (d, since) => (since ? [] : [{ serial: 'LBM-1', updated_at: '2026-10-05T10:00:00+00:00' }, { serial: 'LBM-2', updated_at: '2026-10-05T11:00:00+00:00' }]) });
  let r = res(); await h(req('GET', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty' }), r);
  assert.equal(r.statusCode, 200);
  // The tag is whatever the database holds, passed through untouched.
  assert.deepEqual(JSON.parse(r.body), { lastUpdated: '2026-10-05T11:00:00+00:00', serialNumbers: ['LBM-1', 'LBM-2'] });
  r = res(); await h(req('GET', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty', passesUpdatedSince: '2026-10-05T11:00:00.000Z' }), r);
  assert.equal(r.statusCode, 204);
  r = res(); await h(req('GET', { deviceId: 'd1', passTypeId: 'pass.com.other' }), r);
  assert.equal(r.statusCode, 404);
});

test('the what-changed tag survives the round trip at microsecond precision', async () => {
  // M5. Postgres timestamptz keeps microseconds and the RPC compares
  // `pass_updated_at > p_since`; a JS Date holds only milliseconds. Returning
  // `new Date(lastUpdated).toISOString()` truncated .933456 to .933, Wallet
  // echoed the truncated tag back, and .933456 > .933000 is always true -- so
  // the 204 could never be reached for any pass, since now() yields
  // microseconds. Every device re-fetched every pass on every poll, forever.
  const STORED = '2026-10-05T11:00:00.933456+00:00';
  const asked = [];
  // Stands in for the RPC's `m.pass_updated_at > p_since`, at full precision.
  const h = updated({
    settings,
    updatedSerialsForDevice: async (d, since) => {
      asked.push(since);
      const newer = since === null || String(since) < STORED;
      return newer ? [{ serial: 'LBM-1', updated_at: STORED }] : [];
    },
  });

  let r = res();
  await h(req('GET', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty' }), r);
  assert.equal(r.statusCode, 200);
  const tag = JSON.parse(r.body).lastUpdated;
  assert.equal(tag, STORED, 'the tag keeps every digit the database gave us');

  // Wallet sends that tag straight back on its next poll.
  r = res();
  await h(req('GET', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty', passesUpdatedSince: tag }), r);
  assert.equal(r.statusCode, 204, 'nothing changed, so the device is told so and stops re-fetching');
  assert.equal(asked[1], STORED, 'and the tag reached the query unreparsed');

  // A genuinely older tag still reports the change.
  r = res();
  await h(req('GET', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty', passesUpdatedSince: '2026-10-05T10:00:00+00:00' }), r);
  assert.equal(r.statusCode, 200);

  // Junk is ignored rather than passed to the database.
  for (const junk of ['not-a-date', '2026-13-45T99:99:99Z', "'; drop table members; --", '', 'x'.repeat(100)]) {
    r = res();
    await h(req('GET', { deviceId: 'd1', passTypeId: 'pass.com.example.loyalty', passesUpdatedSince: junk }), r);
    assert.equal(r.statusCode, 200, `${junk.slice(0, 20)} is treated as "send me everything"`);
    assert.equal(asked[asked.length - 1], null, 'and never reaches the query');
  }
});

test('latest pass: 401 without the token, 304 when unchanged, pkpass otherwise', async () => {
  const h = latest({ settings, getBySerial, buildPkpass: async () => Buffer.from('PK-fake') });
  let r = res(); await h(req('GET', { passTypeId: 'pass.com.example.loyalty', serial: 'LBM-1' }), r);
  assert.equal(r.statusCode, 401);
  r = res(); await h(req('GET', { passTypeId: 'pass.com.example.loyalty', serial: 'LBM-1' }, { authorization: 'ApplePass secret-token-1234567', 'if-modified-since': 'Mon, 05 Oct 2026 10:00:00 GMT' }), r);
  assert.equal(r.statusCode, 304);
  r = res(); await h(req('GET', { passTypeId: 'pass.com.example.loyalty', serial: 'LBM-1' }, { authorization: 'ApplePass secret-token-1234567', 'if-modified-since': 'Mon, 05 Oct 2026 09:00:00 GMT' }), r);
  assert.equal(r.statusCode, 200); assert.equal(r.headers['Content-Type'], 'application/vnd.apple.pkpass'); assert.equal(r.headers['Last-Modified'], 'Mon, 05 Oct 2026 10:00:00 GMT');
});

test('the device log endpoint caps what one unauthenticated caller can write', async () => {
  // L5. Unauthenticated is correct -- Apple's spec defines /v1/log that way,
  // and a device with a broken pass may have no credential to use -- but it
  // is a public, unthrottled write into logs that are billable by volume,
  // and it shared src: 'wallet-service' with our own diagnostics, so device
  // noise was indistinguishable from the real thing.
  const logRoute = require('../api/wallet/v1/log');
  const { entries, MAX_ENTRIES, MAX_ENTRY_CHARS } = logRoute._internals;

  // Count is capped, and what was dropped is stated rather than silently lost.
  const many = entries(Array.from({ length: 500 }, (_, i) => 'line ' + i));
  assert.equal(many.kept.length, MAX_ENTRIES);
  assert.equal(many.received, 500);
  assert.equal(many.dropped, 500 - MAX_ENTRIES);

  // Size is capped too: 20 entries of a megabyte each was the hole left by
  // capping the count alone.
  const huge = entries(['x'.repeat(100000)]);
  assert.equal(huge.kept[0].length, MAX_ENTRY_CHARS + 1, 'truncated, with an ellipsis');
  assert.equal(huge.truncated, 1);

  // An object entry is serialised rather than dropped, and still capped.
  const obj = entries([{ message: 'y'.repeat(100000) }]);
  assert.ok(obj.kept[0].length <= MAX_ENTRY_CHARS + 1);

  // Junk shapes do not throw.
  for (const junk of [undefined, null, 'not an array', 42, {}]) {
    assert.deepEqual(entries(junk).kept, [], JSON.stringify(junk) + ' is not a log array');
  }

  // The route answers 200 and writes under its own src, so device noise can
  // be filtered without losing the service's diagnostics.
  const lines = [];
  const realLog = console.log;
  console.log = (line) => lines.push(JSON.parse(line));
  try {
    const r = res();
    await logRoute({ method: 'POST', body: { logs: ['pass could not be updated'] }, headers: {} }, r);
    assert.equal(r.statusCode, 200);
  } finally {
    console.log = realLog;
  }
  assert.equal(lines.length, 1);
  assert.equal(lines[0].src, 'wallet-device', 'not wallet-service, which is ours');
  assert.deepEqual(lines[0].logs, ['pass could not be updated']);

  const r2 = res();
  await logRoute({ method: 'GET', headers: {} }, r2);
  assert.equal(r2.statusCode, 405);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../api/u/[pid]');

const PK = '16dm9KIQ7haLWTVgchJPHI';
const member = { id: '85c54ace-a2ed-428e-8edf-caa8168f2569', full_name: 'Yunus Tufail', points: 5, status: 'active', pass_serial: PK, passkit_member_id: PK, download_token: 'tok' };
function res() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.raw = b; } }; }
function world({ found = true, status = 'active', google = true } = {}) {
  const db = { enabled: () => true, selectOne: async (table, q) => (found && (q.includes(`passkit_member_id=eq.${PK}`) || q.includes(`pass_serial=eq.${PK}`)) ? { ...member, status } : null) };
  return createHandler({ db, env: {}, gwallet: { settings: () => ({ enabled: google }) }, buildPkpass: async (m) => Buffer.from('pkpass-for-' + m.id), adopt: async () => null });
}

test('an iPhone tapping its pass id gets the new pass straight away', async () => {
  const r = res();
  await world()({ method: 'GET', query: { pid: PK }, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)' } }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers['Content-Type'], 'application/vnd.apple.pkpass');
  assert.equal(String(r.raw), 'pkpass-for-' + member.id);
});

test('an Android phone is sent to its Google Wallet card', async () => {
  const r = res();
  await world()({ method: 'GET', query: { pid: PK }, headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile' } }, r);
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.Location, `/api/gwallet/${PK}?t=tok`);
});

test('unknown, malformed, inactive or Google-off cases fall back to the upgrade page', async () => {
  for (const [h, req] of [
    [world({ found: false }), { method: 'GET', query: { pid: PK }, headers: {} }],
    [world(), { method: 'GET', query: { pid: 'x' }, headers: {} }],
    [world({ status: 'disabled' }), { method: 'GET', query: { pid: PK }, headers: {} }],
    [world({ google: false }), { method: 'GET', query: { pid: PK }, headers: { 'user-agent': 'Android' } }],
  ]) {
    const r = res(); await h(req, r);
    assert.equal(r.statusCode, 302); assert.equal(r.headers.Location, '/upgrade');
  }
});

test('a pass id we have not imported is adopted from PassKit on the spot', async () => {
  const fresh = { ...member, id: 'adopted-1', pass_serial: '7NEWmemberIdFromPassKit0', passkit_member_id: '7NEWmemberIdFromPassKit0' };
  const db = { enabled: () => true, selectOne: async () => null };
  const h = createHandler({ db, env: {}, gwallet: { settings: () => ({ enabled: true }) }, buildPkpass: async (m) => Buffer.from('pkpass-for-' + m.id), adopt: async (pid) => (pid === fresh.pass_serial ? fresh : null) });
  const r = res();
  await h({ method: 'GET', query: { pid: fresh.pass_serial }, headers: { 'user-agent': 'iPhone' } }, r);
  assert.equal(r.statusCode, 200); assert.equal(String(r.raw), 'pkpass-for-adopted-1');
});

test('a native card is not downloadable by the serial printed on it', async () => {
  // members.printableSerial puts the LBM- serial on the card as the QR alt
  // text, so it is readable off the front of a phone, and this route asks for
  // no download token. Answering for one handed over the signed pass with the
  // pass_auth_token inside it and the LBM: QR that is the balance at the till.
  //
  // The db here answers every query, including the passkit_member_id one, so
  // the test also proves the id is refused before any lookup happens.
  const native = { ...member, id: 'native-1', pass_serial: 'LBM-ABCDEFGHJK', passkit_member_id: null };
  const db = { enabled: () => true, selectOne: async () => native };
  let built = false;
  const h = createHandler({
    db, env: {}, gwallet: { settings: () => ({ enabled: true }) },
    buildPkpass: async () => { built = true; return Buffer.from('pass'); },
    adopt: async () => null,
  });
  for (const pid of ['LBM-ABCDEFGHJK', 'lbm-abcdefghjk']) {
    const r = res();
    await h({ method: 'GET', query: { pid }, headers: { 'user-agent': 'iPhone' } }, r);
    assert.equal(r.statusCode, 302, pid);
    assert.equal(r.headers.Location, '/upgrade');
  }
  assert.equal(built, false, 'no pass was signed, so none could be served');
});

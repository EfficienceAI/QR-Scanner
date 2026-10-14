const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, _internals } = require('../api/join');

function res() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } }; }
function fakeDb() {
  const rows = [];
  return {
    rows,
    enabled: () => true,
    selectOne: async (table, q) => { const m = /email_norm=eq\.(.+?)(&|$)/.exec(q); const e = m && decodeURIComponent(m[1]); return rows.find((r) => r.email === e) || null; },
    insert: async (table, row) => { const r = { id: 'uuid-' + (rows.length + 1), points: 0, ...row }; rows.push(r); return r; },
  };
}

test('join creates a member and answers with the pass link; a repeat discloses nothing', async () => {
  _internals.hits.clear();
  const db = fakeDb();
  const h = createHandler({ db });
  const headers = { 'x-forwarded-for': '1.1.1.1' };
  let r = res(); await h({ method: 'POST', headers, body: { full_name: 'Yunus Tufail', email: 'Yunus@Example.com', phone: '07700 900123', consent: true } }, r);
  assert.equal(r.statusCode, 201); assert.equal(r.body.ok, true); assert.equal(r.body.existing, false);
  assert.match(r.body.passUrl, /^\/api\/pass\/LBM-[A-Z2-9]{10}\?t=/);
  assert.equal(db.rows[0].email, 'yunus@example.com'); assert.equal(db.rows[0].phone, '+447700900123'); assert.equal(db.rows[0].consent_marketing, true);
  r = res(); await h({ method: 'POST', headers, body: { full_name: 'Yunus Tufail', email: 'yunus@example.com', phone: '07700900123' } }, r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.existing, true);
  assert.equal(db.rows.length, 1, 'and still no duplicate row');
});

test('a known email hands over nothing: no pass link, no id, no name, no balance', async () => {
  // C1. The attacker needs only the victim's email address -- the name and
  // phone are never compared against the stored row, because they cannot be:
  // validateJoin only uses them when creating. So the reply to a known email
  // must carry no member.id (which *is* the QR payload), no download token,
  // and no PII. Putting any of them back must fail here.
  _internals.hits.clear();
  const db = fakeDb();
  const h = createHandler({ db });
  const headers = { 'x-forwarded-for': '4.4.4.4' };

  let r = res();
  await h({ method: 'POST', headers, body: { full_name: 'Yunus Tufail', email: 'yunus@example.com', phone: '07700900123', consent: true } }, r);
  assert.equal(r.statusCode, 201);
  const victim = { id: r.body.member.id, passUrl: r.body.passUrl, name: r.body.member.name };
  assert.ok(victim.id && victim.passUrl, 'the real signup does get its own pass');

  // Now the attacker, with a made-up name and phone and the victim's email.
  r = res();
  await h({ method: 'POST', headers, body: { full_name: 'A B', email: 'yunus@example.com', phone: '07700900000' } }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.existing, true);
  assert.equal(r.body.member, undefined, 'no member object');
  assert.equal(r.body.passUrl, undefined, 'no pass download link');
  assert.equal(r.body.googleUrl, undefined, 'no Google Wallet link');
  assert.ok(r.body.message, 'the customer is told what to do instead');

  // Nothing identifying anywhere in the serialised body, however shaped.
  const wire = JSON.stringify(r.body);
  assert.ok(!wire.includes(victim.id), 'the member uuid is the QR payload and must not appear');
  assert.ok(!wire.includes(db.rows[0].download_token), 'the download token must not appear');
  assert.ok(!wire.includes(db.rows[0].pass_serial), 'the pass serial must not appear');
  assert.ok(!wire.includes(victim.name), 'the real name must not appear');
});

test('the duplicate-key fallback discloses nothing either', async () => {
  // Two signups racing on the same address land in the catch block, which
  // looked the member up again and returned it in full.
  _internals.hits.clear();
  const db = fakeDb();
  db.insert = async () => { const e = new Error('duplicate key value violates unique constraint'); e.status = 409; throw e; };
  db.rows.push({ id: 'uuid-victim', email: 'yunus@example.com', full_name: 'Yunus Tufail', points: 8, pass_serial: 'LBM-ABCDEFGHIJ', download_token: 'tok-secret' });
  const h = createHandler({ db });
  const r = res();
  await h({ method: 'POST', headers: { 'x-forwarded-for': '5.5.5.5' }, body: { full_name: 'A B', email: 'yunus@example.com', phone: '07700900000' } }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.existing, true);
  const wire = JSON.stringify(r.body);
  assert.ok(!wire.includes('tok-secret') && !wire.includes('uuid-victim') && !wire.includes('LBM-ABCDEFGHIJ'), 'nothing of the member leaks');
  assert.equal(r.body.member, undefined);
});

test('join validates and rate-limits', async () => {
  _internals.hits.clear();
  const h = createHandler({ db: fakeDb() });
  let r = res(); await h({ method: 'POST', headers: { 'x-forwarded-for': '2.2.2.2' }, body: { full_name: 'x', email: 'bad', phone: '1' } }, r);
  assert.equal(r.statusCode, 400); assert.deepEqual(Object.keys(r.body.errors).sort(), ['email', 'full_name', 'phone']);
  r = res(); await h({ method: 'GET', headers: {} }, r);
  assert.equal(r.statusCode, 405);
  for (let i = 0; i < 20; i += 1) assert.equal(_internals.limited('3.3.3.3'), false);
  assert.equal(_internals.limited('3.3.3.3'), true);
});

test('join reports an unconfigured database honestly', async () => {
  const h = createHandler({ db: { enabled: () => false } });
  const r = res(); await h({ method: 'POST', headers: {}, body: {} }, r);
  assert.equal(r.statusCode, 503); assert.equal(r.body.error, 'not_configured');
});

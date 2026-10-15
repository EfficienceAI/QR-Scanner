const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, _internals } = require('../api/join');

function res() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } }; }
function fakeDb() {
  const rows = [];
  return {
    rows,
    enabled: () => true,
    selectOne: async (table, q) => {
      let m;
      if ((m = /email_norm=eq\.(.+?)(&|$)/.exec(q))) { const e = decodeURIComponent(m[1]); return rows.find((r) => r.email === e) || null; }
      if ((m = /phone=eq\.(.+?)(&|$)/.exec(q))) { const ph = decodeURIComponent(m[1]); return rows.find((r) => r.phone === ph) || null; }
      return null;
    },
    insert: async (table, row) => { const r = { id: 'uuid-' + (rows.length + 1), points: 0, ...row }; rows.push(r); return r; },
  };
}

test('join creates a member and answers with the pass link; a repeat gets no link', async () => {
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
  assert.equal(r.body.passUrl, undefined, 'a repeat never gets the link straight back');
  assert.equal(r.body.recovery, false, 'no Resend configured here: staff help instead');
  assert.equal(db.rows.length, 1, 'and still no duplicate row');
});

test('a known email or number hands over nothing: no pass link, no id, no name, no balance', async () => {
  // C1. The caller needs only the victim's email address or mobile number --
  // the name is never compared against the stored row, because it cannot be:
  // validateJoin only uses it when creating. So the reply must carry no
  // member.id (which *is* the QR payload), no download token, and no PII.
  // Putting any of them back must fail here.
  for (const attack of [
    { what: 'the email', body: { full_name: 'A B', email: 'yunus@example.com', phone: '07700900999' } },
    { what: 'the mobile number', body: { full_name: 'A B', email: 'someone.else@example.com', phone: '07700 900123' } },
  ]) {
    _internals.hits.clear();
    const db = fakeDb();
    const h = createHandler({ db });
    const headers = { 'x-forwarded-for': '4.4.4.4' };

    let r = res();
    await h({ method: 'POST', headers, body: { full_name: 'Yunus Tufail', email: 'yunus@example.com', phone: '07700 900123', consent: true } }, r);
    assert.equal(r.statusCode, 201);
    const victim = { id: r.body.member.id, name: r.body.member.name };
    assert.ok(victim.id && r.body.passUrl, 'the real signup does get its own pass');

    r = res();
    await h({ method: 'POST', headers, body: attack.body }, r);
    assert.equal(r.statusCode, 200, attack.what);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.existing, true);
    assert.equal(r.body.member, undefined, `no member object when given ${attack.what}`);
    assert.equal(r.body.passUrl, undefined, `no pass download link when given ${attack.what}`);
    assert.equal(r.body.googleUrl, undefined, `no Google Wallet link when given ${attack.what}`);

    // Nothing identifying anywhere in the serialised body, however reshaped.
    const wire = JSON.stringify(r.body);
    assert.ok(!wire.includes(victim.id), 'the member uuid is the QR payload and must not appear');
    assert.ok(!wire.includes(db.rows[0].download_token), 'the download token must not appear');
    assert.ok(!wire.includes(db.rows[0].pass_serial), 'the pass serial must not appear');
    assert.ok(!wire.includes(victim.name), 'the real name must not appear');
  }
});

test('the duplicate-key race discloses nothing either', async () => {
  // A second signup on the same address between our lookup and our insert
  // lands in the catch block, which looked the member up again and used to
  // return it in full. Modelled properly: the lookups miss, the insert is
  // refused, and only then does the row exist.
  _internals.hits.clear();
  const db = fakeDb();
  const victim = { id: 'uuid-victim', email: 'yunus@example.com', phone: '+447700900123', full_name: 'Yunus Tufail', points: 8, pass_serial: 'LBM-ABCDEFGHIJ', download_token: 'tok-secret' };
  db.insert = async () => {
    db.rows.push(victim); // the racing request got there first
    const e = new Error('duplicate key value violates unique constraint');
    e.status = 409;
    throw e;
  };
  const h = createHandler({ db });
  const r = res();
  await h({ method: 'POST', headers: { 'x-forwarded-for': '5.5.5.5' }, body: { full_name: 'A B', email: 'yunus@example.com', phone: '07700900000' } }, r);
  assert.equal(r.statusCode, 200, 'the race is handled, not reported as a failure');
  assert.equal(r.body.existing, true);
  assert.equal(r.body.member, undefined);
  const wire = JSON.stringify(r.body);
  assert.ok(!wire.includes('tok-secret') && !wire.includes('uuid-victim') && !wire.includes('LBM-ABCDEFGHIJ'), 'nothing of the member leaks');
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

test('a mobile number already on a card brings that card back, even with a new email', async () => {
  const db = fakeDb();
  const h = createHandler({ db });
  let r = res();
  await h({ method: 'POST', headers: {}, body: { full_name: 'Yunus Tufail', email: 'yunus@example.com', phone: '07700 900123' } }, r);
  assert.equal(r.statusCode, 201);
  const sent = [];
  const withMail = createHandler({ db, env: { RESEND_API_KEY: 'k', RESEND_FROM: 'La Bottega <x@y.com>' }, recovery: { settings: () => ({ enabled: true }), startRecovery: async (m) => { sent.push(m.email); return { sent: true, hint: 'y•••@example.com' }; }, maskEmail: () => 'y•••@example.com' } });
  r = res();
  await withMail({ method: 'POST', headers: {}, body: { full_name: 'Y Tufail', email: 'another@example.com', phone: '+44 7700 900123' } }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.existing, true, 'same number = same card');
  assert.equal(r.body.recovery, true); assert.equal(r.body.hint, 'y•••@example.com');
  assert.equal(r.body.passUrl, undefined, 'the link is not handed to whoever typed the number');
  assert.equal(r.body.member, undefined, 'nor the name on the card');
  assert.deepEqual(sent, ['yunus@example.com'], 'the code went to the email on the card, not the one typed');
  assert.equal(db.rows.length, 1, 'no second card was made');
  r = res();
  await h({ method: 'POST', headers: {}, body: { full_name: 'Marco Rossi', email: 'marco@example.it', phone: '+39 333 123 4567' } }, r);
  assert.equal(r.statusCode, 201, 'an international number joins normally');
  assert.equal(db.rows[1].phone, '+393331234567');
});

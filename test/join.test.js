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

test('join creates a member and answers with the pass link; a repeat gets the same pass', async () => {
  _internals.hits.clear();
  const db = fakeDb();
  const h = createHandler({ db });
  const headers = { 'x-forwarded-for': '1.1.1.1' };
  let r = res(); await h({ method: 'POST', headers, body: { full_name: 'Yunus Tufail', email: 'Yunus@Example.com', phone: '07700 900123', consent: true } }, r);
  assert.equal(r.statusCode, 201); assert.equal(r.body.ok, true); assert.equal(r.body.existing, false);
  assert.match(r.body.passUrl, /^\/api\/pass\/LBM-[A-Z2-9]{10}\?t=/);
  assert.equal(db.rows[0].email, 'yunus@example.com'); assert.equal(db.rows[0].phone, '+447700900123'); assert.equal(db.rows[0].consent_marketing, true);
  const first = r.body.passUrl;
  r = res(); await h({ method: 'POST', headers, body: { full_name: 'Yunus Tufail', email: 'yunus@example.com', phone: '07700900123' } }, r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.existing, true); assert.equal(r.body.passUrl, first);
  assert.equal(db.rows.length, 1);
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
  r = res();
  await h({ method: 'POST', headers: {}, body: { full_name: 'Y Tufail', email: 'another@example.com', phone: '+44 7700 900123' } }, r);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.existing, true, 'same number = same card');
  assert.equal(r.body.member.name, 'Yunus Tufail');
  assert.equal(db.rows.length, 1, 'no second card was made');
  r = res();
  await h({ method: 'POST', headers: {}, body: { full_name: 'Marco Rossi', email: 'marco@example.it', phone: '+39 333 123 4567' } }, r);
  assert.equal(r.statusCode, 201, 'an international number joins normally');
  assert.equal(db.rows[1].phone, '+393331234567');
});

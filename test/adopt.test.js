const { test } = require('node:test');
const assert = require('node:assert/strict');
const { adoptFromPassKit } = require('../lib/adopt');

const PK = '7NEWmemberIdFromPassKit0';
function fakeDb(seed = []) {
  const rows = [...seed];
  return {
    rows,
    enabled: () => true,
    selectOne: async (t, q) => { const m = /email_norm=eq\.(.+?)(&|$)/.exec(q); return m ? rows.find((r) => r.email === decodeURIComponent(m[1])) || null : null; },
    insert: async (t, row) => { if (row.email && rows.some((r) => r.email === row.email)) { const e = new Error('duplicate key value violates unique constraint "members_email_norm_idx"'); e.status = 409; throw e; } const r = { id: 'u' + (rows.length + 1), points: 0, status: 'active', ...row }; rows.push(r); return r; },
    update: async (t, q, patch) => { const id = /id=eq\.(.+)$/.exec(q)[1]; const r = rows.find((x) => x.id === id); Object.assign(r, patch); return [r]; },
  };
}
const pk = (member) => ({ getMember: async (ref) => { if (member && ref.id === PK) return member; const e = new Error('no member record found'); e.status = 404; throw e; } });

test('a PassKit member we never imported is created from PassKit, serial = their PassKit id', async () => {
  const db = fakeDb();
  const m = await adoptFromPassKit(PK, { db, pk: pk({ id: PK, points: 4, person: { forename: 'Marco', surname: 'Rossi', emailAddress: 'Marco@Example.it', mobileNumber: '+39 333 1234567' } }) });
  assert.ok(m);
  assert.equal(m.pass_serial, PK); assert.equal(m.passkit_member_id, PK); assert.equal(m.source, 'passkit-import');
  assert.equal(m.full_name, 'Marco Rossi'); assert.equal(m.email, 'marco@example.it'); assert.equal(m.phone, '+393331234567'); assert.equal(m.points, 4);
  assert.ok(m.download_token && m.pass_auth_token);
});

test('unknown to PassKit, a bad id, or PassKit not configured: null, never a throw', async () => {
  const db = fakeDb();
  assert.equal(await adoptFromPassKit(PK, { db, pk: pk(null) }), null);
  assert.equal(await adoptFromPassKit('bad id!', { db, pk: pk({ id: PK }) }), null);
  assert.equal(await adoptFromPassKit(PK, { db, pk: { getMember: async () => { throw new Error('PASSKIT_API_KEY and PASSKIT_API_SECRET must be set.'); } } }), null);
  assert.equal(db.rows.length, 0);
});

test('an email already on a native card is linked rather than duplicated; an unreadable balance is left alone', async () => {
  const db = fakeDb([{ id: 'native1', email: 'marco@example.it', full_name: 'Marco', points: 3, pass_serial: 'LBM-1', passkit_member_id: null }]);
  const m = await adoptFromPassKit(PK, { db, pk: pk({ id: PK, points: 'n/a', person: { displayName: 'Marco R', emailAddress: 'marco@example.it' } }) });
  assert.equal(m.id, 'native1'); assert.equal(m.passkit_member_id, PK);
  assert.equal(db.rows.length, 1, 'no second card');
  assert.equal(db.rows[0].points, 3, 'the native balance is untouched');
});

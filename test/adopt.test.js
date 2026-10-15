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

test('a balance PassKit does not give us is never written as zero, and no card is issued', async () => {
  // Number() answers 0 for every one of these and the column is
  // `integer not null default 0`, so both writing it and leaving it out hand
  // a customer with stamps a card showing none. The card is the thing this
  // function issues, so there is no later chance to notice.
  for (const points of [undefined, null, '', 'n/a', false, [], -1, 2.5]) {
    const db = fakeDb();
    const m = await adoptFromPassKit(PK, { db, pk: pk({ id: PK, points, person: { forename: 'Marco', surname: 'Rossi', emailAddress: 'marco@example.it' } }) });
    assert.equal(m, null, 'refused: ' + JSON.stringify(points));
    assert.equal(db.rows.length, 0, 'no card issued for ' + JSON.stringify(points));
  }
  // A real 0 is a balance, and so is a number that arrives as a string.
  for (const points of [0, '0', 14, '14']) {
    const db = fakeDb();
    const m = await adoptFromPassKit(PK, { db, pk: pk({ id: PK, points, person: { forename: 'Marco', surname: 'Rossi', emailAddress: 'marco@example.it' } }) });
    assert.equal(m && m.points, Number(points), 'accepted: ' + JSON.stringify(points));
  }
});

test('the till hands over the balance it has already read, so an odd PassKit record does not block adoption', async () => {
  // lib/native-scan.js checks the scan balance with readAmount before it gets
  // here, so passing it means a PassKit member object with nothing readable on
  // it still does not cost that customer their adoption at the counter.
  const db = fakeDb();
  const m = await adoptFromPassKit(PK, { db, points: 9, pk: pk({ id: PK, points: null, person: { displayName: 'Marco Rossi' } }) });
  assert.equal(m.points, 9);
  // A supplied balance that cannot be read is refused in the same way.
  const db2 = fakeDb();
  assert.equal(await adoptFromPassKit(PK, { db: db2, points: '', pk: pk({ id: PK, points: 7, person: {} }) }), null);
  assert.equal(db2.rows.length, 0);
});

test('an email already on another PassKit member card is not handed over', async () => {
  // Two PassKit members sharing an email address: the import drops the second
  // and reports it. Returning the first card here would hand this caller a
  // pass that is not theirs, so the only safe answer is nobody.
  const db = fakeDb([{ id: 'other1', email: 'marco@example.it', full_name: 'Marco', points: 3, pass_serial: 'OTHERPASSKITID00', passkit_member_id: 'OTHERPASSKITID00' }]);
  const m = await adoptFromPassKit(PK, { db, pk: pk({ id: PK, points: 4, person: { emailAddress: 'marco@example.it' } }) });
  assert.equal(m, null);
  assert.equal(db.rows.length, 1, 'no second card');
  assert.equal(db.rows[0].passkit_member_id, 'OTHERPASSKITID00', 'and the first was left alone');
});

test('a database that rejects gives null, never a throw', async () => {
  // The docblock promises it and lib/native-scan.js relies on it: the mirror
  // is after-reply work on the scan path, and a scan must not fail because of
  // it. The link branch used to await db.update unguarded, and that await sits
  // inside the catch, so a rejection there escaped the function.
  const boom = (what) => async () => { const e = new Error(what + ' is down'); e.status = 503; throw e; };
  const member = pk({ id: PK, points: 4, person: { emailAddress: 'marco@example.it' } });
  const everything = { enabled: () => true, selectOne: boom('select'), insert: boom('insert'), update: boom('update') };
  const linkFails = {
    enabled: () => true,
    selectOne: async () => ({ id: 'native1', email: 'marco@example.it', points: 3, passkit_member_id: null }),
    insert: boom('insert'),
    update: boom('update'),
  };
  assert.equal(await adoptFromPassKit(PK, { db: everything, pk: member }), null);
  assert.equal(await adoptFromPassKit(PK, { db: linkFails, pk: member }), null);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, _internals } = require('../api/admin/import');

function res() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } }; }
function parseIn(q, key) {
  const m = new RegExp(`${key}=in\\.(\\([^&]*\\))`).exec(decodeURIComponent(q));
  return m ? m[1].slice(1, -1).split(',').map((s) => s.replace(/^"|"$/g, '')) : null;
}
function fakeDb(seed = []) {
  const rows = seed.map((r) => ({ email_norm: r.email ? r.email.toLowerCase() : null, ...r }));
  const calls = [];
  return {
    rows, calls,
    enabled: () => true,
    select: async (table, q) => {
      calls.push(['select', q]);
      let ids;
      if ((ids = parseIn(q, 'passkit_member_id'))) return rows.filter((r) => ids.includes(r.passkit_member_id));
      if ((ids = parseIn(q, 'email_norm'))) return rows.filter((r) => r.email_norm && ids.includes(r.email_norm));
      return [];
    },
    update: async (table, q, patch) => { calls.push(['update', q, patch]); const id = decodeURIComponent(/id=eq\.(.+)$/.exec(q)[1]); const r = rows.find((x) => x.id === id); Object.assign(r, patch); return [r]; },
    rest: async (path, { method, body }) => {
      calls.push(['rest', method, body.length]);
      for (const row of body) {
        if (row.email && rows.some((x) => x.email_norm === row.email)) { const e = new Error('duplicate key value violates unique constraint "members_email_norm_idx"'); e.status = 409; throw e; }
      }
      for (const row of body) rows.push({ id: 'u' + (rows.length + 1), email_norm: row.email || null, points: 0, status: 'active', source: 'join', ...row });
      return null;
    },
  };
}

test('prepare validates and normalises an exported row', () => {
  const p = _internals.prepare({ passkit_member_id: '16dm9KIQ7haLWTVgchJPHI', full_name: ' Yunus  Tufail ', email: 'X@Y.com', phone: '07700 900123', points: '5.0' });
  assert.equal(p.ok, true);
  assert.deepEqual(p.row, { passkit_member_id: '16dm9KIQ7haLWTVgchJPHI', full_name: 'Yunus Tufail', email: 'x@y.com', phone: '+447700900123', points: 5, pass_serial: '16dm9KIQ7haLWTVgchJPHI' });
  assert.equal(_internals.prepare({ passkit_member_id: 'bad!', full_name: 'A' }).ok, false);
  assert.equal(_internals.prepare({ passkit_member_id: '16dm9KIQ7haLWTVgchJPHI', full_name: '', email: 'a@b.co' }).ok, false);
  assert.equal(_internals.prepare({ passkit_member_id: '16dm9KIQ7haLWTVgchJPHI', full_name: 'A', points: '' }).row.points, 0);
  assert.equal(decodeURIComponent(_internals.inList(['a', 'b"c'])), '("a","bc")');
});

test('import creates in bulk, updates only what changed on re-run, links a native joiner, drops a taken email, and dry-runs without writing', async () => {
  const db = fakeDb([{ id: 'native1', email: 'already@here.com', full_name: 'Native Joiner', pass_serial: 'LBM-1', points: 2, source: 'join' }]);
  const h = createHandler({ db, env: { ADMIN_SECRET: 's' } });
  const headers = { 'x-admin-secret': 's' };
  const members = [
    { passkit_member_id: '16dm9KIQ7haLWTVgchJPHI', full_name: 'Yunus Tufail', email: 'y@t.com', phone: '07700900123', points: 5 },
    { passkit_member_id: 'AAAAAAAAAAAAAAAAAAAAAA', full_name: 'Native Joiner', email: 'already@here.com', phone: '', points: 9 },
    { passkit_member_id: 'BBBBBBBBBBBBBBBBBBBBBB', full_name: 'Second Person', email: 'Y@T.com', phone: '', points: 1 },
    { passkit_member_id: 'nope', full_name: 'X' },
  ];
  let r = res(); await h({ method: 'POST', headers, body: { members, dry_run: true } }, r);
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.body.created, r.body.updated, r.body.linked, r.body.skipped, r.body.email_dropped], [2, 0, 1, 1, 1]);
  assert.equal(db.rows.length, 1, 'dry run wrote nothing');
  assert.ok(!db.calls.some((c) => c[0] !== 'select'), 'dry run only reads');

  r = res(); await h({ method: 'POST', headers, body: { members } }, r);
  assert.deepEqual([r.body.created, r.body.updated, r.body.linked, r.body.skipped, r.body.email_dropped], [2, 0, 1, 1, 1]);
  const imported = db.rows.find((x) => x.passkit_member_id === '16dm9KIQ7haLWTVgchJPHI');
  assert.equal(imported.pass_serial, '16dm9KIQ7haLWTVgchJPHI', 'serial = PassKit id so the pass replaces in place');
  assert.equal(imported.source, 'passkit-import'); assert.equal(imported.points, 5); assert.ok(imported.download_token && imported.pass_auth_token);
  const second = db.rows.find((x) => x.passkit_member_id === 'BBBBBBBBBBBBBBBBBBBBBB');
  assert.equal(second.email, null, 'the shared email stays with the first member');
  assert.equal(db.rows.find((x) => x.id === 'native1').passkit_member_id, 'AAAAAAAAAAAAAAAAAAAAAA', 'native member linked, not duplicated');
  assert.ok(r.body.problems.some((p) => /already belongs/.test(p.reason)));

  db.calls.length = 0;
  r = res(); await h({ method: 'POST', headers, body: { members } }, r);
  assert.deepEqual([r.body.created, r.body.updated, r.body.unchanged, r.body.linked], [0, 0, 3, 0], 'a re-run of the same file changes nothing');
  assert.equal(db.rows.find((x) => x.id === 'native1').points, 2, 'a linked native joiner keeps their own balance');
  assert.ok(!db.calls.some((c) => c[0] === 'update' || c[0] === 'rest'));
  r = res(); await h({ method: 'POST', headers, body: { members: [{ ...members[0], points: 7 }] } }, r);
  assert.deepEqual([r.body.created, r.body.updated], [0, 1]); assert.equal(imported.points, 7); assert.ok(imported.pass_updated_at, 'a points change marks the pass as changed');

  r = res(); await h({ method: 'POST', headers: {}, body: { members } }, r); assert.equal(r.statusCode, 401);
  r = res(); await h({ method: 'POST', headers, body: { members: [] } }, r); assert.equal(r.statusCode, 400);
});

test('a refused chunk is retried row by row and the refused rows reported', async () => {
  const db = fakeDb([]);
  const h = createHandler({ db, env: { ADMIN_SECRET: 's' } });
  const members = [
    { passkit_member_id: 'CCCCCCCCCCCCCCCCCCCCCC', full_name: 'Fine', email: 'fine@x.com', points: 0 },
    { passkit_member_id: 'DDDDDDDDDDDDDDDDDDDDDD', full_name: 'Clash', email: 'clash@x.com', points: 0 },
  ];
  // the second row's email appears in the table between our lookup and the insert
  const origRest = db.rest;
  db.rest = async (path, opts) => { if (opts.body.length === 2) db.rows.push({ id: 'race', email_norm: 'clash@x.com', passkit_member_id: 'ZZZZZZZZZZZZZZZZZZZZZZ' }); return origRest(path, opts); };
  const r = res(); await h({ method: 'POST', headers: { 'x-admin-secret': 's' }, body: { members } }, r);
  assert.deepEqual([r.body.created, r.body.skipped], [1, 1]);
  assert.ok(db.rows.some((x) => x.passkit_member_id === 'CCCCCCCCCCCCCCCCCCCCCC'));
  assert.ok(r.body.problems.some((p) => p.passkit_member_id === 'DDDDDDDDDDDDDDDDDDDDDD' && /not inserted/.test(p.reason)));
});

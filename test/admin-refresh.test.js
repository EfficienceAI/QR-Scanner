const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../api/admin/refresh');
const members = require('../lib/members');

function res() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } }; }

// A page of serials straight out of `members`, keyed by cursor.
function pager(all) {
  return async ({ limit, after }) => {
    const from = after ? all.findIndex((s) => s > after) : 0;
    return from === -1 ? [] : all.slice(from, from + limit);
  };
}

test('refresh one pass or every pass, gated by the admin secret', async () => {
  const touched = [];
  const h = createHandler({
    env: { ADMIN_SECRET: 's3cret' },
    touchPass: async (serial) => { touched.push(serial); return serial === 'LBM-MISSING' ? null : { pass_serial: serial }; },
    passPage: pager(Array.from({ length: 201 }, (_, i) => 'LBM-' + String(i).padStart(4, '0'))),
    pushPassUpdate: async (serial) => ({ serial, sent: 1, failed: 0, removed: 0, skipped: false }),
    gwalletSettings: () => ({ enabled: false }),
  });
  let r = res(); await h({ method: 'POST', headers: {}, body: { serial: 'LBM-1' } }, r); assert.equal(r.statusCode, 401);
  r = res(); await h({ method: 'POST', headers: { 'x-admin-secret': 's3cret' }, body: {} }, r); assert.equal(r.statusCode, 400);
  r = res(); await h({ method: 'POST', headers: { 'x-admin-secret': 's3cret' }, body: { serial: 'LBM-1' } }, r);
  assert.equal(r.statusCode, 200); assert.deepEqual(r.body.results, [{ serial: 'LBM-1', found: true, sent: 1, failed: 0, removed: 0, skipped: false, google: false }]);
  r = res(); await h({ method: 'POST', headers: { 'x-admin-secret': 's3cret' }, body: { serial: 'LBM-MISSING' } }, r);
  assert.deepEqual(r.body.results, [{ serial: 'LBM-MISSING', found: false }]);

  r = res(); await h({ method: 'POST', headers: { 'x-admin-secret': 's3cret' }, body: { all: true } }, r);
  assert.equal(r.body.refreshed, 200);
  assert.equal(r.body.nextAfter, 'LBM-0199', 'the cursor is the last serial of the page');
  r = res(); await h({ method: 'POST', headers: { 'x-admin-secret': 's3cret' }, body: { all: true, after: 'LBM-0199' } }, r);
  assert.equal(r.body.refreshed, 1); assert.equal(r.body.nextAfter, null);
});

test('a refresh-everything walk reaches every pass, however many devices a customer has', async () => {
  // M6. The old walk read pass_registrations and de-duplicated the serials,
  // but applied the page-size test to the *de-duplicated* array. One customer
  // with an iPhone and an Apple Watch -- or a reinstall leaving two rows --
  // made a full page of 200 rows come back as 199 serials, so the walk
  // stopped and the operator was told the refresh had finished. After an
  // artwork change, every pass past the first page was never touched.
  //
  // It also missed Android-only members entirely (M7): they have a
  // gwallet_object_id and no Apple registration row at all. Both are fixed by
  // walking `members`, where one row is one pass.
  const serials = Array.from({ length: 450 }, (_, i) => 'LBM-' + String(i).padStart(4, '0'));
  const touched = [];
  const h = createHandler({
    env: { ADMIN_SECRET: 's3cret' },
    touchPass: async (s) => { touched.push(s); return { pass_serial: s }; },
    passPage: pager(serials),
    pushPassUpdate: async () => ({ sent: 0, failed: 0, removed: 0, skipped: true }),
    gwalletSettings: () => ({ enabled: false }),
  });

  let after = null;
  let pages = 0;
  do {
    const r = res();
    await h({ method: 'POST', headers: { 'x-admin-secret': 's3cret' }, body: { all: true, after } }, r);
    assert.equal(r.statusCode, 200);
    after = r.body.nextAfter;
    pages += 1;
    assert.ok(pages < 10, 'the walk terminates');
  } while (after);

  assert.equal(pages, 3, '450 passes in pages of 200');
  assert.deepEqual(touched, serials, 'every pass was touched exactly once, in order');
});

test('the Google Wallet class design is pushed once per run, not once per member', async () => {
  // M7. syncClass was exported and tested but called from no route, and
  // ensureClass deliberately leaves an existing class alone -- so once the
  // loyalty class existed, changing PASS_THEME, the logo, the programme name
  // or the website could never reach an Android card, and a class stuck
  // UNDER_REVIEW had no code path to be re-submitted.
  const classPuts = [];
  const base = {
    env: { ADMIN_SECRET: 's3cret' },
    touchPass: async (s) => ({ pass_serial: s }),
    passPage: pager(['LBM-0001', 'LBM-0002']),
    pushPassUpdate: async () => ({ sent: 1, failed: 0, removed: 0, skipped: false }),
    syncGoogle: async () => true,
    gwalletSettings: () => ({ enabled: true }),
    syncClass: async (s) => { classPuts.push(s); return { id: 'class' }; },
  };
  const h = createHandler(base);
  const headers = { 'x-admin-secret': 's3cret' };

  // The first page of an all-run syncs the class...
  let r = res(); await h({ method: 'POST', headers, body: { all: true } }, r);
  assert.equal(r.body.classSynced, true);
  assert.equal(classPuts.length, 1, 'once for the whole run, not once per member');

  // ...and a later page does not do it again.
  r = res(); await h({ method: 'POST', headers, body: { all: true, after: 'LBM-0001' } }, r);
  assert.equal(r.body.classSynced, null);
  assert.equal(classPuts.length, 1);

  // { class: true } does it on its own, touching no passes.
  r = res(); await h({ method: 'POST', headers, body: { class: true } }, r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.classSynced, true); assert.equal(r.body.refreshed, 0);
  assert.equal(classPuts.length, 2);

  // A Google outage must not stop the Apple half of a refresh.
  const broken = createHandler({ ...base, syncClass: async () => { const e = new Error('google down'); e.status = 503; throw e; } });
  r = res(); await broken({ method: 'POST', headers, body: { all: true } }, r);
  assert.equal(r.statusCode, 200, 'the run continues');
  assert.equal(r.body.classSynced, false, 'and reports that the class did not sync');
  assert.equal(r.body.refreshed, 2, 'the passes were still refreshed');

  // With Google Wallet unconfigured there is no class to push.
  const off = createHandler({ ...base, gwalletSettings: () => ({ enabled: false }) });
  r = res(); await off({ method: 'POST', headers, body: { class: true } }, r);
  assert.equal(r.body.classSynced, false);
});

test('touchPass and passPage talk to the right tables', async () => {
  const calls = [];
  const db = {
    update: async (table, q, patch) => { calls.push(['update', table, q, Object.keys(patch)]); return [{ pass_serial: 'LBM-1' }]; },
    select: async (table, q) => { calls.push(['select', table, q]); return [{ pass_serial: 'LBM-1' }, { pass_serial: 'LBM-2' }]; },
  };
  assert.deepEqual(await members.touchPass('LBM-1', { db }), { pass_serial: 'LBM-1' });
  assert.deepEqual(calls[0], ['update', 'members', 'pass_serial=eq.LBM-1', ['pass_updated_at']]);

  assert.deepEqual(await members.passPage({ limit: 50 }, { db }), ['LBM-1', 'LBM-2']);
  assert.equal(calls[1][1], 'members', 'members, not pass_registrations: that table is Apple-only');
  assert.match(calls[1][2], /limit=50/);
  assert.ok(!calls[1][2].includes('offset'), 'a cursor, not an offset');

  await members.passPage({ limit: 50, after: 'LBM-1' }, { db });
  assert.match(calls[2][2], /pass_serial=gt\.LBM-1/, 'the next page starts after the last serial');
});

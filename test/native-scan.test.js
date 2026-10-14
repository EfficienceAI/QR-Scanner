const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler, _internals } = require('../lib/native-scan');
const members = require('../lib/members');
const { DbError } = require('../lib/db');

const UUID = 'b24101aa-16a1-4d8d-a42f-5610b6cf787a';
const cfg = { redeemCost: 9, maxPointsPerScan: 99 };
function res() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.ended = true; this.body = b ? JSON.parse(b) : null; } }; }

function world({ points = 4, status = 'active', passkitId = null, rows = [] } = {}) {
  const member = { id: UUID, full_name: 'Yunus Tufail', points, status, pass_serial: 'LBM-HAXM9Z7KW4', passkit_member_id: passkitId, created_at: '2026-10-09T15:12:36Z' };
  const events = [], pushes = [], history = [];
  const deps = {
    members: {
      getById: async (id) => (id === UUID ? { ...member } : null),
      adjustPoints: async (id, delta) => { if (member.points + delta < 0) throw new members.InsufficientPointsError(); member.points += delta; return member.points; },
      findByPasskitId: async (pk) => (pk === passkitId ? { ...member } : null),
      syncPoints: async (id, p, o) => { member.points = p; member.visited = o.visited; return { ...member }; },
    },
    ledger: { recordEvent: async (e) => { events.push(e); return true; }, listMemberEvents: async (ids, o) => { history.push(ids); return rows; } },
    pushPassUpdate: async (serial) => { pushes.push(serial); return { sent: 1 }; },
    db: { enabled: () => true },
  };
  return { member, events, pushes, history, deps, handler: createHandler(deps) };
}

test('summarizeHistory counts adds as visits and redeems as redemptions', () => {
  const rows = [
    { action: 'lookup', occurred_at: '2026-10-10T10:00:00Z' },
    { action: 'add', occurred_at: '2026-10-10T10:00:01Z' },
    { action: 'add', occurred_at: '2026-09-01T09:00:00Z' },
    { action: 'redeem', occurred_at: '2026-09-20T09:00:00Z' },
    { action: 'remove', occurred_at: '2026-09-21T09:00:00Z' },
  ];
  const h = _internals.summarizeHistory(rows, 3);
  assert.deepEqual([h.recorded, h.visits, h.lastVisit, h.firstVisitOn, h.redemptions, h.lastRedeem, h.firstVisit], [true, 2, '2026-10-10T10:00:01.000Z', '2026-09-01T09:00:00.000Z', 1, '2026-09-20T09:00:00.000Z', false]);
  assert.equal(_internals.summarizeHistory([], 0).firstVisit, true, 'no adds and no points = first coffee');
  assert.equal(_internals.summarizeHistory([], 5).firstVisit, false, 'a balance with no rows = history predates the ledger (imported)');
  assert.equal(_internals.summarizeHistory(null, 5).recorded, false);
});

test('lookup answers from the members table, with history from our ledger, and records a scan after replying', async () => {
  const w = world({ points: 4, passkitId: '16dm9KIQ7haLWTVgchJPHI', rows: [{ action: 'add', occurred_at: '2026-10-10T10:00:01Z' }] });
  const r = res();
  await w.handler.handle(UUID, { action: 'lookup_customer', body: {}, cfg, res: r, requestId: 'scan:1' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.points, 4);
  assert.equal(r.body.member.name, 'Yunus Tufail');
  assert.equal(r.body.member.native, true);
  assert.equal(r.body.history.visits, 1);
  assert.deepEqual(r.body.settings, { redeemCost: 9, maxPointsPerScan: 99 });
  assert.deepEqual(w.history[0], [UUID, '16dm9KIQ7haLWTVgchJPHI'], 'history includes the PassKit-era rows of an imported member');
  assert.deepEqual(w.events, [{ action: 'lookup', memberId: UUID, requestId: 'scan:1' }]);
  assert.equal(w.pushes.length, 0, 'a lookup does not push');
});

test('add, remove and redeem move the balance atomically, then record and push', async () => {
  const w = world({ points: 8 });
  let r = res();
  await w.handler.handle(UUID, { action: 'add_points', body: { points: 1 }, cfg, res: r, requestId: 'scan:2' });
  assert.deepEqual(r.body, { ok: true, action: 'add_points', added: 1, points: 9 });
  r = res();
  await w.handler.handle(UUID, { action: 'redeem_points', body: { points_to_remove: 1 }, cfg, res: r });
  assert.deepEqual(r.body, { ok: true, action: 'redeem_points', redeemed: 9, points: 0 }, 'the server decides the cost');
  r = res();
  await w.handler.handle(UUID, { action: 'redeem_points', body: {}, cfg, res: r });
  assert.equal(r.statusCode, 409); assert.equal(r.body.points, 0); assert.equal(r.body.required, 9);
  r = res();
  await w.handler.handle(UUID, { action: 'remove_points', body: { points: 1 }, cfg, res: r });
  assert.equal(r.statusCode, 409);
  r = res();
  await w.handler.handle(UUID, { action: 'add_points', body: { points: 0 }, cfg, res: r });
  assert.equal(r.statusCode, 400);
  r = res();
  await w.handler.handle(UUID, { action: 'add_points', body: { points: 100 }, cfg, res: r });
  assert.equal(r.statusCode, 400);
  r = res();
  await w.handler.handle(UUID, { action: 'add_points', body: { points: 2 }, cfg, res: r });
  r = res();
  await w.handler.handle(UUID, { action: 'remove_points', body: { points: 1 }, cfg, res: r });
  assert.deepEqual(r.body, { ok: true, action: 'remove_points', removed: 1, points: 1 });
  assert.deepEqual(w.events.map((e) => [e.action, e.points]), [['add', 1], ['redeem', 9], ['add', 2], ['remove', 1]]);
  assert.equal(w.pushes.length, 4, 'every balance change pushes the pass');
  assert.ok(w.pushes.every((s) => s === 'LBM-HAXM9Z7KW4'));
});

test('the reply is on the wire before the ledger and the push are awaited', async () => {
  const w = world({ points: 1 });
  let release; const hung = new Promise((ok) => { release = ok; });
  w.deps.ledger.recordEvent = async () => { await hung; return true; };
  w.deps.pushPassUpdate = async () => { await hung; return {}; };
  const r = res();
  const done = w.handler.handle(UUID, { action: 'add_points', body: { points: 1 }, cfg, res: r });
  await new Promise((ok) => setImmediate(ok));
  assert.equal(r.ended, true, 'response already sent while the ledger and APNs hang');
  assert.equal(r.body.points, 2);
  release(); await done;
});

test('unknown, deactivated and unconfigured cases', async () => {
  let w = world(); let r = res();
  await w.handler.handle('00000000-0000-0000-0000-000000000000', { action: 'lookup_customer', body: {}, cfg, res: r });
  assert.equal(r.statusCode, 404); assert.equal(r.body.error, 'member_not_found');
  w = world({ status: 'disabled' }); r = res();
  await w.handler.handle(UUID, { action: 'add_points', body: { points: 1 }, cfg, res: r });
  assert.equal(r.statusCode, 403); assert.equal(r.body.error, 'member_inactive');
  w = world(); w.deps.members.getById = async () => { throw new DbError(0, 'database not configured'); }; r = res();
  await w.handler.handle(UUID, { action: 'lookup_customer', body: {}, cfg, res: r });
  assert.equal(r.statusCode, 503); assert.equal(r.body.error, 'not_configured');
  w = world(); w.deps.members.getById = async () => { throw new DbError(500, 'boom'); }; r = res();
  await w.handler.handle(UUID, { action: 'lookup_customer', body: {}, cfg, res: r });
  assert.equal(r.statusCode, 502); assert.equal(r.body.error, 'db_error');
  w = world(); w.deps.ledger.listMemberEvents = async () => { throw new Error('ledger down'); }; r = res();
  await w.handler.handle(UUID, { action: 'lookup_customer', body: {}, cfg, res: r });
  assert.equal(r.statusCode, 200); assert.equal(r.body.history.recorded, false, 'a missing history never fails a lookup');
  w = world(); r = res();
  await w.handler.handle(UUID, { action: 'dance', body: {}, cfg, res: r });
  assert.equal(r.statusCode, 400);
});

test('a PassKit scan is mirrored onto the imported member, and ignored for everyone else', async () => {
  const w = world({ points: 2, passkitId: '16dm9KIQ7haLWTVgchJPHI' });
  const log = [];
  assert.equal(await w.handler.mirrorLegacy({ passkitMemberId: '16dm9KIQ7haLWTVgchJPHI', balance: 6, visited: true, log: (x) => log.push(x) }), true);
  assert.equal(w.member.points, 6); assert.equal(w.member.visited, true);
  assert.deepEqual(w.pushes, ['LBM-HAXM9Z7KW4'], 'an upgraded phone is told to refresh');
  assert.equal(await w.handler.mirrorLegacy({ passkitMemberId: 'someone-else-0000', balance: 3 }), false);
  assert.equal(w.member.points, 6);
  w.deps.members.syncPoints = async () => { throw new Error('db hiccup'); };
  assert.equal(await w.handler.mirrorLegacy({ passkitMemberId: '16dm9KIQ7haLWTVgchJPHI', balance: 7, log: (x) => log.push(x) }), false, 'never throws');
  assert.ok(log.some((x) => x.warn === 'mirror_failed'));
  w.deps.db.enabled = () => false;
  assert.equal(await w.handler.mirrorLegacy({ passkitMemberId: '16dm9KIQ7haLWTVgchJPHI', balance: 7 }), false, 'skipped where the members database is not configured');
});

test('the mirror refuses a balance it cannot read, rather than writing a zero', async () => {
  // H1. syncPoints is an absolute SET: mirroring an unreadable balance zeroed
  // an imported member and pushed the zero to their phone, with the ledger
  // holding only the action's delta so the old balance was unrecoverable.
  for (const balance of [undefined, null, '', 'n/a', {}, NaN, [], 'abc']) {
    const w = world({ points: 11, passkitId: '16dm9KIQ7haLWTVgchJPHI' });
    const log = [];
    const result = await w.handler.mirrorLegacy({ passkitMemberId: '16dm9KIQ7haLWTVgchJPHI', balance, log: (x) => log.push(x) });
    assert.equal(result, false, `${JSON.stringify(balance)} must not be mirrored`);
    assert.equal(w.member.points, 11, 'the balance is left at the last one we did read');
    assert.deepEqual(w.pushes, [], 'and nothing is pushed to the phone');
    assert.ok(log.some((x) => x.warn === 'mirror_skipped_unreadable_balance'), 'but it is reported');
  }
  // A real zero is a balance, not a failure to read one.
  const w = world({ points: 11, passkitId: '16dm9KIQ7haLWTVgchJPHI' });
  assert.equal(await w.handler.mirrorLegacy({ passkitMemberId: '16dm9KIQ7haLWTVgchJPHI', balance: 0 }), true);
  assert.equal(w.member.points, 0);
});

test('a native change is written back to PassKit only for a linked member and only where PassKit keys exist', async () => {
  const calls = [];
  const fakePasskit = { earnPoints: async (ref, n) => { calls.push(['earn', ref.id, n]); return { points: 9 }; }, burnPoints: async (ref, n) => { calls.push(['burn', ref.id, n]); return { points: 0 }; } };
  let w = world({ points: 8, passkitId: '16dm9KIQ7haLWTVgchJPHI' });
  let h = createHandler({ ...w.deps, passkit: fakePasskit, env: { PASSKIT_API_KEY: 'k', PASSKIT_API_SECRET: 's' } });
  let r = res(); await h.handle(UUID, { action: 'add_points', body: { points: 1 }, cfg, res: r });
  r = res(); await h.handle(UUID, { action: 'redeem_points', body: {}, cfg, res: r });
  assert.deepEqual(calls, [['earn', '16dm9KIQ7haLWTVgchJPHI', 1], ['burn', '16dm9KIQ7haLWTVgchJPHI', 9]]);
  calls.length = 0;
  h = createHandler({ ...w.deps, passkit: fakePasskit, env: {} });
  r = res(); await h.handle(UUID, { action: 'add_points', body: { points: 1 }, cfg, res: r });
  assert.deepEqual(calls, [], 'no PassKit keys on this deployment: nothing sent');
  w = world({ points: 1 });
  h = createHandler({ ...w.deps, passkit: fakePasskit, env: { PASSKIT_API_KEY: 'k', PASSKIT_API_SECRET: 's' } });
  r = res(); await h.handle(UUID, { action: 'add_points', body: { points: 1 }, cfg, res: r });
  assert.deepEqual(calls, [], 'a member with no PassKit record: nothing sent');
  assert.equal(r.body.points, 2, 'and the scan itself is unaffected');
  fakePasskit.earnPoints = async () => { throw Object.assign(new Error('PassKit down'), { status: 502 }); };
  w = world({ points: 1, passkitId: '16dm9KIQ7haLWTVgchJPHI' });
  h = createHandler({ ...w.deps, passkit: fakePasskit, env: { PASSKIT_API_KEY: 'k', PASSKIT_API_SECRET: 's' } });
  r = res(); await h.handle(UUID, { action: 'add_points', body: { points: 1 }, cfg, res: r });
  assert.equal(r.statusCode, 200, 'a PassKit failure never fails the scan');
});

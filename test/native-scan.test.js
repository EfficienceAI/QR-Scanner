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

test('a slow ledger cannot hold up a lookup for longer than the history deadline', async () => {
  // M3. The lookup awaited the full ledger read before replying, which is the
  // one thing CLAUDE.md says a ledger call must never do. With Supabase
  // degraded that put the ledger's 4 s default on top of the member read, and
  // staff who think the tap failed tap again. The history is now bounded and
  // degrades to "not recorded" rather than delaying the balance.
  const w = world({ points: 5 });
  let askedTimeout = null;
  w.deps.ledger.listMemberEvents = async (ids, opts) => {
    askedTimeout = opts.timeoutMs;
    const err = new Error('ledger timeout');
    throw err;
  };
  const r = res();
  await w.handler.handle(UUID, { action: 'lookup_customer', body: {}, cfg, res: r, log: () => {} });
  assert.equal(r.statusCode, 200, 'the balance still goes out');
  assert.equal(r.body.points, 5);
  assert.equal(r.body.history.recorded, false, 'the history degrades rather than failing the scan');
  assert.ok(askedTimeout > 0 && askedTimeout < 4000, `the read is bounded well inside the ledger default, got ${askedTimeout}`);
});

test('the four after-reply jobs are armed before the flush, and one failing does not release the rest', async () => {
  // M4 and L1. settle() registered its work *after* send(res, ...), so the
  // guarantee rested on nothing suspending between the two statements -- with
  // four jobs across four modules, one of them making two sequential network
  // calls. Losing it means a Wallet pass stuck at the old balance, which is
  // the symptom this path was built to fix.
  //
  // And Promise.all lets a single rejection resolve after()'s promise while
  // the other three are still in flight, so the platform may freeze the
  // invocation mid-push. allSettled cannot. The job rejecting here is
  // record(), a bare delegation whose "never throws" is a contract written in
  // lib/ledger.js -- which is exactly why settle() must not depend on it.
  const sym = Symbol.for('@vercel/request-context');
  const before = globalThis[sym];
  const registered = [];
  globalThis[sym] = { get: () => ({ waitUntil: (p) => registered.push(p) }) };
  try {
    const member = { id: UUID, full_name: 'Yunus Tufail', points: 1, status: 'active', pass_serial: 'LBM-HAXM9Z7KW4', passkit_member_id: null, created_at: '2026-10-09T15:12:36Z' };
    let release; const hung = new Promise((ok) => { release = ok; });
    let pushFinished = 0;
    const handler = createHandler({
      members: {
        getById: async () => ({ ...member }),
        adjustPoints: async (id, d) => { member.points += d; return member.points; },
      },
      ledger: { recordEvent: async () => { throw new Error('ledger down'); }, listMemberEvents: async () => [] },
      pushPassUpdate: async () => { await hung; pushFinished += 1; return { sent: 1 }; },
      gwallet: { syncAfterChange: async () => false },
      db: { enabled: () => true },
      env: {},
    });

    let armedAtFlush = null;
    const r = res();
    r.end = function end(b) { this.ended = true; this.body = b ? JSON.parse(b) : null; armedAtFlush = registered.length; };

    const done = handler.handle(UUID, { action: 'add_points', body: { points: 1 }, cfg, res: r, log: () => {} });
    await new Promise((ok) => setImmediate(ok));

    assert.equal(r.ended, true, 'the reply went out while the push hangs');
    assert.equal(r.body.points, 2);
    assert.equal(armedAtFlush, 1, 'the work was registered before res.end() flushed, not after');

    // The ledger rejection has happened by now. The registered promise must
    // still be pending, because the push has not finished.
    let settledEarly = false;
    registered[0].then(() => { settledEarly = true; });
    await new Promise((ok) => setImmediate(ok));
    assert.equal(settledEarly, false, 'a rejected job must not release the platform while a push is in flight');
    assert.equal(pushFinished, 0);

    release();
    await done;
    assert.equal(pushFinished, 1, 'the push completed before the invocation could be frozen');
  } finally {
    if (before === undefined) delete globalThis[sym];
    else globalThis[sym] = before;
  }
});

test('a stalled database tells staff to try again, not that the deployment is broken', async () => {
  // L7. A timeout and a missing SUPABASE_URL both arrive as DbError status 0,
  // and the handler branched on that, so a Supabase stall mid-shift told
  // staff the deployment was not configured -- sending them to the wrong
  // place entirely, and never suggesting the one thing that would work.
  let w = world();
  w.deps.members.getById = async () => { throw new DbError(0, 'database timeout after 6000ms', null, 'timeout'); };
  let r = res();
  await w.handler.handle(UUID, { action: 'lookup_customer', body: {}, cfg, res: r, log: () => {} });
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.error, 'db_timeout');
  assert.equal(r.body.retryable, true);
  assert.match(r.body.message, /try again/i);
  assert.ok(!/configur/i.test(r.body.message), 'and it does not blame the deployment');

  // A genuinely unconfigured deployment still says so.
  w = world();
  w.deps.members.getById = async () => { throw new DbError(0, 'database not configured', null, 'not_configured'); };
  r = res();
  await w.handler.handle(UUID, { action: 'lookup_customer', body: {}, cfg, res: r, log: () => {} });
  assert.equal(r.statusCode, 503);
  assert.equal(r.body.error, 'not_configured');
});

test('the after-reply work has not started by the time the reply flushes', async () => {
  // The other half of the guarantee. Arming before send() is necessary but
  // not sufficient: if the work also *began* before send(), it would delay
  // the reply, which is the thing respond-then-record exists to prevent. The
  // microtask is what separates the two, so assert the separation directly.
  const sym = Symbol.for('@vercel/request-context');
  const before = globalThis[sym];
  const registered = [];
  globalThis[sym] = { get: () => ({ waitUntil: (p) => registered.push(p) }) };
  try {
    const w = world({ points: 1 });
    let started = false;
    w.deps.ledger.recordEvent = async (e) => { started = true; w.events.push(e); return true; };
    let registeredAtFlush = null;
    let startedAtFlush = null;
    const r = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      end(b) { this.body = b ? JSON.parse(b) : null; registeredAtFlush = registered.length; startedAtFlush = started; },
    };
    await w.handler.handle(UUID, { action: 'add_points', body: { points: 1 }, cfg, res: r });
    assert.equal(registeredAtFlush, 1, 'armed before res.end() flushed');
    assert.equal(startedAtFlush, false, 'but the work had not started yet: it never delays the reply');
    await Promise.all(registered);
    assert.equal(started, true, 'and it does run once the reply is out');
    assert.equal(w.events.length, 1);
  } finally {
    if (before === undefined) delete globalThis[sym];
    else globalThis[sym] = before;
  }
});

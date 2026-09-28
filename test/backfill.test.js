const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pointsFromEvent, pointsFromNotes } = require('../api/admin/backfill')._internals;

// The riskiest file in the PR: it writes thousands of rows in bulk, from free
// text that a system we no longer run produced.
test('an amount is read from an old event however the note was phrased', () => {
  assert.equal(pointsFromNotes('Loyalty Scanner: +3 points'), 3);
  assert.equal(pointsFromNotes('Loyalty Scanner: -9 points'), 9);
  assert.equal(pointsFromNotes('9 points'), 9, 'unsigned: the old format, which used to read as 0');
  assert.equal(pointsFromNotes('1 point redeemed'), 1);
  assert.equal(pointsFromNotes('Earned 12 Points'), 12);
  assert.equal(pointsFromNotes(''), null, 'unknown stays unknown');
  assert.equal(pointsFromNotes('Stamp added'), null);
  assert.equal(pointsFromNotes(undefined), null);
});

test('a structured amount on the event beats the note, and the sign never decides', () => {
  assert.equal(pointsFromEvent({ points: 4, notes: '9 points' }), 4);
  assert.equal(pointsFromEvent({ points: '7' }), 7);
  assert.equal(pointsFromEvent({ pointsBurned: -9 }), 9, 'direction comes from eventType, not the sign');
  assert.equal(pointsFromEvent({ metaData: { points: 2 } }), 2);
  assert.equal(pointsFromEvent({ eventDetails: { points: 5 } }), 5);
  assert.equal(pointsFromEvent({ notes: '9 points' }), 9);
  assert.equal(pointsFromEvent({}), null);
  assert.equal(pointsFromEvent({ points: 'lots' }), null);
});

// ---- the handler itself -----------------------------------------------------
const handler = require('../api/admin/backfill');

const EARN = 'EVENT_MEMBER_POINTS_EARNED';
const BURN = 'EVENT_MEMBER_POINTS_BURNED';
const LIVE_SINCE = '2026-09-01T00:00:00+00:00';

const EVENTS = [
  { id: 'e1', eventType: EARN, date: '2026-05-01T09:00:00Z', notes: '9 points', member: { id: 'M1' } },
  { id: 'e2', eventType: EARN, date: '2026-05-02T09:00:00Z', notes: 'Stamp', member: { id: 'M2' } },
  { id: 'e3', eventType: BURN, date: '2026-05-03T09:00:00Z', notes: '-9 points', member: { id: 'M1' } },
  { id: 'e4', eventType: 'EVENT_MEMBER_ENROLLED', date: '2026-05-04T09:00:00Z', member: { id: 'M3' } },
  { id: 'e5', eventType: EARN, date: '2026-09-20T09:00:00Z', notes: '+2 points', member: { id: 'M4' } },
];

function stubServices(writes) {
  process.env.ADMIN_SECRET = 'admin-secret';
  process.env.PASSKIT_API_KEY = 'k';
  process.env.PASSKIT_API_SECRET = 's';
  process.env.PASSKIT_PROGRAM_ID = 'P1';
  process.env.SUPABASE_URL = 'https://db.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = 'svc';
  global.fetch = async (url, init) => {
    const u = String(url);
    const body = (text) => ({ ok: true, status: 200, text: async () => text });
    if (u.includes('/rest/v1/rpc/scan_totals')) {
      return body(JSON.stringify([{ today: 0, total: 0, first_at: LIVE_SINCE, live_since: LIVE_SINCE }]));
    }
    if (u.includes('/rest/v1/scan_events')) {
      const rows = JSON.parse(init.body);
      writes.push({ url: u, rows });
      return body(JSON.stringify(rows.map((_, i) => ({ id: i + 1 }))));
    }
    if (u.includes('/members/program/list/events/P1')) {
      return body(EVENTS.map((e) => JSON.stringify({ result: e })).join('\n'));
    }
    return { ok: false, status: 404, text: async () => '{"message":"no route"}' };
  };
}

async function invoke(query, headers) {
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(x) { this.body = x ? JSON.parse(x) : null; } };
  await handler({ method: 'POST', url: '/api/admin/backfill' + (query || ''), headers: headers === undefined ? { 'x-admin-secret': 'admin-secret' } : headers }, res);
  return res;
}

test('the backfill refuses anyone without the admin secret', async () => {
  const writes = [];
  stubServices(writes);
  for (const headers of [{}, { 'x-admin-secret': 'guess' }]) {
    const r = await invoke('', headers);
    assert.equal(r.statusCode, 401);
  }
  const prev = process.env.ADMIN_SECRET;
  delete process.env.ADMIN_SECRET;
  try {
    const r = await invoke('', { 'x-admin-secret': prev });
    assert.equal(r.statusCode, 503);
    assert.equal(r.body.error, 'not_configured');
  } finally {
    process.env.ADMIN_SECRET = prev;
  }
  assert.equal(writes.length, 0);
  const wrongMethod = { statusCode: 0, headers: {}, setHeader() {}, end(x) { this.body = JSON.parse(x); } };
  await handler({ method: 'GET', url: '/api/admin/backfill', headers: {} }, wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);
});

test('a dry run writes nothing and shows what it read from each note', async () => {
  const writes = [];
  stubServices(writes);
  const r = await invoke('?dryRun=1');
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.dryRun, true);
  assert.equal(writes.length, 0, 'nothing reaches the ledger on a dry run');
  assert.equal(r.body.seen, 5);
  assert.equal(r.body.sent, 3, 'three importable events');
  assert.equal(r.body.imported, 0);
  assert.equal(r.body.skippedAfterCutoff, 1, 'the live ledger already has this one');
  assert.equal(r.body.skippedOther, 1, 'enrolment is not a scan');
  assert.equal(r.body.unknownPoints, 1, 'the "Stamp" note carries no amount');
  assert.deepEqual(r.body.samples.map((s) => s.read), [9, null, 9]);
  assert.equal(r.body.done, true);
  assert.equal(r.body.nextOffset, 5);
});

test('a real run stores the amount it could read and null for the rest', async () => {
  const writes = [];
  stubServices(writes);
  const r = await invoke('?pages=1');
  assert.equal(r.statusCode, 200);
  assert.equal(writes.length, 1);
  const rows = writes[0].rows;
  assert.deepEqual(rows.map((x) => x.action), ['add', 'add', 'redeem']);
  assert.deepEqual(rows.map((x) => x.points), [9, null, 9]);
  assert.deepEqual(rows.map((x) => x.external_id), ['e1', 'e2', 'e3']);
  assert.equal(rows[0].source, 'passkit-backfill');
  assert.equal(rows[0].occurred_at, '2026-05-01T09:00:00.000Z');
  assert.equal(r.body.sent, 3);
  assert.equal(r.body.imported, 3);
});

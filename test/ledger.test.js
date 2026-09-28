const { test } = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../lib/ledger');

const withEnv = async (env, fn) => {
  const prev = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_KEY };
  process.env.SUPABASE_URL = env.url; process.env.SUPABASE_SERVICE_KEY = env.key;
  try { return await fn(); } finally { process.env.SUPABASE_URL = prev.url || ''; process.env.SUPABASE_SERVICE_KEY = prev.key || ''; }
};

test('recordEvent posts one row with the service key and never throws', async () => {
  await withEnv({ url: 'https://db.supabase.co/', key: 'svc' }, async () => {
    let seen;
    const ok = await ledger.recordEvent({ action: 'lookup', memberId: 'M1' }, { fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 201, text: async () => '' }; } });
    assert.equal(ok, true);
    assert.equal(seen.url, 'https://db.supabase.co/rest/v1/scan_events');
    assert.equal(seen.init.headers.apikey, 'svc'); assert.equal(seen.init.headers.Authorization, 'Bearer svc');
    const row = JSON.parse(seen.init.body)[0];
    assert.equal(row.action, 'lookup'); assert.equal(row.member_id, 'M1'); assert.equal(row.source, 'scanner'); assert.ok(row.occurred_at);
    const warns = [];
    const bad = await ledger.recordEvent({ action: 'add', memberId: 'M1', points: 2 }, { fetchImpl: async () => ({ ok: false, status: 500, text: async () => '{"message":"db down"}' }), log: (x) => warns.push(x) });
    assert.equal(bad, false); assert.equal(warns[0].warn, 'ledger_failed'); assert.equal(warns[0].message, 'db down');
  });
});

test('recordEvent is a no-op when the ledger is not configured', async () => {
  await withEnv({ url: '', key: '' }, async () => {
    let called = 0;
    assert.equal(await ledger.recordEvent({ action: 'lookup' }, { fetchImpl: async () => { called++; } }), false);
    assert.equal(called, 0);
  });
});

test('getTotals and getSeries call the RPCs and normalise numbers', async () => {
  await withEnv({ url: 'https://db.supabase.co', key: 'svc' }, async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => (url.endsWith('/rpc/scan_totals') ? '[{"today":"25","total":"4812","first_at":"2026-06-29T10:00:00+00:00","live_since":null}]' : '[{"bucket_start":"2026-09-28T08:00:00+00:00","scans":"7","adds":"6","redeems":"1","points_stamped":"9","points_burned":"0"}]') }; };
    const t = await ledger.getTotals('Europe/London', { fetchImpl });
    assert.deepEqual(t, { today: 25, total: 4812, firstAt: '2026-06-29T10:00:00+00:00', liveSince: null });
    const s = await ledger.getSeries('hour', '2026-09-27T23:00:00.000Z', '2026-09-28T23:00:00.000Z', 'Europe/London', { fetchImpl });
    assert.equal(s.length, 1); assert.equal(calls[1].body.bucket, 'hour'); assert.equal(calls[1].body.tz, 'Europe/London');
  });
});

test('upsertBackfill ignores duplicates by external id and counts what was stored', async () => {
  await withEnv({ url: 'https://db.supabase.co', key: 'svc' }, async () => {
    let seen;
    const rows = [{ action: 'add', external_id: 'e1' }, { action: 'add', external_id: 'e2' }];
    const reply = (body) => async (url, init) => { seen = { url, init }; return { ok: true, status: 201, text: async () => body }; };

    const first = await ledger.upsertBackfill(rows, { fetchImpl: reply('[{"id":1},{"id":2}]') });
    assert.deepEqual(first, { sent: 2, inserted: 2 });
    assert.ok(seen.url.endsWith('/scan_events?on_conflict=external_id&select=id'));
    assert.equal(seen.init.headers.Prefer, 'resolution=ignore-duplicates,return=representation');

    // A re-run over the same events must not claim to have imported them again.
    const again = await ledger.upsertBackfill(rows, { fetchImpl: reply('[]') });
    assert.deepEqual(again, { sent: 2, inserted: 0 });
  });
});

test('a request id makes the write idempotent, and is namespaced', async () => {
  await withEnv({ url: 'https://db.supabase.co', key: 'svc' }, async () => {
    let seen;
    const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, status: 201, text: async () => '' }; };

    await ledger.recordEvent({ action: 'add', memberId: 'M1', points: 3, requestId: 'scan:abc' }, { fetchImpl });
    assert.ok(seen.url.endsWith('/scan_events?on_conflict=external_id'), 'a retry must not become a second row');
    assert.equal(seen.init.headers.Prefer, 'resolution=ignore-duplicates,return=minimal');
    assert.equal(JSON.parse(seen.init.body)[0].external_id, 'scan:abc');

    // Without a key, behaviour is unchanged: every call is a row.
    await ledger.recordEvent({ action: 'lookup', memberId: 'M1' }, { fetchImpl });
    assert.ok(seen.url.endsWith('/scan_events'));
    assert.equal(seen.init.headers.Prefer, 'return=minimal');
    assert.equal(JSON.parse(seen.init.body)[0].external_id, null);
  });
});

test('the request id from the client is namespaced away from PassKit event ids', () => {
  const { requestKey } = require('../api/loyalty')._internals;
  assert.equal(requestKey({ request_id: 'abc-123' }), 'scan:abc-123');
  assert.equal(requestKey({ request_id: '  spaced  ' }), 'scan:spaced');
  assert.equal(requestKey({}), null);
  assert.equal(requestKey({ request_id: '' }), null);
  assert.equal(requestKey({ request_id: 42 }), null);
  assert.equal(requestKey({ request_id: 'x'.repeat(65) }), null, 'oversized means no key, not a truncated one');
});

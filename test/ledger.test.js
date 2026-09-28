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
    const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => (url.endsWith('/rpc/scan_totals') ? '[{"today":"25","total":"4812","first_at":"2026-06-29T10:00:00+00:00","live_since":null}]' : '[{"bucket_start":"2026-09-28T08:00:00+00:00","scans":"7","adds":"6","redeems":"1","points_added":"9"}]') }; };
    const t = await ledger.getTotals('Europe/London', { fetchImpl });
    assert.deepEqual(t, { today: 25, total: 4812, firstAt: '2026-06-29T10:00:00+00:00', liveSince: null });
    const s = await ledger.getSeries('hour', '2026-09-27T23:00:00.000Z', '2026-09-28T23:00:00.000Z', 'Europe/London', { fetchImpl });
    assert.equal(s.length, 1); assert.equal(calls[1].body.bucket, 'hour'); assert.equal(calls[1].body.tz, 'Europe/London');
  });
});

test('upsertBackfill ignores duplicates by external id', async () => {
  await withEnv({ url: 'https://db.supabase.co', key: 'svc' }, async () => {
    let seen;
    const n = await ledger.upsertBackfill([{ action: 'add', external_id: 'e1' }], { fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 201, text: async () => '' }; } });
    assert.equal(n, 1);
    assert.ok(seen.url.endsWith('/scan_events?on_conflict=external_id'));
    assert.equal(seen.init.headers.Prefer, 'resolution=ignore-duplicates,return=minimal');
  });
});

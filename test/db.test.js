const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDb, DbError } = require('../lib/db');

test('db client sends the service key and parses PostgREST answers', async () => {
  const seen = [];
  const db = createDb({ env: { SUPABASE_URL: 'https://x.supabase.co/', SUPABASE_SERVICE_KEY: 'svc' }, fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => '[{"id":"1"}]' }; } });
  assert.deepEqual(await db.selectOne('members', 'pass_serial=eq.LBM-1'), { id: '1' });
  assert.equal(seen[0].url, 'https://x.supabase.co/rest/v1/members?pass_serial=eq.LBM-1&limit=1');
  assert.equal(seen[0].init.headers.apikey, 'svc');
  await db.rpc('adjust_member_points', { p_member: 'a', p_delta: 1 });
  assert.equal(seen[1].url, 'https://x.supabase.co/rest/v1/rpc/adjust_member_points');
  assert.equal(seen[1].init.method, 'POST');
  await db.upsert('pass_registrations', [{ a: 1 }], 'device_library_id,pass_serial');
  assert.equal(seen[2].init.headers.Prefer, 'resolution=merge-duplicates,return=representation');
});

test('db client reports not-configured and error bodies', async () => {
  const off = createDb({ env: {} });
  assert.equal(off.enabled(), false);
  await assert.rejects(() => off.select('members', ''), (e) => e instanceof DbError && e.status === 0);
  const bad = createDb({ env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' }, fetchImpl: async () => ({ ok: false, status: 409, text: async () => '{"message":"duplicate key value"}' }) });
  await assert.rejects(() => bad.insert('members', {}), (e) => e instanceof DbError && e.status === 409 && /duplicate/.test(e.message));
});

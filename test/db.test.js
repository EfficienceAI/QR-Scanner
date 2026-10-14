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

test('a real stall produces the timeout code, not the not-configured one', async () => {
  // L7, through the actual abort path rather than the error class alone.
  const slow = createDb({
    env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' },
    timeoutMs: 5,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  });
  await assert.rejects(
    () => slow.select('members', 'id=eq.1'),
    (e) => e instanceof DbError && e.status === 0 && e.code === 'timeout' && e.retryable === true && /5ms/.test(e.message)
  );

  // And the missing-configuration path keeps its own code.
  await assert.rejects(
    () => createDb({ env: {} }).select('members', ''),
    (e) => e.code === 'not_configured' && e.retryable === false
  );
});

test('a timeout and a missing configuration are told apart', () => {
  // L7. Both arrive as status 0, and callers branched on that to report a
  // configuration error -- so a Supabase stall told staff mid-shift that the
  // deployment was broken, and the condition was never treated as retryable.
  const notConfigured = new DbError(0, 'database not configured', null, 'not_configured');
  assert.equal(notConfigured.code, 'not_configured');
  assert.equal(notConfigured.retryable, false);

  const timedOut = new DbError(0, 'database timeout after 6000ms', null, 'timeout');
  assert.equal(timedOut.code, 'timeout');
  assert.equal(timedOut.retryable, true, 'a stall is worth retrying; a missing env var is not');

  // status 0 still holds for both, so existing 503 mapping is unchanged.
  assert.equal(notConfigured.status, 0);
  assert.equal(timedOut.status, 0);
});

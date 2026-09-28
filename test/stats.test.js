const { test } = require('node:test');
const assert = require('node:assert/strict');
const T = require('../lib/time');
// The shop's clock is an environment setting, so pin it rather than inheriting
// whatever the machine has: the suite used to fail outright wherever
// SHOP_TIMEZONE was set to anything but London.
process.env.SHOP_TIMEZONE = 'Europe/London';
const { planRange, mergeSeries, summarize, buildStats } = require('../api/stats')._internals;

test('London midnight handles BST, GMT and the DST switch day', () => {
  assert.equal(T.localMidnight(2026, 9, 28, 'Europe/London').toISOString(), '2026-09-27T23:00:00.000Z'); // BST
  assert.equal(T.localMidnight(2026, 12, 1, 'Europe/London').toISOString(), '2026-12-01T00:00:00.000Z'); // GMT
  assert.equal(T.localMidnight(2026, 10, 25, 'Europe/London').toISOString(), '2026-10-24T23:00:00.000Z'); // clocks go back this day
  assert.equal(T.localMidnight(2026, 10, 26, 'Europe/London').toISOString(), '2026-10-26T00:00:00.000Z');
});

test('today = 24 hourly buckets between local midnights', () => {
  const p = planRange('today', '', '', new Date('2026-09-28T10:00:00Z'));
  assert.equal(p.bucket, 'hour');
  assert.equal(p.from.toISOString(), '2026-09-27T23:00:00.000Z');
  assert.equal(p.to.toISOString(), '2026-09-28T23:00:00.000Z');
  assert.equal(p.buckets.length, 24);
  assert.equal(p.buckets[0].key, '2026-09-28T00');
  assert.equal(p.buckets[9].label, '09:00');
});

test('week and month are trailing day buckets ending today', () => {
  const w = planRange('week', '', '', new Date('2026-09-28T10:00:00Z'));
  assert.equal(w.buckets.length, 7);
  assert.equal(w.buckets[0].key, '2026-09-22');
  assert.equal(w.buckets[6].key, '2026-09-28');
  assert.equal(w.buckets[6].label, 'Mon 28');
  const m = planRange('month', '', '', new Date('2026-09-28T10:00:00Z'));
  assert.equal(m.buckets.length, 30);
  assert.equal(m.buckets[0].key, '2026-08-30');
});

test('year = 12 month buckets; custom picks day or month buckets by span', () => {
  const y = planRange('year', '', '', new Date('2026-09-28T10:00:00Z'));
  assert.equal(y.bucket, 'month');
  assert.deepEqual([y.buckets[0].key, y.buckets[11].key], ['2025-10', '2026-09']);
  assert.equal(y.buckets[0].label, 'Oct 25');
  const c = planRange('custom', '2026-09-01', '2026-09-28');
  assert.equal(c.bucket, 'day'); assert.equal(c.buckets.length, 28);
  const long = planRange('custom', '2026-01-01', '2026-09-28');
  assert.equal(long.bucket, 'month'); assert.equal(long.buckets.length, 9);
  assert.ok(planRange('custom', '2026-09-28', '2026-09-01').error);
  assert.ok(planRange('custom', 'nope', '2026-09-01').error);
  assert.ok(planRange('decade', '', '').error);
});

test('a date that does not exist is rejected, not silently shifted', () => {
  // Each of these used to return 200 with a chart of zeros: the query moved to
  // the following month while the bucket kept the impossible label.
  for (const bad of ['2026-02-31', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-01-32']) {
    assert.ok(planRange('custom', bad, '2026-09-28').error, `${bad} should be rejected as "from"`);
    assert.ok(planRange('custom', '2026-01-01', bad).error, `${bad} should be rejected as "to"`);
  }
  assert.ok(!planRange('custom', '2024-02-29', '2024-03-01').error, 'a real leap day is fine');
  assert.ok(planRange('custom', '2026-02-29', '2026-03-01').error, '2026 is not a leap year');
});

test('series rows land in the right local bucket and gaps are zero-filled', () => {
  const p = planRange('today', '', '', new Date('2026-09-28T10:00:00Z'));
  const rows = [{ bucket_start: '2026-09-28T08:00:00+00:00', scans: '7', adds: '6', redeems: '1', points_stamped: '18', points_burned: '9' }];
  const s = mergeSeries(p, rows);
  assert.equal(s.length, 24);
  assert.deepEqual(s[9], { key: '2026-09-28T09', label: '09:00', scans: 7, adds: 6, redeems: 1, points: 18, pointsBurned: 9 });
  assert.equal(s[8].scans, 0);
  const sum = summarize(s);
  assert.equal(sum.scans, 7); assert.deepEqual(sum.peak, { key: '2026-09-28T09', label: '09:00', scans: 7 }); assert.equal(sum.avgPerBucket, 7);
});

test('buildStats composes totals and series', async () => {
  const r = await buildStats('week', '', '', {
    now: new Date('2026-09-28T10:00:00Z'),
    getSeries: async (bucket, from, to) => { assert.equal(bucket, 'day'); assert.equal(from, '2026-09-21T23:00:00.000Z'); return [{ bucket_start: '2026-09-27T23:00:00+00:00', scans: 25, adds: 24, redeems: 3, points_stamped: 30, points_burned: 27 }]; },
    getTotals: async () => ({ today: 25, total: 4812, firstAt: '2026-06-29T10:00:00Z', liveSince: '2026-09-28T09:00:00Z' }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.today, 25); assert.equal(r.body.total, 4812);
  assert.equal(r.body.series[6].scans, 25); assert.equal(r.body.summary.scans, 25);
});

test('the stats cache is capped and drops the least recently used entry', () => {
  const { cacheGet, cachePut, cache, CACHE_MAX } = require('../api/stats')._internals;
  cache.clear();
  const put = (key) => cachePut(key, { at: Date.now(), ttl: 120000, status: 200, data: { key } });

  for (let i = 0; i < CACHE_MAX + 20; i++) put(`custom|2026-01-01|day-${i}`);
  assert.equal(cache.size, CACHE_MAX, 'an unauthenticated range parameter cannot grow this without bound');
  assert.equal(cacheGet('custom|2026-01-01|day-0'), null, 'the oldest entries are gone');
  assert.ok(cacheGet(`custom|2026-01-01|day-${CACHE_MAX + 19}`), 'the newest is still there');

  // A hit refreshes recency, so a key that keeps being read survives.
  const hot = 'today||';
  put(hot);
  for (let i = 0; i < CACHE_MAX - 1; i++) { assert.ok(cacheGet(hot)); put(`filler-${i}`); }
  assert.ok(cacheGet(hot), 'the key being read every time is the last to go');

  cache.clear();
  put('stale');
  cache.get('stale').at = Date.now() - 200000; // older than its ttl
  assert.equal(cacheGet('stale'), null, 'expired entries are dropped, not served');
  assert.equal(cache.size, 0);
});

test('the shop timezone is honoured per request, not captured at import', () => {
  const prev = process.env.SHOP_TIMEZONE;
  try {
    process.env.SHOP_TIMEZONE = 'Pacific/Auckland';
    const p = planRange('today', '', '', new Date('2026-09-28T10:00:00Z'));
    assert.equal(p.from.toISOString(), '2026-09-27T11:00:00.000Z', 'local midnight in NZDT');
    assert.equal(p.to.toISOString(), '2026-09-28T11:00:00.000Z');
    process.env.SHOP_TIMEZONE = 'Europe/London';
    assert.equal(planRange('today', '', '', new Date('2026-09-28T10:00:00Z')).from.toISOString(), '2026-09-27T23:00:00.000Z');
  } finally {
    process.env.SHOP_TIMEZONE = prev;
  }
});

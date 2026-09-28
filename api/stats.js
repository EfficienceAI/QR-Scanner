'use strict';

/**
 * GET /api/stats?range=today|week|month|year|custom[&from=YYYY-MM-DD&to=YYYY-MM-DD]
 * Counts and a time series from our own ledger, bucketed on the shop's clock.
 */

const ledger = require('../lib/ledger');
const T = require('../lib/time');
const auth = require('../lib/auth');

const TZ = process.env.SHOP_TIMEZONE || 'Europe/London';

/**
 * Response cache, keyed by range + window.
 *
 * Fluid Compute reuses an instance across requests, so this outlives a single
 * call: with `custom` accepting any pair of dates and nothing evicting, it was
 * a Map that only ever grew, each entry up to 366 buckets. Capped and
 * least-recently-used from here on. A Map iterates in insertion order, so
 * re-inserting on a hit is enough to make the first key the oldest.
 */
const CACHE_MAX = 50;
const cache = new Map(); // key -> { at, ttl, status, data }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= hit.ttl) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cachePut(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

/**
 * A calendar date that exists, or null.
 *
 * Checking the ranges of the parts was not enough: 2026-02-31 passed, then
 * addDays rolled it forward, so the query asked for 3 March while the bucket
 * was still labelled "2026-02-31". Nothing matched that label, mergeSeries
 * dropped the row, and a day with real traffic came back as HTTP 200 with
 * zeros. A wrong answer where an error belongs.
 */
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() + 1 !== mo || probe.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

/** Work out the window and the buckets for a range, on the shop's clock. */
function planRange(range, fromQ, toQ, now = new Date()) {
  const today = T.localParts(now, TZ);
  const todayKey = { y: today.y, m: today.m, d: today.d };
  const tomorrow = T.addDays(today.y, today.m, today.d, 1);

  if (range === 'today') {
    const from = T.localMidnight(today.y, today.m, today.d, TZ);
    const to = T.localMidnight(tomorrow.y, tomorrow.m, tomorrow.d, TZ);
    const buckets = [];
    for (let h = 0; h < 24; h += 1) buckets.push({ key: `${T.dateKey(todayKey)}T${T.pad(h)}`, label: `${T.pad(h)}:00` });
    return { range, bucket: 'hour', from, to, buckets, keyOf: (parts) => `${T.dateKey(parts)}T${T.pad(parts.h)}` };
  }

  if (range === 'week' || range === 'month' || (range === 'custom' && fromQ && toQ)) {
    let start, endExclusive;
    if (range === 'custom') {
      const f = parseDate(fromQ), t = parseDate(toQ);
      if (!f || !t) return { error: 'from and to must be YYYY-MM-DD' };
      start = f;
      endExclusive = T.addDays(t.y, t.m, t.d, 1);
      const days = Math.round((Date.UTC(endExclusive.y, endExclusive.m - 1, endExclusive.d) - Date.UTC(f.y, f.m - 1, f.d)) / 86400000);
      if (days <= 0) return { error: 'to must be on or after from' };
      if (days > 366 * 5) return { error: 'range too long' };
      if (days > 120) return planMonths(f, t, 'custom');
    } else {
      start = T.addDays(today.y, today.m, today.d, range === 'week' ? -6 : -29);
      endExclusive = tomorrow;
    }
    const buckets = [];
    for (let c = start; T.dateKey(c) < T.dateKey(endExclusive); c = T.addDays(c.y, c.m, c.d, 1)) {
      buckets.push({ key: T.dateKey(c), label: T.dayLabel(c) });
    }
    return {
      range, bucket: 'day',
      from: T.localMidnight(start.y, start.m, start.d, TZ),
      to: T.localMidnight(endExclusive.y, endExclusive.m, endExclusive.d, TZ),
      buckets, keyOf: (parts) => T.dateKey(parts),
    };
  }

  if (range === 'year') {
    const first = T.addMonths(today.y, today.m, -11);
    return planMonths({ y: first.y, m: first.m, d: 1 }, todayKey, 'year');
  }
  return { error: 'range must be today, week, month, year or custom (with from and to)' };
}

function planMonths(fromParts, toParts, range) {
  const start = { y: fromParts.y, m: fromParts.m };
  const endExclusive = T.addMonths(toParts.y, toParts.m, 1);
  const buckets = [];
  for (let c = start; T.monthKey(c) < T.monthKey(endExclusive); c = T.addMonths(c.y, c.m, 1)) {
    buckets.push({ key: T.monthKey(c), label: T.monthLabel(c) });
  }
  return {
    range, bucket: 'month',
    from: T.localMidnight(start.y, start.m, 1, TZ),
    to: T.localMidnight(endExclusive.y, endExclusive.m, 1, TZ),
    buckets, keyOf: (parts) => T.monthKey(parts),
  };
}

function mergeSeries(plan, rows) {
  const byKey = new Map(plan.buckets.map((b) => [b.key, { ...b, scans: 0, adds: 0, redeems: 0, points: 0 }]));
  for (const r of rows) {
    const parts = T.localParts(new Date(r.bucket_start), TZ);
    const key = plan.keyOf(parts);
    const slot = byKey.get(key);
    if (!slot) continue;
    slot.scans = Number(r.scans) || 0;
    slot.adds = Number(r.adds) || 0;
    slot.redeems = Number(r.redeems) || 0;
    slot.points = Number(r.points_added) || 0;
  }
  return [...byKey.values()];
}

function summarize(series) {
  const scans = series.reduce((n, b) => n + b.scans, 0);
  const nonEmpty = series.filter((b) => b.scans > 0);
  const peak = series.reduce((best, b) => (b.scans > (best ? best.scans : -1) ? b : best), null);
  return {
    scans,
    adds: series.reduce((n, b) => n + b.adds, 0),
    redeems: series.reduce((n, b) => n + b.redeems, 0),
    avgPerBucket: nonEmpty.length ? Math.round((scans / nonEmpty.length) * 10) / 10 : 0,
    peak: peak && peak.scans > 0 ? { key: peak.key, label: peak.label, scans: peak.scans } : null,
  };
}

async function buildStats(range, fromQ, toQ, deps = {}) {
  const plan = planRange(range, fromQ, toQ, deps.now);
  if (plan.error) return { status: 400, body: { ok: false, error: 'bad_range', message: plan.error } };
  const [rows, totals] = await Promise.all([
    (deps.getSeries || ledger.getSeries)(plan.bucket, plan.from.toISOString(), plan.to.toISOString(), TZ),
    (deps.getTotals || ledger.getTotals)(TZ),
  ]);
  const series = mergeSeries(plan, rows);
  return {
    status: 200,
    body: {
      ok: true,
      range: plan.range, bucket: plan.bucket, tz: TZ,
      from: plan.from.toISOString(), to: plan.to.toISOString(),
      today: totals.today, total: totals.total, firstAt: totals.firstAt, liveSince: totals.liveSince,
      series, summary: summarize(series),
      generatedAt: new Date().toISOString(),
    },
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return send(res, 405, { ok: false, error: 'method_not_allowed' });
  }
  // Takings-adjacent numbers (volumes, trading hours, the day the shop opened)
  // are staff-only, and an open endpoint is also an open cache key.
  const gate = auth.requireStaff(req);
  if (gate) return send(res, gate.status, gate.body);

  const url = new URL(req.url, 'http://x');
  const range = (url.searchParams.get('range') || 'today').toLowerCase();
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  const key = `${range}|${from}|${to}`;
  const ttl = range === 'today' ? 20_000 : 120_000;
  const hit = cacheGet(key);
  if (hit) return send(res, hit.status, { ...hit.data, cached: true });

  try {
    const { status, body } = await buildStats(range, from, to);
    if (status === 200) cachePut(key, { at: Date.now(), ttl, status, data: body });
    return send(res, status, body);
  } catch (err) {
    console.log(JSON.stringify({ src: 'loyalty-stats', error: err.name, status: err.status, message: err.message }));
    if (err.name === 'LedgerError' && err.status === 0) {
      return send(res, 503, { ok: false, error: 'not_configured', message: 'Scan ledger is not configured yet.' });
    }
    return send(res, 502, { ok: false, error: 'ledger_error', message: err.message });
  }
};

module.exports._internals = { planRange, mergeSeries, summarize, buildStats, cacheGet, cachePut, cache, CACHE_MAX };

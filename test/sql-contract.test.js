const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * The bucketing moved half into the database, and nothing here can run
 * Postgres: a date_trunc or `at time zone` mistake in a migration passes every
 * other test in this suite, because they feed mergeSeries hand-written rows.
 *
 * These tests do not close that gap -- only running the SQL does. What they do
 * close is drift: the JS names the RPCs' parameters and reads their columns by
 * hand, so renaming one side and not the other is a silent 500 in production
 * (and a rename is exactly what migration 003 does). They also check that the
 * "what counts as a scan" predicate is written identically everywhere it
 * appears, which is the cost of having inlined it for the query planner.
 */

const DIR = path.join(__dirname, '..', 'supabase', 'migrations');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const SQL = FILES.map((f) => fs.readFileSync(path.join(DIR, f), 'utf8')).join('\n\n');

const names = (list) =>
  list
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);

/** The last definition of a function wins, as it would when the files are run in order. */
function signature(fn) {
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(([^)]*)\\)\\s*returns\\s+table\\s*\\(([^)]*)\\)`, 'gi');
  let m, last = null;
  while ((m = re.exec(SQL)) !== null) last = m;
  assert.ok(last, `no definition of public.${fn} found in ${FILES.join(', ')}`);
  return { params: names(last[1]), columns: names(last[2]) };
}

test('scan_series takes the parameters lib/ledger sends', () => {
  const { params } = signature('scan_series');
  // lib/ledger.getSeries posts { bucket, from_ts, to_ts, tz } as named arguments.
  assert.deepEqual(params, ['bucket', 'from_ts', 'to_ts', 'tz']);
});

test('scan_series returns the columns api/stats reads', () => {
  const { columns } = signature('scan_series');
  for (const needed of ['bucket_start', 'scans', 'adds', 'redeems', 'points_stamped', 'points_burned']) {
    assert.ok(columns.includes(needed), `mergeSeries reads r.${needed}, which the function no longer returns`);
  }
  assert.ok(!columns.includes('points_added'), 'points_added was renamed in 003; nothing should reintroduce it');
});

test('scan_totals takes tz and returns the columns lib/ledger maps', () => {
  const { params, columns } = signature('scan_totals');
  assert.deepEqual(params, ['tz']);
  for (const needed of ['today', 'total', 'first_at', 'live_since']) {
    assert.ok(columns.includes(needed), `getTotals maps r.${needed}`);
  }
});

test('every action the code writes is allowed by the table constraint', () => {
  // api/loyalty writes these four; api/admin/backfill writes add and redeem.
  const written = ['lookup', 'add', 'remove', 'redeem'];
  const m = /action\s+text\s+not\s+null\s+check\s*\(\s*action\s+in\s*\(([^)]*)\)/i.exec(SQL);
  assert.ok(m, 'no check constraint on scan_events.action');
  const allowed = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(allowed.slice().sort(), written.slice().sort());
});

test('the scan predicate is identical everywhere it is written out', () => {
  // Inlined for the planner (see 003), which means four copies to keep in step:
  // the partial index, scan_series, and both counts in scan_totals.
  const re = /(?:e\.)?action = 'lookup'\s+or\s+\((?:e\.)?source = 'passkit-backfill' and (?:e\.)?action in \('add', 'redeem'\)\)/gi;
  const found = (SQL.match(re) || []).map((s) => s.replace(/\be\./g, '').replace(/\s+/g, ' '));
  assert.equal(found.length, 4, 'expected the predicate in the index, scan_series and both scan_totals counts');
  for (const copy of found) assert.equal(copy, found[0], 'the copies of the scan predicate have drifted apart');
});

test('points is nullable, so an unknown backfill amount is not stored as zero', () => {
  assert.match(SQL, /alter\s+column\s+points\s+drop\s+not\s+null/i);
});

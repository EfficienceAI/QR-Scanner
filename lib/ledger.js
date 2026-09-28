'use strict';

/**
 * Our own scan ledger in Supabase (table scan_events + two RPCs, see
 * supabase/migrations). Talks to PostgREST directly with the service key,
 * so no client library is needed. Recording never throws: a ledger outage
 * must never break a scan. Callers must also respond before they record, so
 * an outage cannot slow one down either (see respondThenRecord in
 * api/loyalty.js).
 */

class LedgerError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = 'LedgerError';
    this.status = status;
    this.body = body;
  }
}

function settings() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY || '';
  return { url, key, enabled: Boolean(url && key) };
}

/**
 * Ceiling on one PostgREST call. For writes this only bounds how long an
 * invocation lingers after its response; for the stats reads it is how long
 * the chart waits before saying "unavailable". Either way, well inside the
 * function's maxDuration.
 */
function defaultTimeoutMs() {
  const n = parseInt(process.env.LEDGER_TIMEOUT_MS || '', 10);
  return Number.isInteger(n) && n > 0 ? n : 4000;
}

async function rest(path, { method = 'GET', body, prefer, fetchImpl = fetch, timeoutMs = defaultTimeoutMs() } = {}) {
  const { url, key, enabled } = settings();
  if (!enabled) throw new LedgerError(0, 'ledger not configured (SUPABASE_URL / SUPABASE_SERVICE_KEY)');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    const resp = await fetchImpl(`${url}/rest/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await resp.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text.slice(0, 300) };
    }
    if (!resp.ok) throw new LedgerError(resp.status, (data && (data.message || data.hint)) || `ledger ${resp.status}`, data);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Append one event. Returns true when stored, false otherwise; never throws.
 *
 * `requestId` makes the write idempotent. Live rows had no key at all, so a
 * staff retry after a lost response -- the client cannot tell a dropped reply
 * from a rejected one -- recorded the same visit twice and inflated the scan
 * count. One intent is one row: PassKit's own event log remains the record of
 * what PassKit actually did.
 */
async function recordEvent({ action, memberId, points = 0, occurredAt, source = 'scanner', requestId = null }, opts = {}) {
  if (!settings().enabled) return false;
  try {
    await rest(requestId ? '/scan_events?on_conflict=external_id' : '/scan_events', {
      method: 'POST',
      prefer: requestId ? 'resolution=ignore-duplicates,return=minimal' : 'return=minimal',
      body: [{
        action,
        member_id: memberId || null,
        points: Number(points) || 0,
        occurred_at: occurredAt || new Date().toISOString(),
        source,
        external_id: requestId || null,
      }],
      ...opts,
    });
    return true;
  } catch (err) {
    if (opts.log) opts.log({ warn: 'ledger_failed', action, status: err.status, message: err.message });
    return false;
  }
}

async function getSeries(bucket, fromIso, toIso, tz = 'Europe/London', opts = {}) {
  const rows = await rest('/rpc/scan_series', { method: 'POST', body: { bucket, from_ts: fromIso, to_ts: toIso, tz }, ...opts });
  return Array.isArray(rows) ? rows : [];
}

async function getTotals(tz = 'Europe/London', opts = {}) {
  const rows = await rest('/rpc/scan_totals', { method: 'POST', body: { tz }, ...opts });
  const r = Array.isArray(rows) ? rows[0] : rows;
  return {
    today: Number((r && r.today) || 0),
    total: Number((r && r.total) || 0),
    firstAt: (r && r.first_at) || null,
    liveSince: (r && r.live_since) || null,
  };
}

/**
 * Insert backfill rows, ignoring any PassKit event id already present.
 *
 * Returns { sent, inserted }. return=minimal used to mean there was no body
 * to count, so the caller could only report how many rows it had sent: a
 * second run over the same events claimed to import them all again, while
 * every one was in fact ignored as a duplicate. Asking for the stored ids
 * back (select=id keeps the body small) makes "inserted" the truth.
 */
async function upsertBackfill(rows, opts = {}) {
  if (!rows.length) return { sent: 0, inserted: 0 };
  const stored = await rest('/scan_events?on_conflict=external_id&select=id', {
    method: 'POST',
    prefer: 'resolution=ignore-duplicates,return=representation',
    body: rows,
    ...opts,
  });
  return { sent: rows.length, inserted: Array.isArray(stored) ? stored.length : 0 };
}

module.exports = { recordEvent, getSeries, getTotals, upsertBackfill, LedgerError, _internals: { settings, rest } };

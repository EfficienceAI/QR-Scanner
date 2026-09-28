'use strict';

/**
 * POST /api/admin/backfill?offset=0&pages=3[&dryRun=1]
 * One-off: copies PassKit's programme event log (stamps and redemptions from
 * before our ledger went live) into scan_events, so "total" includes the
 * Make.com era. Idempotent (PassKit event id is the unique key). Gated by
 * ADMIN_SECRET in the x-admin-secret header. Resumable via `offset`.
 *
 * Run it with dryRun=1 first: nothing is written, and the response carries a
 * sample of the real event payloads with the amount we read out of each, which
 * is the only way to confirm how the old system wrote its notes.
 */

const passkit = require('../../lib/passkit');
const ledger = require('../../lib/ledger');

const PAGE = 1000;
const EARN = 'EVENT_MEMBER_POINTS_EARNED';
const BURN = 'EVENT_MEMBER_POINTS_BURNED';

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^[+-]?\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

/** An amount in a free-text note, with or without a sign. null when absent. */
function pointsFromNotes(notes) {
  const m = /([+-]?)\s*(\d+)\s*point/i.exec(String(notes || ''));
  return m ? Number(m[2]) : null;
}

/**
 * How many points one historical event moved.
 *
 * Returns null when it cannot be read. The notes on Make.com-era events were
 * written by a system that is gone, and its format is not known here: a
 * structured field is trusted first, then a number next to the word "point"
 * with or without a sign (the direction comes from eventType, so requiring a
 * sign only threw amounts away). Guessing 0 -- or the redeem cost -- would
 * import thousands of rows that quietly claim the wrong thing, so an unknown
 * amount is stored as unknown and stays visible.
 */
function pointsFromEvent(e) {
  const candidates = [
    e && e.points,
    e && e.pointsEarned,
    e && e.pointsBurned,
    e && e.eventDetails && e.eventDetails.points,
    e && e.metaData && e.metaData.points,
  ];
  for (const c of candidates) {
    const n = num(c);
    if (n !== null) return Math.abs(n);
  }
  return pointsFromNotes(e && e.notes);
}

async function programId() {
  if (process.env.PASSKIT_PROGRAM_ID) return process.env.PASSKIT_PROGRAM_ID;
  const programs = await passkit.listPrograms();
  if (!programs.length) throw new Error('no PassKit programme found');
  return programs[0].id;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { ok: false, error: 'method_not_allowed' });
  }
  const secret = process.env.ADMIN_SECRET || '';
  if (!secret) return send(res, 503, { ok: false, error: 'not_configured', message: 'ADMIN_SECRET is not set.' });
  if (req.headers['x-admin-secret'] !== secret) return send(res, 401, { ok: false, error: 'unauthorized' });

  const url = new URL(req.url, 'http://x');
  let offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);
  const pages = Math.min(10, Math.max(1, parseInt(url.searchParams.get('pages') || '3', 10) || 3));
  const dryRun = /^(1|true|yes)$/i.test(url.searchParams.get('dryRun') || '');
  const started = Date.now();

  try {
    const pid = await programId();
    // Never import anything our live ledger has already recorded itself.
    const totals = await ledger.getTotals();
    const cutoff = totals.liveSince ? Date.parse(totals.liveSince) : Date.now();

    let imported = 0, sent = 0, seen = 0, skippedAfterCutoff = 0, skippedOther = 0, unknownPoints = 0, done = false;
    const samples = [];
    for (let p = 0; p < pages; p += 1) {
      const events = await passkit.listProgramEvents(pid, { limit: PAGE, offset });
      seen += events.length;
      const rows = [];
      for (const e of events) {
        const at = Date.parse(e.date || e.created || '');
        if (!Number.isFinite(at)) { skippedOther += 1; continue; }
        if (at >= cutoff) { skippedAfterCutoff += 1; continue; }
        if (e.eventType !== EARN && e.eventType !== BURN) { skippedOther += 1; continue; }
        const points = pointsFromEvent(e);
        if (points === null) unknownPoints += 1;
        if (samples.length < 10) samples.push({ eventType: e.eventType, notes: String(e.notes || '').slice(0, 120), read: points });
        rows.push({
          action: e.eventType === EARN ? 'add' : 'redeem',
          points,
          member_id: (e.member && e.member.id) || null,
          occurred_at: new Date(at).toISOString(),
          source: 'passkit-backfill',
          external_id: e.id || `${(e.member && e.member.id) || 'x'}:${at}:${e.eventType}`,
        });
      }
      if (dryRun) {
        sent += rows.length; // what a real run would have offered the ledger
      } else {
        for (let i = 0; i < rows.length; i += 500) {
          const wrote = await ledger.upsertBackfill(rows.slice(i, i + 500));
          sent += wrote.sent;
          imported += wrote.inserted;
        }
      }
      offset += events.length;
      if (events.length < PAGE) { done = true; break; }
    }
    // `sent` is what we offered the ledger, `imported` what it actually stored:
    // on a second run over the same events imported is 0 and that is correct.
    const body = { ok: true, dryRun, programId: pid, cutoff: new Date(cutoff).toISOString(), seen, sent, imported, skippedAfterCutoff, skippedOther, unknownPoints, samples, nextOffset: offset, done, ms: Date.now() - started };
    console.log(JSON.stringify({ src: 'loyalty-backfill', ...body }));
    return send(res, 200, body);
  } catch (err) {
    console.log(JSON.stringify({ src: 'loyalty-backfill', error: err.name, status: err.status, message: err.message }));
    return send(res, 502, { ok: false, error: 'backfill_failed', message: err.message, nextOffset: offset });
  }
};

module.exports._internals = { pointsFromEvent, pointsFromNotes, num };

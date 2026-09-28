'use strict';

/**
 * POST /api/admin/backfill?offset=0&pages=3
 * One-off: copies PassKit's programme event log (stamps and redemptions from
 * before our ledger went live) into scan_events, so "total" includes the
 * Make.com era. Idempotent (PassKit event id is the unique key). Gated by
 * ADMIN_SECRET in the x-admin-secret header. Resumable via `offset`.
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

function pointsFromNotes(e) {
  const m = /([+-])\s*(\d+)\s*point/i.exec((e && e.notes) || '');
  return m ? Number(m[2]) : 0;
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
  const started = Date.now();

  try {
    const pid = await programId();
    // Never import anything our live ledger has already recorded itself.
    const totals = await ledger.getTotals();
    const cutoff = totals.liveSince ? Date.parse(totals.liveSince) : Date.now();

    let imported = 0, seen = 0, skippedAfterCutoff = 0, skippedOther = 0, done = false;
    for (let p = 0; p < pages; p += 1) {
      const events = await passkit.listProgramEvents(pid, { limit: PAGE, offset });
      seen += events.length;
      const rows = [];
      for (const e of events) {
        const at = Date.parse(e.date || e.created || '');
        if (!Number.isFinite(at)) { skippedOther += 1; continue; }
        if (at >= cutoff) { skippedAfterCutoff += 1; continue; }
        if (e.eventType !== EARN && e.eventType !== BURN) { skippedOther += 1; continue; }
        rows.push({
          action: e.eventType === EARN ? 'add' : 'redeem',
          points: e.eventType === EARN ? pointsFromNotes(e) : (pointsFromNotes(e) || 9),
          member_id: (e.member && e.member.id) || null,
          occurred_at: new Date(at).toISOString(),
          source: 'passkit-backfill',
          external_id: e.id || `${(e.member && e.member.id) || 'x'}:${at}:${e.eventType}`,
        });
      }
      for (let i = 0; i < rows.length; i += 500) imported += await ledger.upsertBackfill(rows.slice(i, i + 500));
      offset += events.length;
      if (events.length < PAGE) { done = true; break; }
    }
    const body = { ok: true, programId: pid, cutoff: new Date(cutoff).toISOString(), seen, imported, skippedAfterCutoff, skippedOther, nextOffset: offset, done, ms: Date.now() - started };
    console.log(JSON.stringify({ src: 'loyalty-backfill', ...body }));
    return send(res, 200, body);
  } catch (err) {
    console.log(JSON.stringify({ src: 'loyalty-backfill', error: err.name, status: err.status, message: err.message }));
    return send(res, 502, { ok: false, error: 'backfill_failed', message: err.message, nextOffset: offset });
  }
};

'use strict';

/**
 * POST /api/admin/import  { members: [ { passkit_member_id, full_name, email, phone, points, pass_serial? } ], dry_run? }
 * header: x-admin-secret
 *
 * Brings PassKit members into our members table ahead of the switch-over.
 * Nothing is sent to anyone. Rules:
 *  - keyed on passkit_member_id: re-running updates name, phone and points
 *    and never duplicates (unchanged rows are left alone);
 *  - a member who already joined natively with the same email is LINKED
 *    (passkit_member_id set on their existing row) rather than duplicated,
 *    and their own balance is left alone on every run;
 *  - an email already held by a different PassKit member is dropped from the
 *    second row (emails are unique here) and reported, so that person still
 *    gets their pass;
 *  - pass_serial defaults to the PassKit member id, so the pass we later
 *    issue replaces the PassKit card in place.
 * Up to 500 rows a call, a few database round trips per call. The local
 * script scripts/import-passkit.mjs feeds it from PassKit's CSV export.
 */

const crypto = require('crypto');
const members = require('../../lib/members');
const { db: defaultDb } = require('../../lib/db');

const MAX_ROWS = 500;
const LOOKUP_CHUNK = 100;
const INSERT_CHUNK = 100;

function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  if (req.body == null) return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body); } catch { return {}; }
}
function authorized(req, secret) {
  const given = String((req.headers && req.headers['x-admin-secret']) || '');
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}
function inList(values) {
  return encodeURIComponent(`(${values.map((v) => `"${String(v).replace(/"/g, '')}"`).join(',')})`);
}
function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Validate and normalise one exported row. Returns { ok, row } or { ok: false, reason }. */
function prepare(input) {
  const passkitId = String(input.passkit_member_id || '').trim();
  if (!/^[A-Za-z0-9_-]{10,40}$/.test(passkitId)) return { ok: false, reason: 'bad passkit_member_id' };
  const fullName = String(input.full_name || '').trim().replace(/\s+/g, ' ');
  if (fullName.length < 1) return { ok: false, reason: 'missing name' };
  const email = members.normalizeEmail(input.email);
  const phone = members.normalizePhone(input.phone);
  const pointsRaw = input.points === '' || input.points == null ? 0 : Number(input.points);
  const points = Number.isFinite(pointsRaw) ? Math.max(0, Math.round(pointsRaw)) : 0;
  const serial = String(input.pass_serial || passkitId).trim();
  return { ok: true, row: { passkit_member_id: passkitId, full_name: fullName.slice(0, 80), email, phone, points, pass_serial: serial } };
}

function createHandler(deps = {}) {
  const db = deps.db || defaultDb;

  async function byPasskitId(ids) {
    const map = new Map();
    for (const part of chunks(ids, LOOKUP_CHUNK)) {
      const rows = await db.select('members', `passkit_member_id=in.${inList(part)}&select=id,passkit_member_id,full_name,phone,points,email_norm,source`);
      for (const r of rows || []) map.set(r.passkit_member_id, r);
    }
    return map;
  }
  async function byEmail(emails) {
    const map = new Map();
    for (const part of chunks(emails, LOOKUP_CHUNK)) {
      const rows = await db.select('members', `email_norm=in.${inList(part)}&select=id,email_norm,passkit_member_id`);
      for (const r of rows || []) map.set(r.email_norm, r);
    }
    return map;
  }
  async function insertAll(rows) {
    // One request per chunk; PostgREST applies a chunk atomically, so a
    // refused chunk is retried row by row and the refused rows reported.
    const failed = [];
    for (const part of chunks(rows, INSERT_CHUNK)) {
      try {
        await db.rest('/members', { method: 'POST', body: part, prefer: 'return=minimal' });
      } catch (err) {
        for (const row of part) {
          try { await db.rest('/members', { method: 'POST', body: [row], prefer: 'return=minimal' }); } catch (e) { failed.push({ passkit_member_id: row.passkit_member_id, reason: e.message }); }
        }
      }
    }
    return failed;
  }

  return async function handler(req, res) {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, 405, { ok: false, error: 'method_not_allowed' }); }
    const secret = (deps.env || process.env).ADMIN_SECRET || '';
    if (!secret) return send(res, 503, { ok: false, error: 'not_configured', message: 'ADMIN_SECRET is not set.' });
    if (!authorized(req, secret)) return send(res, 401, { ok: false, error: 'unauthorized' });
    if (!db.enabled()) return send(res, 503, { ok: false, error: 'not_configured', message: 'The members database is not configured yet.' });

    const body = readBody(req);
    const list = Array.isArray(body.members) ? body.members : null;
    if (!list || !list.length || list.length > MAX_ROWS) return send(res, 400, { ok: false, error: 'invalid', message: `Send 1 to ${MAX_ROWS} members.` });
    const dryRun = body.dry_run === true;

    const summary = { received: list.length, created: 0, updated: 0, unchanged: 0, linked: 0, skipped: 0, email_dropped: 0, dry_run: dryRun, problems: [] };
    const problem = (id, reason) => { if (summary.problems.length < 50) summary.problems.push({ passkit_member_id: id || null, reason }); };
    const log = (f) => console.log(JSON.stringify({ src: 'admin-import', ...f }));
    const now = () => new Date().toISOString();

    try {
      // 1. validate; one row per PassKit id within the call (last wins)
      const rows = new Map();
      for (const input of list) {
        const p = prepare(input);
        if (!p.ok) { summary.skipped += 1; problem(input && input.passkit_member_id, p.reason); continue; }
        rows.set(p.row.passkit_member_id, p.row);
      }
      // 2. already imported: update what changed
      const existing = await byPasskitId([...rows.keys()]);
      const fresh = [];
      for (const row of rows.values()) {
        const cur = existing.get(row.passkit_member_id);
        if (!cur) { fresh.push(row); continue; }
        // A native joiner we linked keeps their own name, phone and balance:
        // only rows that came from PassKit follow the PassKit export.
        if (cur.source !== 'passkit-import') { summary.unchanged += 1; continue; }
        const patch = {};
        if (cur.full_name !== row.full_name) patch.full_name = row.full_name;
        if ((cur.phone || null) !== (row.phone || null)) patch.phone = row.phone;
        if (Number(cur.points) !== row.points) patch.points = row.points;
        if (!Object.keys(patch).length) { summary.unchanged += 1; continue; }
        summary.updated += 1;
        if (!dryRun) {
          if (patch.points !== undefined) patch.pass_updated_at = now();
          await db.update('members', `id=eq.${encodeURIComponent(cur.id)}`, { ...patch, updated_at: now() });
        }
      }
      // 3. emails already in the table: link a native joiner, or drop the email
      const taken = await byEmail(fresh.map((r) => r.email).filter(Boolean));
      const seen = new Set();
      const toInsert = [];
      for (const row of fresh) {
        if (row.email) {
          const hit = taken.get(row.email);
          if (hit && !hit.passkit_member_id) {
            summary.linked += 1;
            if (!dryRun) await db.update('members', `id=eq.${encodeURIComponent(hit.id)}`, { passkit_member_id: row.passkit_member_id, updated_at: now() });
            continue;
          }
          if (hit || seen.has(row.email)) {
            summary.email_dropped += 1;
            problem(row.passkit_member_id, `email ${row.email} already belongs to another PassKit member; imported without it`);
            row.email = null;
          } else {
            seen.add(row.email);
          }
        }
        toInsert.push(row);
      }
      // 4. create the rest
      summary.created += toInsert.length;
      if (!dryRun && toInsert.length) {
        const failed = await insertAll(toInsert.map((row) => members.newMemberRow({
          full_name: row.full_name, email: row.email, phone: row.phone, consent_marketing: false,
          source: 'passkit-import', passkit_member_id: row.passkit_member_id, points: row.points,
        }, { serial: row.pass_serial })));
        summary.created -= failed.length;
        summary.skipped += failed.length;
        for (const f of failed) problem(f.passkit_member_id, `not inserted: ${f.reason}`);
      }
      log({ event: dryRun ? 'dry_run' : 'imported', ...summary, problems: summary.problems.length });
      return send(res, 200, { ok: true, ...summary });
    } catch (err) {
      log({ event: 'failed', status: err.status, message: err.message, ...summary, problems: summary.problems.length });
      return send(res, err.status === 0 ? 503 : 502, { ok: false, error: 'db_error', message: err.message, progress: summary });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports._internals = { prepare, inList };

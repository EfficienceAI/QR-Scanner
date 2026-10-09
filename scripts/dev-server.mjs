#!/usr/bin/env node
/**
 * Local dev server.
 *
 * Serves public/ and dispatches /api/* to the same handler files Vercel runs,
 * so the whole app works at http://localhost:3000 with no build step and no
 * Vercel CLI.
 *
 *   node scripts/dev-server.mjs           # real PassKit + Supabase (needs env vars)
 *   node scripts/dev-server.mjs --mock    # everything stubbed in memory
 *   node scripts/dev-server.mjs --mock --port 4000
 *
 * --mock is the one to use for testing: no credentials, no real customer
 * balance moved, a year of invented scan history so the chart has something to
 * draw, and Make.com-style event notes so the backfill dry run has real-looking
 * text to parse. Any QR code at all will work -- an id the mock does not know
 * becomes a member with a balance derived from the string, so you can point the
 * webcam at whatever QR is lying around.
 *
 * What --mock does NOT test: the SQL. The two reporting functions are
 * reimplemented in JavaScript below, so a mistake in a migration cannot show up
 * here. Only running the migrations against Postgres does that.
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const args = process.argv.slice(2);
const SELFTEST = args.includes('--selftest');
const MOCK = args.includes('--mock') || SELFTEST;
const portIdx = args.indexOf('--port');
const PORT = portIdx >= 0 ? Number(args[portIdx + 1]) : SELFTEST ? 0 : Number(process.env.PORT || 3000);

// Captured before --mock replaces it, so the self-test can still reach the server.
const realFetch = globalThis.fetch.bind(globalThis);

// ---------------------------------------------------------------- mock backend

const MEMBERS = {
  // Under the redemption threshold: there should be no gold button at all.
  M1000: { id: 'M1000', programId: 'P1', tierId: 'base', status: 'ENROLLED', points: 4, created: '2025-03-14T10:00:00Z', person: { displayName: 'Giulia Rossi' } },
  // Twice the cost: redeem once, and the button must stay dead at 9 points.
  M2000: { id: 'M2000', programId: 'P1', tierId: 'gold', status: 'ENROLLED', points: 18, created: '2024-11-02T09:30:00Z', person: { forename: 'Marco', surname: 'Bianchi' } },
  // Never bought anything: the "First visit" pill.
  M3000: { id: 'M3000', programId: 'P1', tierId: 'base', status: 'ENROLLED', points: 0, created: '2026-09-20T15:00:00Z', person: { displayName: 'Nuovo Cliente' } },
};

/** An unknown id still works, so any QR code can be scanned. Stable per string. */
function inventMember(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  const points = Math.abs(h) % 23;
  MEMBERS[id] = {
    id, programId: 'P1', tierId: 'base', status: 'ENROLLED', points,
    created: '2025-06-01T12:00:00Z',
    person: { displayName: 'Scanned ' + id.slice(0, 12) },
  };
  return MEMBERS[id];
}

const EARN = 'EVENT_MEMBER_POINTS_EARNED';
const BURN = 'EVENT_MEMBER_POINTS_BURNED';

/** Per-member event log, plus the older Make.com-era events the backfill reads. */
const EVENTS = [];
(function seedEvents() {
  const day = 86400000;
  const now = Date.now();
  let n = 0;
  for (const id of ['M1000', 'M2000']) {
    for (let i = 1; i <= 6; i++) {
      EVENTS.push({
        id: 'ev' + ++n, eventType: EARN, member: { id },
        date: new Date(now - i * 9 * day).toISOString(),
        retainedUntilDate: new Date(now - i * 9 * day + 365 * day).toISOString(),
        notes: 'Loyalty Scanner: +1 point',
      });
    }
    EVENTS.push({
      id: 'ev' + ++n, eventType: BURN, member: { id },
      date: new Date(now - 20 * day).toISOString(),
      notes: 'Loyalty Scanner: -9 points',
    });
  }
  // The Make.com era: no sign in front of the amount, and some with no amount
  // at all. This is what makes the backfill dry run worth looking at.
  const oldNotes = ['9 points', '1 point', 'Stamp added', '', '3 Points', 'Free drink redeemed'];
  for (let i = 0; i < 40; i++) {
    const burn = i % 7 === 6;
    EVENTS.push({
      id: 'old' + i,
      eventType: burn ? BURN : EARN,
      member: { id: 'M' + (1000 + (i % 3) * 1000) },
      date: new Date(now - (200 + i * 3) * day).toISOString(),
      notes: burn ? 'Free drink redeemed' : oldNotes[i % oldNotes.length],
    });
  }
})();

/** Our own ledger, as rows, exactly as PostgREST would hold them. */
const LEDGER = [];
(function seedLedger() {
  const day = 86400000;
  const now = Date.now();
  // A year of history, busier on weekends and in the mornings.
  for (let d = 330; d >= 0; d--) {
    const date = new Date(now - d * day);
    const weekend = [0, 6].includes(date.getUTCDay());
    const scans = Math.max(0, Math.round((weekend ? 26 : 16) + Math.sin(d / 9) * 6 - (d > 120 ? 6 : 0)));
    for (let i = 0; i < scans; i++) {
      const at = new Date(date);
      at.setUTCHours(7 + Math.floor(Math.random() * 11), Math.floor(Math.random() * 60), 0, 0);
      const older = d > 120; // before the live ledger existed
      if (older) {
        LEDGER.push({ action: i % 9 === 8 ? 'redeem' : 'add', points: i % 9 === 8 ? 9 : 1, member_id: 'M1000', occurred_at: at.toISOString(), source: 'passkit-backfill', external_id: `seed:${d}:${i}` });
      } else {
        LEDGER.push({ action: 'lookup', points: 0, member_id: 'M1000', occurred_at: at.toISOString(), source: 'scanner', external_id: null });
        if (i % 3 !== 2) LEDGER.push({ action: 'add', points: 1, member_id: 'M1000', occurred_at: at.toISOString(), source: 'scanner', external_id: null });
        if (i % 11 === 10) LEDGER.push({ action: 'redeem', points: 9, member_id: 'M1000', occurred_at: at.toISOString(), source: 'scanner', external_id: null });
      }
    }
  }
})();

const isScan = (r) => r.action === 'lookup' || (r.source === 'passkit-backfill' && (r.action === 'add' || r.action === 'redeem'));

/**
 * The two reporting RPCs, in JavaScript. Bucketing reuses lib/time so it agrees
 * with the API, but this is a stand-in: it is NOT the SQL in the migrations.
 * The hour bucket ignores DST transitions, which the real date_trunc does not.
 */
function mockSeries({ bucket, from_ts, to_ts, tz }) {
  const T = require(path.join(ROOT, 'lib', 'time.js'));
  const from = Date.parse(from_ts), to = Date.parse(to_ts);
  const groups = new Map();
  for (const r of LEDGER) {
    const at = Date.parse(r.occurred_at);
    if (!(at >= from && at < to)) continue;
    const p = T.localParts(new Date(at), tz);
    const midnight = T.localMidnight(p.y, p.m, p.d, tz).getTime();
    const startMs = bucket === 'hour' ? midnight + p.h * 3600000
      : bucket === 'day' ? midnight
      : T.localMidnight(p.y, p.m, 1, tz).getTime();
    const key = String(startMs);
    if (!groups.has(key)) groups.set(key, { bucket_start: new Date(startMs).toISOString(), scans: 0, adds: 0, redeems: 0, points_stamped: 0, points_burned: 0 });
    const g = groups.get(key);
    if (isScan(r)) g.scans++;
    if (r.action === 'add') { g.adds++; g.points_stamped += r.points || 0; }
    if (r.action === 'redeem') { g.redeems++; g.points_burned += r.points || 0; }
    if (r.action === 'remove') g.points_burned += r.points || 0;
  }
  return [...groups.values()].sort((a, b) => a.bucket_start.localeCompare(b.bucket_start));
}

function mockTotals({ tz }) {
  const T = require(path.join(ROOT, 'lib', 'time.js'));
  const p = T.localParts(new Date(), tz);
  const midnight = T.localMidnight(p.y, p.m, p.d, tz).getTime();
  const scans = LEDGER.filter(isScan);
  const dates = LEDGER.map((r) => r.occurred_at).sort();
  const live = LEDGER.filter((r) => r.source === 'scanner').map((r) => r.occurred_at).sort();
  return [{
    today: scans.filter((r) => Date.parse(r.occurred_at) >= midnight).length,
    total: scans.length,
    first_at: dates[0] || null,
    live_since: live[0] || null,
  }];
}

// In-memory native members, for the signup page and the pass web service.
const NATIVE = [];
const REGS = [];
function postgrestFilter(url) {
  const out = [];
  for (const [k, v] of url.searchParams.entries()) {
    const m = /^eq\.(.*)$/.exec(v);
    if (k !== 'select' && k !== 'limit' && k !== 'on_conflict' && m) out.push([k, m[1]]);
  }
  return (row) => out.every(([k, v]) => String(row[k] ?? '') === v);
}
function mockMembersApi(p, url, init, body, prefer, reply) {
  const method = (init.method || 'GET').toUpperCase();
  const where = postgrestFilter(url);
  if (p.startsWith('/rest/v1/rpc/adjust_member_points')) {
    const m = NATIVE.find((r) => r.id === body.p_member && r.status === 'active');
    if (!m) return reply(400, { message: 'member_not_found' });
    if (m.points + body.p_delta < 0) return reply(400, { message: 'insufficient_points' });
    m.points += body.p_delta; m.updated_at = m.pass_updated_at = new Date().toISOString();
    if (body.p_delta > 0) m.last_visit_at = m.updated_at;
    return reply(200, [{ points: m.points }]);
  }
  if (p.startsWith('/rest/v1/rpc/pass_updated_serials')) {
    const rows = REGS.filter((r) => r.device_library_id === body.p_device)
      .map((r) => NATIVE.find((m) => m.pass_serial === r.pass_serial)).filter(Boolean)
      .filter((m) => !body.p_since || m.pass_updated_at > body.p_since)
      .map((m) => ({ serial: m.pass_serial, updated_at: m.pass_updated_at }));
    return reply(200, rows);
  }
  const table = p.startsWith('/rest/v1/members') ? NATIVE : REGS;
  if (method === 'GET') {
    const limit = Number(url.searchParams.get('limit')) || Infinity;
    return reply(200, table.filter(where).slice(0, limit));
  }
  if (method === 'POST') {
    const rows = (Array.isArray(body) ? body : [body]).map((r) => {
      if (table === NATIVE) {
        const email_norm = r.email ? String(r.email).trim().toLowerCase() : null;
        if (NATIVE.some((x) => x.email_norm && x.email_norm === email_norm)) return { __dupe: true };
        const now = new Date().toISOString();
        return { id: crypto.randomUUID(), points: 0, status: 'active', source: 'join', consent_marketing: false, created_at: now, updated_at: now, pass_updated_at: now, last_visit_at: null, ...r, email_norm };
      }
      const existing = REGS.find((x) => x.device_library_id === r.device_library_id && x.pass_serial === r.pass_serial);
      if (existing) { existing.push_token = r.push_token; return existing; }
      return { created_at: new Date().toISOString(), ...r };
    });
    if (rows.some((r) => r.__dupe)) return reply(409, { message: 'duplicate key value violates unique constraint "members_email_norm_idx"' });
    for (const r of rows) if (!table.includes(r)) table.push(r);
    return reply(201, prefer.includes('return=representation') ? rows : '');
  }
  if (method === 'PATCH') {
    const hit = table.filter(where);
    for (const r of hit) Object.assign(r, body);
    return reply(200, hit);
  }
  if (method === 'DELETE') {
    for (let i = table.length - 1; i >= 0; i -= 1) if (where(table[i])) table.splice(i, 1);
    return reply(204, '');
  }
  return reply(405, { message: 'mock: unsupported' });
}

/** Stands in for both PassKit and PostgREST. */
function installMockFetch() {
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const stream = (items) => reply(200, items.map((r) => JSON.stringify({ result: r })).join('\n'));

  globalThis.fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    const p = url.pathname;
    const body = init.body ? JSON.parse(init.body) : null;
    const prefer = String((init.headers && (init.headers.Prefer || init.headers.prefer)) || '');

    // ---- PostgREST
    if (p.startsWith('/rest/v1/rpc/scan_series')) return reply(200, mockSeries(body));
    if (p.startsWith('/rest/v1/rpc/scan_totals')) return reply(200, mockTotals(body));
    if (p.startsWith('/rest/v1/scan_events')) {
      const rows = Array.isArray(body) ? body : [body];
      const stored = [];
      for (const r of rows) {
        const dupe = r.external_id && LEDGER.some((x) => x.external_id === r.external_id);
        if (dupe && prefer.includes('ignore-duplicates')) continue;
        if (dupe) return reply(409, { message: 'duplicate key value violates unique constraint "scan_events_external_id_key"' });
        LEDGER.push({ ...r, points: r.points == null ? null : r.points });
        stored.push({ id: LEDGER.length });
      }
      return reply(201, prefer.includes('return=representation') ? stored : '');
    }

    // ---- PostgREST: native members + Wallet registrations (the pass system)
    if (p.startsWith('/rest/v1/members') || p.startsWith('/rest/v1/pass_registrations') || p.startsWith('/rest/v1/rpc/adjust_member_points') || p.startsWith('/rest/v1/rpc/pass_updated_serials')) {
      return mockMembersApi(p, url, init, body, prefer, reply);
    }

    // ---- PassKit
    let m;
    if ((m = p.match(/^\/members\/member\/id\/(.+)$/))) {
      const id = decodeURIComponent(m[1]);
      const member = MEMBERS[id] || inventMember(id);
      return reply(200, member);
    }
    if (p === '/members/member/points/earn' || p === '/members/member/points/burn') {
      const member = MEMBERS[body.id] || inventMember(body.id);
      const delta = p.endsWith('earn') ? body.points : -body.points;
      member.points = Math.max(0, member.points + delta);
      EVENTS.push({
        id: 'live' + Date.now(), eventType: p.endsWith('earn') ? EARN : BURN,
        member: { id: member.id }, date: new Date().toISOString(),
        notes: (body.eventDetails && body.eventDetails.notes) || '',
      });
      return reply(200, { id: member.id, points: member.points });
    }
    if (p.startsWith('/members/program/list/events/')) {
      const filters = (body && body.filters) || {};
      const wanted = (((filters.filterGroups || [])[0] || {}).fieldFilters || [])[0];
      let list = EVENTS;
      if (wanted) list = EVENTS.filter((e) => e.member && e.member.id === wanted.filterValue);
      const offset = filters.offset || 0;
      const limit = filters.limit || 1000;
      return stream(list.slice(offset, offset + limit));
    }
    if (p === '/members/programs/list') return stream([{ id: 'P1', name: 'La Bottega Loyalty (mock)' }]);
    if (p.startsWith('/members/member/list/events/')) {
      const id = decodeURIComponent(p.split('/').pop());
      return stream(EVENTS.filter((e) => e.member && e.member.id === id));
    }

    return reply(404, { message: 'mock has no route for ' + p });
  };
}

if (MOCK) {
  process.env.PASSKIT_API_KEY = process.env.PASSKIT_API_KEY || 'mock-key';
  process.env.PASSKIT_API_SECRET = process.env.PASSKIT_API_SECRET || 'mock-secret';
  process.env.PASSKIT_PROGRAM_ID = process.env.PASSKIT_PROGRAM_ID || 'P1';
  process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://mock.supabase.co';
  process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'mock-service-key';
  process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'mock-admin-secret';
  // Pass signing with a throwaway certificate: Wallet will refuse the result,
  // but the whole build/sign/zip path runs for real.
  if (!process.env.PASS_CERT_PEM_B64) {
    const { makeSelfSignedPassCert } = require(path.join(ROOT, 'scripts', 'selfsigned-cert.js'));
    const c = makeSelfSignedPassCert();
    process.env.APPLE_TEAM_ID = process.env.APPLE_TEAM_ID || c.teamId;
    process.env.PASS_TYPE_ID = process.env.PASS_TYPE_ID || c.passTypeId;
    process.env.PASS_CERT_PEM_B64 = Buffer.from(c.certPem).toString('base64');
    process.env.PASS_KEY_PEM_B64 = Buffer.from(c.keyPem).toString('base64');
  }
  process.env.APNS_ENABLED = process.env.APNS_ENABLED || 'false';
  installMockFetch();
}

// ------------------------------------------------------------------- the server

const ROUTES = {
  '/api/loyalty': 'api/loyalty.js',
  '/api/stats': 'api/stats.js',
  '/api/admin/backfill': 'api/admin/backfill.js',
};

// Everything else under api/ is matched Vercel-style: [name].js segments are
// parameters, and they land on req.query like they do in production.
function listApiFiles(dir, prefix = []) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...listApiFiles(path.join(dir, entry.name), [...prefix, entry.name]));
    else if (entry.name.endsWith('.js')) out.push({ file: path.join('api', ...prefix, entry.name), segments: [...prefix, entry.name.slice(0, -3)] });
  }
  return out;
}
const API_FILES = listApiFiles(path.join(ROOT, 'api'));
function matchApi(pathname) {
  if (!pathname.startsWith('/api/')) return null;
  const parts = pathname.slice(5).split('/').filter(Boolean).map(decodeURIComponent);
  for (const f of API_FILES) {
    if (f.segments.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < parts.length; i += 1) {
      const seg = f.segments[i];
      if (seg.startsWith('[') && seg.endsWith(']')) params[seg.slice(1, -1)] = parts[i];
      else if (seg !== parts[i]) { ok = false; break; }
    }
    if (ok) return { file: f.file, params };
  }
  return null;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json',
};

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const started = Date.now();
  if (!SELFTEST) res.on('finish', () => console.log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`));

  const matched = ROUTES[pathname] ? { file: ROUTES[pathname], params: {} } : matchApi(pathname);
  const route = matched && matched.file;
  if (route) {
    req.query = { ...matched.params, ...Object.fromEntries(new URL(req.url, 'http://localhost').searchParams.entries()) };
    const raw = await readBody(req);
    // Vercel parses a JSON body onto req.body; the handlers expect that.
    if (raw && String(req.headers['content-type'] || '').includes('json')) {
      try { req.body = JSON.parse(raw); } catch { req.body = raw; }
    } else if (raw) {
      req.body = raw;
    }
    try {
      const handler = require(path.join(ROOT, route));
      await handler(req, res);
    } catch (err) {
      console.error(`${route} threw:`, err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
      }
      res.end(JSON.stringify({ ok: false, error: 'dev_server', message: String(err && err.message) }));
    }
    return;
  }

  // Static, out of public/. No path escapes it.
  // Directory paths serve their index.html, as Vercel does (/join/ -> public/join/index.html).
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let file = path.join(PUBLIC, rel);
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!file.startsWith(PUBLIC)) {
    res.statusCode = 403;
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.statusCode = 404;
      return res.end('not found');
    }
    res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
  });
});

// --------------------------------------------------------------- the self-test
/**
 * Drives the running server over HTTP and checks the behaviour the review's
 * findings were about. This is the end-to-end half of `npm run verify`; the
 * unit tests are the other half. It does not touch the SQL -- see the note at
 * the top of this file.
 */
async function selftest(base) {
  let passed = 0;
  const failures = [];
  const check = (label, ok, detail) => {
    if (ok) { passed++; console.log(`  ok    ${label}`); return true; }
    failures.push(label + (detail ? ` (${detail})` : ''));
    console.log(`  FAIL  ${label}${detail ? '  <- ' + detail : ''}`);
    return false;
  };

  const post = async (payload, extraHeaders) => {
    const r = await realFetch(base + '/api/loyalty', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(extraHeaders || {}) },
      body: JSON.stringify(payload),
    });
    return { status: r.status, body: await r.json() };
  };
  const stats = async (query) => {
    const r = await realFetch(base + '/api/stats?' + query);
    return { status: r.status, body: await r.json() };
  };

  console.log('\n  Static files');
  const page = await realFetch(base + '/');
  const pageText = await page.text();
  check('index.html is served', page.status === 200, 'HTTP ' + page.status);
  check('the QR decoder is local, not a CDN', pageText.includes('src="/vendor/jsQR-1.4.0.min.js"'));
  const vendor = await realFetch(base + '/vendor/jsQR-1.4.0.min.js');
  check('the vendored decoder is served', vendor.status === 200 && (await vendor.text()).includes('jsQR'));

  console.log('\n  Scanning and points (H1: no credentials are sent below)');
  const look = await post({ action: 'lookup_customer', qr_data: 'M2000' });
  check('lookup answers with no auth at all', look.status === 200, 'HTTP ' + look.status);
  check('the balance comes back', look.body.points === 18, 'points=' + look.body.points);
  check('M5: the redeem cost comes from the server', look.body.settings && look.body.settings.redeemCost === 9);
  check('history is summarised', look.body.history && look.body.history.recorded === true);

  const bad = await post({ action: 'add_points', qr_data: 'M2000', points: 0 });
  check('add_points refuses 0', bad.status === 400, 'HTTP ' + bad.status);
  const tooMany = await post({ action: 'add_points', qr_data: 'M2000', points: 500 });
  check('add_points refuses more than the per-scan cap', tooMany.status === 400, 'HTTP ' + tooMany.status);
  const noQr = await post({ action: 'lookup_customer', qr_data: '' });
  check('a missing QR payload is rejected', noQr.status === 400, 'HTTP ' + noQr.status);
  const nonsense = await post({ action: 'teleport_points', qr_data: 'M2000' });
  check('an unknown action is rejected', nonsense.status === 400, 'HTTP ' + nonsense.status);

  console.log('\n  Redemption');
  const r1 = await post({ action: 'redeem_points', qr_data: 'M2000', points_to_remove: 9 });
  check('redeem takes exactly the cost', r1.status === 200 && r1.body.points === 9, JSON.stringify(r1.body));
  const r2 = await post({ action: 'redeem_points', qr_data: 'M2000', points_to_remove: 9 });
  check('a second, legitimate redemption at 9 points works', r2.status === 200 && r2.body.points === 0);
  const r3 = await post({ action: 'redeem_points', qr_data: 'M2000', points_to_remove: 9 });
  check('M6: a refusal explains itself and returns the true balance',
    r3.status === 409 && /needs 9/.test(r3.body.message || '') && r3.body.points === 0, JSON.stringify(r3.body));
  const ignored = await post({ action: 'redeem_points', qr_data: 'M1000', points_to_remove: 1 });
  check('the client cannot choose the cost (1 requested, 4 points held, refused)',
    ignored.status === 409, 'HTTP ' + ignored.status);

  console.log('\n  Stats');
  const week = await stats('range=week');
  check('week returns seven day buckets', week.status === 200 && week.body.series.length === 7, 'len=' + (week.body.series || []).length);
  check('L4: gross stamps are mapped through', week.body.series.every((b) => typeof b.points === 'number'));
  check('a zero-filled series has no gaps', week.body.series.every((b) => typeof b.scans === 'number'));
  const cached = await stats('range=week');
  check('M2: an identical request is served from cache', cached.body.cached === true);
  const impossible = await stats('range=custom&from=2026-02-31&to=2026-02-31');
  check('M3: 31 February is a 400, not a chart of zeros', impossible.status === 400, 'HTTP ' + impossible.status);
  const backwards = await stats('range=custom&from=2026-09-28&to=2026-09-01');
  check('a reversed range is a 400', backwards.status === 400);
  const wide = await stats('range=custom&from=2026-01-15&to=2026-08-20');
  check('M4: a long custom range widens to months and says so',
    wide.status === 200 && wide.body.bucket === 'month' && wide.body.from.startsWith('2026-01-01'),
    JSON.stringify({ bucket: wide.body.bucket, from: wide.body.from }));

  console.log('\n  L3: idempotency (each read below uses a fresh cache key)');
  const total = async (from) => (await stats(`range=custom&from=${from}&to=2026-09-28`)).body.total;
  const before = await total('2024-01-01');
  await post({ action: 'lookup_customer', qr_data: 'M1000', request_id: 'selftest-one-key' });
  await post({ action: 'lookup_customer', qr_data: 'M1000', request_id: 'selftest-one-key' });
  const shared = await total('2024-01-02');
  check('two calls sharing a request id count as one scan', shared - before === 1, `+${shared - before}`);
  await post({ action: 'lookup_customer', qr_data: 'M1000', request_id: 'selftest-other-key' });
  const fresh = await total('2024-01-03');
  check('a new request id counts as another scan', fresh - shared === 1, `+${fresh - shared}`);

  console.log('\n  H3 / L8: the history import');
  const noSecret = await realFetch(base + '/api/admin/backfill?dryRun=1', { method: 'POST' });
  check('the backfill still refuses callers with no secret', noSecret.status === 401, 'HTTP ' + noSecret.status);
  const wrongSecret = await realFetch(base + '/api/admin/backfill?dryRun=1', { method: 'POST', headers: { 'x-admin-secret': 'guess' } });
  check('and a wrong one', wrongSecret.status === 401, 'HTTP ' + wrongSecret.status);
  const dry = await realFetch(base + '/api/admin/backfill?dryRun=1&pages=1', { method: 'POST', headers: { 'x-admin-secret': process.env.ADMIN_SECRET } });
  const dryBody = await dry.json();
  check('a dry run is accepted', dry.status === 200, 'HTTP ' + dry.status);
  check('a dry run writes nothing', dryBody.imported === 0 && dryBody.sent > 0, JSON.stringify({ sent: dryBody.sent, imported: dryBody.imported }));
  const unsigned = (dryBody.samples || []).find((s) => s.notes === '9 points');
  check('H3: an unsigned "9 points" reads as 9, not 0', unsigned && unsigned.read === 9, JSON.stringify(unsigned));
  const blank = (dryBody.samples || []).find((s) => s.notes === 'Stamp added');
  check('an unreadable amount is null, not 0', blank && blank.read === null, JSON.stringify(blank));
  check('unreadable amounts are counted and surfaced', dryBody.unknownPoints > 0, 'unknownPoints=' + dryBody.unknownPoints);
  check('O3: a shifting log is reported', typeof dryBody.order === 'string' && typeof dryBody.repeated === 'number');

  console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
  if (failures.length) {
    for (const f of failures) console.log('  - ' + f);
    console.log('');
  }
  return failures.length === 0;
}

server.on('listening', () => { if (!process.env.PUBLIC_BASE_URL) process.env.PUBLIC_BASE_URL = `http://localhost:${server.address().port}`; });
server.listen(PORT, async () => {
  if (SELFTEST) {
    const base = `http://localhost:${server.address().port}`;
    console.log(`\n  End-to-end self-test against ${base}  [mock backend]`);
    let ok = false;
    try {
      ok = await selftest(base);
    } catch (err) {
      console.error('  self-test crashed:', err);
    }
    server.close();
    process.exit(ok ? 0 : 1);
  }

  const at = `http://localhost:${PORT}`;
  console.log(`\n  Loyalty scanner dev server  ${MOCK ? '[MOCK: nothing real is touched]' : '[LIVE: real PassKit and Supabase]'}`);
  console.log(`  ${at}\n`);
  if (MOCK) {
    console.log('  Scan any QR code at all -- an unknown id becomes a member. For the');
    console.log('  specific cases, put one of these in a QR code:');
    console.log('    M1000   Giulia Rossi, 4 points   -> no Redeem button should appear');
    console.log('    M2000   Marco Bianchi, 18 points -> redeem once; button must go dead at 9');
    console.log('    M3000   Nuovo Cliente, 0 points  -> "First visit" pill');
    console.log('\n  No camera? Drive the API directly:');
    console.log(`    curl -s -X POST ${at}/api/loyalty -H "content-type: application/json" -d '{"action":"lookup_customer","qr_data":"M2000"}'`);
    console.log(`    curl -s "${at}/api/stats?range=week"`);
    console.log(`    curl -s "${at}/api/stats?range=custom&from=2026-02-31&to=2026-02-31"   # expect 400`);
    console.log(`    curl -s -X POST -H "x-admin-secret: mock-admin-secret" "${at}/api/admin/backfill?dryRun=1"`);
  } else {
    const missing = ['PASSKIT_API_KEY', 'PASSKIT_API_SECRET'].filter((k) => !process.env[k]);
    if (missing.length) console.log(`  WARNING: ${missing.join(', ')} not set -- PassKit calls will fail. Use --mock.`);
    if (!process.env.SUPABASE_URL) console.log('  Note: SUPABASE_URL not set -- the counter and chart will be unavailable.');
  }
  console.log('\n  Ctrl+C to stop.\n');
});

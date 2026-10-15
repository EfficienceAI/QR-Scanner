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

/**
 * On Vercel, work registered after the response stays alive because the
 * platform exposes a request context carrying waitUntil (see lib/after.js).
 * There is no such thing locally, so install the same contract: it makes
 * `npm run verify` exercise the real registration path instead of only the
 * injected one in the unit tests, and lets the self-test prove that a scan
 * really does register its ledger write.
 */
const afterRegistered = [];
globalThis[Symbol.for('@vercel/request-context')] = {
  get: () => ({ waitUntil: (p) => { afterRegistered.push(p); } }),
};

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
// Google Wallet classes and objects, keyed by id.
const GWALLET = { loyaltyClass: new Map(), loyaltyObject: new Map() };
// Emails "sent" through the Resend mock.
const EMAILS = [];
function postgrestFilter(url) {
  const out = [];
  for (const [k, v] of url.searchParams.entries()) {
    if (k === 'select' || k === 'limit' || k === 'on_conflict' || k === 'order') continue;
    let m;
    if ((m = /^eq\.(.*)$/.exec(v))) out.push([k, (row) => String(row[k] ?? '') === m[1]]);
    else if ((m = /^in\.\((.*)\)$/.exec(v))) { const set = m[1].split(',').map((s) => s.replace(/^"|"$/g, '')); out.push([k, (row) => set.includes(String(row[k] ?? ''))]); }
  }
  return (row) => out.every(([, test]) => test(row));
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
  const reply = (status, body) => ({
    ok: status < 400, status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body || 'null') : body),
  });
  const stream = (items) => reply(200, items.map((r) => JSON.stringify({ result: r })).join('\n'));

  globalThis.fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl));
    const p = url.pathname;
    let body = null;
    if (init.body) { try { body = JSON.parse(init.body); } catch { body = String(init.body); } } // Google's token request is form-encoded
    const prefer = String((init.headers && (init.headers.Prefer || init.headers.prefer)) || '');

    // ---- PostgREST
    if (p.startsWith('/rest/v1/rpc/scan_series')) return reply(200, mockSeries(body));
    if (p.startsWith('/rest/v1/rpc/scan_totals')) return reply(200, mockTotals(body));
    if (p.startsWith('/rest/v1/scan_events') && (init.method || 'GET').toUpperCase() === 'GET') {
      // The native scanner's history read: member_id=in.("a","b"), newest first.
      const inList = /^in\.\((.*)\)$/.exec(url.searchParams.get('member_id') || '');
      const ids = inList ? inList[1].split(',').map((s) => s.replace(/^"|"$/g, '')) : null;
      const limit = Number(url.searchParams.get('limit')) || Infinity;
      const rows = LEDGER.filter((r) => !ids || ids.includes(String(r.member_id)))
        .sort((a, b) => String(b.occurred_at || '').localeCompare(String(a.occurred_at || '')))
        .slice(0, limit)
        .map((r) => ({ action: r.action, points: r.points, occurred_at: r.occurred_at }));
      return reply(200, rows);
    }
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

    // ---- Resend (recovery codes)
    if (url.hostname === 'api.resend.com') { EMAILS.push(body); return reply(200, { id: 'email_' + EMAILS.length }); }

    // ---- Google Wallet (token exchange + Wallet Objects API)
    if (url.hostname === 'oauth2.googleapis.com') return reply(200, { access_token: 'mock-google-token', expires_in: 3600, token_type: 'Bearer' });
    if (url.hostname === 'walletobjects.googleapis.com') {
      const gm = /^\/walletobjects\/v1\/(loyaltyClass|loyaltyObject)(?:\/(.+))?$/.exec(p);
      if (!gm) return reply(404, { error: { message: 'mock: no such Google route ' + p } });
      const store = GWALLET[gm[1]];
      const gid = gm[2] ? decodeURIComponent(gm[2]) : null;
      const method = (init.method || 'GET').toUpperCase();
      if (method === 'GET') return gid ? (store.has(gid) ? reply(200, store.get(gid)) : reply(404, { error: { message: 'not found' } })) : reply(200, { resources: [...store.values()] });
      if (method === 'POST') { if (store.has(body.id)) return reply(409, { error: { message: 'already exists' } }); store.set(body.id, body); return reply(200, body); }
      if (method === 'PUT') { store.set(gid, body); return reply(200, body); }
      if (method === 'PATCH') { const cur = store.get(gid); if (!cur) return reply(404, { error: { message: 'not found' } }); Object.assign(cur, body); return reply(200, cur); }
      return reply(405, { error: { message: 'mock: unsupported' } });
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
  // Pass recovery emails land in the EMAILS array instead of Resend.
  process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || 'mock-resend-key';
  process.env.RESEND_FROM = process.env.RESEND_FROM || 'La Bottega Milanese <loyalty@example.com>';
  // Google Wallet with a throwaway service account: the JWTs are signed for
  // real, the API calls land on the mock below.
  process.env.GOOGLE_WALLET_ISSUER_ID = process.env.GOOGLE_WALLET_ISSUER_ID || '3388000000000000001';
  if (!process.env.GOOGLE_WALLET_SA_JSON_B64) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.GOOGLE_WALLET_SA_JSON_B64 = Buffer.from(JSON.stringify({
      client_email: 'mock-wallet@mock.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    })).toString('base64');
  }
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
  '/api/admin/import': 'api/admin/import.js',
  '/api/admin/member': 'api/admin/member.js',
  '/api/recover': 'api/recover.js',
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

// The redirects and rewrites from vercel.json, applied the way Vercel applies
// them: redirects first, then rewrites, then the route table.
//
// Two of the public URLs exist nowhere else -- /upgrade and /u/:pid are a
// redirect and a rewrite and nothing more -- so without this they 404 here,
// the self-test cannot reach them at all, and a typo in either `source` ships
// unnoticed to the back of a printed card. The real file is read rather than
// a copy of its contents, so what passes here is the configuration that ships.
const VERCEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

function compileSource(source) {
  const names = [];
  const pattern = String(source)
    .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
    .replace(/:([A-Za-z0-9_]+)/g, (_, name) => { names.push(name); return '([^/]+)'; });
  return { re: new RegExp(`^${pattern}$`), names };
}
function fill(destination, names, m) {
  return names.reduce((out, name, i) => out.split(`:${name}`).join(m[i + 1]), String(destination));
}
const REDIRECTS = (VERCEL.redirects || []).map((r) => ({ ...r, ...compileSource(r.source) }));
const REWRITES = (VERCEL.rewrites || []).map((r) => ({ ...r, ...compileSource(r.source) }));

/**
 * Vercel matches `has` against the real request. Only `host` is supported
 * here, which is all vercel.json uses; anything else counts as no match
 * rather than a match, so an unsupported condition cannot fire by accident.
 * In dev the host is localhost, so the host-scoped `/` redirects correctly
 * stay out of the way.
 */
function conditionsMet(has, req) {
  return (has || []).every((c) => c.type === 'host' && String(req.headers.host || '').split(':')[0] === c.value);
}

const server = http.createServer(async (req, res) => {
  let pathname = new URL(req.url, 'http://localhost').pathname;
  const started = Date.now();
  if (!SELFTEST) res.on('finish', () => console.log(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`));

  for (const r of REDIRECTS) {
    const m = r.re.exec(pathname);
    if (!m || !conditionsMet(r.has, req)) continue;
    res.statusCode = r.permanent ? 308 : 307;
    res.setHeader('Location', fill(r.destination, r.names, m));
    return res.end();
  }
  for (const r of REWRITES) {
    const m = r.re.exec(pathname);
    if (m) { pathname = fill(r.destination, r.names, m); break; }
  }

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

  console.log('\n  M2: after-reply work survives the response (lib/after.js)');
  // Vercel may freeze a function the moment res.end() flushes. Unless the
  // ledger write is handed to waitUntil, it is simply lost and the scan is
  // undercounted -- silently, which is why this is asserted here and not just
  // in the unit tests.
  // A PassKit mutation carries two jobs -- the ledger write and the legacy
  // mirror -- on a single registration (respondThenRecord's `alsoAfter`).
  // That the mirror really runs is checked further down, where an imported
  // member's balance is compared against PassKit after a scan.
  const registeredBefore = afterRegistered.length;
  const armed = await post({ action: 'add_points', qr_data: 'M1000', points: 1 });
  const armedCount = afterRegistered.length - registeredBefore;
  check('a scan registers its ledger write with the platform',
    armed.status === 200 && armedCount === 1, `HTTP ${armed.status}, registered ${armedCount}`);
  await Promise.all(afterRegistered.slice(registeredBefore));

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

  console.log('\n  Native passes: join, scan, stamp, redeem');
  const admin = { 'x-admin-secret': process.env.ADMIN_SECRET, 'content-type': 'application/json' };
  const joinRes = await realFetch(base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ full_name: 'Self Test', email: 'selftest@example.com', phone: '07700 900123', consent_marketing: true }) });
  const joined = await joinRes.json();
  check('a customer can join', joinRes.status === 201 && joined.ok === true, 'HTTP ' + joinRes.status + ' ' + JSON.stringify(joined).slice(0, 120));
  const native = NATIVE.find((m) => m.email_norm === 'selftest@example.com');
  check('the member row exists', Boolean(native));
  const pk = native ? await realFetch(base + joined.passUrl) : null;
  check('their pass is served', pk && pk.status === 200 && String(pk.headers.get('content-type')).includes('vnd.apple.pkpass'), pk && ('HTTP ' + pk.status + ' ' + pk.headers.get('content-type')));
  // C1: a repeat signup on a known address must not hand the card over. The
  // email is the only thing the caller needs to know, so this reply carries
  // no member id (the QR payload), no download token and no PII.
  const repeat = await realFetch(base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ full_name: 'A B', email: 'selftest@example.com', phone: '07700 900000' }) });
  const repeatBody = await repeat.json();
  const repeatWire = JSON.stringify(repeatBody);
  check('a repeat join on a known email discloses nothing',
    repeat.status === 200 && repeatBody.existing === true && !repeatBody.passUrl && !repeatBody.member
      && (!native || (!repeatWire.includes(native.id) && !repeatWire.includes(native.download_token))),
    'HTTP ' + repeat.status + ' ' + repeatWire.slice(0, 120));

  const nq = native ? `LBM:${native.id}` : 'LBM:missing';
  const nl = await post({ action: 'lookup_customer', qr_data: nq, request_id: 'native-1' });
  check('a native QR is looked up without PassKit', nl.status === 200 && nl.body.member && nl.body.member.native === true, 'HTTP ' + nl.status + ' ' + JSON.stringify(nl.body).slice(0, 160));
  check('a new member reads as their first coffee', nl.body.points === 0 && nl.body.history && nl.body.history.firstVisit === true, JSON.stringify(nl.body.history));
  const na = await post({ action: 'add_points', qr_data: nq, points: 3, request_id: 'native-2' });
  check('stamps land in the members table', na.status === 200 && na.body.points === 3 && native.points === 3, JSON.stringify(na.body));
  const nl2 = await post({ action: 'lookup_customer', qr_data: nq, request_id: 'native-3' });
  check('the stamp is now a visit in our own history', nl2.body.history.visits === 1 && nl2.body.history.firstVisit === false && Boolean(nl2.body.history.lastVisit), JSON.stringify(nl2.body.history));
  const nr = await post({ action: 'redeem_points', qr_data: nq, points_to_remove: 9, request_id: 'native-4' });
  check('a redemption below the cost is refused with the true balance', nr.status === 409 && nr.body.points === 3 && nr.body.required === 9, JSON.stringify(nr.body));
  await post({ action: 'add_points', qr_data: nq, points: 6, request_id: 'native-5' });
  const nr2 = await post({ action: 'redeem_points', qr_data: nq, points_to_remove: 9, request_id: 'native-6' });
  check('a redemption at the cost takes exactly the cost', nr2.status === 200 && nr2.body.points === 0 && native.points === 0, JSON.stringify(nr2.body));
  const nm = await post({ action: 'remove_points', qr_data: nq, points: 1, request_id: 'native-7' });
  check('nothing goes below zero', nm.status === 409, 'HTTP ' + nm.status);
  const ghost = await post({ action: 'lookup_customer', qr_data: 'LBM:00000000-0000-0000-0000-000000000000', request_id: 'native-8' });
  check('an unknown native QR is a 404', ghost.status === 404 && ghost.body.error === 'member_not_found', 'HTTP ' + ghost.status);

  console.log('\n  Google Wallet (Android)');
  check('the join reply carries an Android link', typeof joined.googleUrl === 'string' && joined.googleUrl.startsWith('/api/gwallet/'), String(joined.googleUrl));
  const gj = await realFetch(base + joined.googleUrl, { redirect: 'manual' });
  const gloc = String(gj.headers.get('location') || '');
  check('the Android link answers with a redirect to Google', gj.status === 302 && gloc.startsWith('https://pay.google.com/gp/v/save/'), 'HTTP ' + gj.status + ' ' + gloc.slice(0, 60));
  const gclaims = gloc ? JSON.parse(Buffer.from(gloc.split('/save/')[1].split('.')[1], 'base64url').toString()) : {};
  const expectedObject = process.env.GOOGLE_WALLET_ISSUER_ID + '.' + (native && native.id);
  check('the save link names the member\'s own card', gclaims.typ === 'savetowallet' && gclaims.payload && gclaims.payload.loyaltyObjects[0].id === expectedObject, JSON.stringify(gclaims.payload));
  check('the class was created in demo mode', [...GWALLET.loyaltyClass.values()].some((c) => c.reviewStatus === 'UNDER_REVIEW' && c.issuerName === 'La Bottega Milanese'));
  check('the member remembers their Google card', native && native.gwallet_object_id === expectedObject, String(native && native.gwallet_object_id));
  const gobjBefore = GWALLET.loyaltyObject.get(expectedObject);
  check('the card carries the balance and the QR', gobjBefore && gobjBefore.loyaltyPoints.balance.int === native.points && gobjBefore.barcode.value === 'LBM:' + native.id, JSON.stringify(gobjBefore && gobjBefore.loyaltyPoints));
  await post({ action: 'add_points', qr_data: nq, points: 2, request_id: 'native-g1' });
  await new Promise((r) => setTimeout(r, 80));
  const gobj = GWALLET.loyaltyObject.get(expectedObject);
  check('a scan updates the Google card too', gobj && gobj.loyaltyPoints.balance.int === native.points && native.points === 2, `google=${gobj && gobj.loyaltyPoints.balance.int} ours=${native && native.points}`);
  const andro = await realFetch(base + joined.passUrl, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile' } });
  check('an Android phone opening the pass link is sent to Google Wallet', andro.status === 302 && String(andro.headers.get('location')).startsWith('/api/gwallet/'), 'HTTP ' + andro.status + ' ' + andro.headers.get('location'));

  console.log('\n  The overlap: PassKit scans mirrored onto imported members');
  const imp = await realFetch(base + '/api/admin/import', { method: 'POST', headers: admin, body: JSON.stringify({ members: [{ passkit_member_id: 'M1000000000', full_name: 'Imported Person', email: 'imported@example.com', phone: '', points: 4 }] }) });
  const impBody = await imp.json();
  check('a PassKit member can be imported', imp.status === 200 && impBody.created === 1, 'HTTP ' + imp.status + ' ' + JSON.stringify(impBody).slice(0, 160));
  const imported = NATIVE.find((m) => m.passkit_member_id === 'M1000000000');
  check('the imported serial is the PassKit id, so the new pass replaces the old one in place', imported && imported.pass_serial === 'M1000000000');
  const legacy = await post({ action: 'add_points', qr_data: 'M1000000000', points: 1, request_id: 'overlap-1' });
  check('a PassKit scan still answers from PassKit', legacy.status === 200 && typeof legacy.body.points === 'number', JSON.stringify(legacy.body));
  await new Promise((r) => setTimeout(r, 50));
  check('and the imported copy now matches PassKit', imported && imported.points === legacy.body.points && Boolean(imported.last_visit_at), `ours=${imported && imported.points} passkit=${legacy.body.points}`);
  const again = await realFetch(base + '/api/admin/import', { method: 'POST', headers: admin, body: JSON.stringify({ members: [{ passkit_member_id: 'M1000000000', full_name: 'Imported Person', email: 'imported@example.com', points: 2 }] }) });
  const againBody = await again.json();
  check('re-importing updates rather than duplicates', again.status === 200 && againBody.updated === 1 && againBody.created === 0 && imported.points === 2, JSON.stringify(againBody));

  // A whole batch dropping to zero is what a dead points column looks like
  // from the endpoint's side: every value readable, nothing unreadable, and
  // the summary would otherwise say `updated: 30`.
  const zeroBatch = Array.from({ length: 30 }, (_, i) => ({
    passkit_member_id: 'Z' + String(i + 1).padStart(4, '0') + '0000000',
    full_name: 'Zero Test ' + (i + 1),
    email: `zero${i + 1}@example.com`,
    points: 6 + i,
  }));
  const seedZero = await realFetch(base + '/api/admin/import', { method: 'POST', headers: admin, body: JSON.stringify({ members: zeroBatch }) });
  const seedZeroBody = await seedZero.json();
  check('a batch of members with balances imports', seedZero.status === 200 && seedZeroBody.created === 30, JSON.stringify(seedZeroBody).slice(0, 160));
  const wipe = await realFetch(base + '/api/admin/import', { method: 'POST', headers: admin, body: JSON.stringify({ members: zeroBatch.map((m) => ({ ...m, points: 0 })) }) });
  const wipeBody = await wipe.json();
  const survived = zeroBatch.every((m) => {
    const row = NATIVE.find((n) => n.passkit_member_id === m.passkit_member_id);
    return row && Number(row.points) === m.points;
  });
  check('an import that would zero the whole batch is refused, and nothing is written',
    wipe.status === 400 && wipeBody.error === 'mass_zeroing' && wipeBody.would_zero === 30 && survived,
    `HTTP ${wipe.status} ${JSON.stringify(wipeBody).slice(0, 140)} survived=${survived}`);
  const oneRedeemed = await realFetch(base + '/api/admin/import', { method: 'POST', headers: admin, body: JSON.stringify({ members: zeroBatch.map((m, i) => ({ ...m, points: i === 0 ? 0 : m.points })) }) });
  const oneBody = await oneRedeemed.json();
  check('but one member redeeming down to zero still goes through, and is counted',
    oneRedeemed.status === 200 && oneBody.would_zero === 1 && oneBody.updated === 1,
    JSON.stringify(oneBody).slice(0, 160));

  console.log('\n  Lost your pass: a code to the email on the card, never the link itself');
  const rejoin = await realFetch(base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ full_name: 'Someone Else', email: 'other@example.com', phone: '07700 900123' }) });
  const rejoinBody = await rejoin.json();
  check('joining with a number already on a card does not hand the card over', rejoin.status === 200 && rejoinBody.existing === true && rejoinBody.recovery === true && !rejoinBody.passUrl, JSON.stringify(rejoinBody).slice(0, 160));
  const mail = EMAILS[EMAILS.length - 1];
  const codeMatch = mail && /\b(\d{6})\b/.exec(String(mail.text || ''));
  check('a six-digit code was emailed to the address on the card', Boolean(codeMatch) && mail.to[0] === 'selftest@example.com', JSON.stringify(mail && { to: mail.to, subject: mail.subject }));
  const wrong = await realFetch(base + '/api/recover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '07700 900123', code: codeMatch && codeMatch[1] === '000000' ? '111111' : '000000' }) });
  check('a wrong code is refused', wrong.status === 400, 'HTTP ' + wrong.status);
  const right = await realFetch(base + '/api/recover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'selftest@example.com', code: codeMatch ? codeMatch[1] : '' }) });
  const rightBody = await right.json();
  check('the right code returns the card, with its points', right.status === 200 && rightBody.recovered === true && typeof rightBody.passUrl === 'string' && rightBody.member.points === native.points, JSON.stringify(rightBody).slice(0, 160));
  const oldLink = await realFetch(base + joined.passUrl);
  check('the old link stopped working once the card was recovered', oldLink.status === 404, 'HTTP ' + oldLink.status);
  const newLink = await realFetch(base + rightBody.passUrl);
  check('the new link serves the pass', newLink.status === 200 && String(newLink.headers.get('content-type')).includes('vnd.apple.pkpass'), 'HTTP ' + newLink.status);
  const unknown = await realFetch(base + '/api/recover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@example.com' }) });
  const unknownBody = await unknown.json();
  check('an unknown email gets the same answer as a known one', unknown.status === 200 && unknownBody.sent === true && unknownBody.hint === null, JSON.stringify(unknownBody));

  console.log('\n  The link on the back of the old pass: /upgrade and /u/:pid');
  // Both of these URLs are vercel.json and nothing else -- a redirect and a
  // rewrite -- so these checks are the only thing standing between a typo in
  // that file and a dead link printed on a card.
  const iphone = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)' };
  const upgrade = await realFetch(base + '/upgrade', { redirect: 'manual' });
  check('/upgrade opens the join page on the recovery form', upgrade.status === 307 && upgrade.headers.get('location') === '/join/#upgrade',
    'HTTP ' + upgrade.status + ' ' + upgrade.headers.get('location'));

  const importedPid = zeroBatch[1].passkit_member_id;
  const tap = await realFetch(base + '/u/' + importedPid, { redirect: 'manual', headers: iphone });
  check('an imported member tapping the link gets their new pass', tap.status === 200 && String(tap.headers.get('content-type')).includes('vnd.apple.pkpass'),
    'HTTP ' + tap.status + ' ' + tap.headers.get('content-type'));
  const andTap = await realFetch(base + '/u/' + importedPid, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile' } });
  check('an Android phone is sent on to its Google Wallet card', andTap.status === 302 && String(andTap.headers.get('location')).startsWith('/api/gwallet/'),
    'HTTP ' + andTap.status + ' ' + andTap.headers.get('location'));

  // The serial is printed on the card as the QR alt text, and this route asks
  // for no download token, so answering for one would hand over the pass.
  const nativeRow = NATIVE.find((m) => m.email_norm === 'selftest@example.com');
  const bySerial = await realFetch(base + '/u/' + nativeRow.pass_serial, { redirect: 'manual', headers: iphone });
  check('a native card is not downloadable by the serial printed on it', bySerial.status === 302 && bySerial.headers.get('location') === '/upgrade',
    'HTTP ' + bySerial.status + ' ' + bySerial.headers.get('location') + ' serial=' + nativeRow.pass_serial);

  // Joined PassKit after the last import: fetched and created on the spot,
  // with the balance PassKit reports -- not a zero.
  const latecomer = 'LATEJOINER7788';
  const adopt = await realFetch(base + '/u/' + latecomer, { redirect: 'manual', headers: iphone });
  const adopted = NATIVE.find((m) => m.passkit_member_id === latecomer);
  check('a member who joined PassKit after the import is adopted at the link, with their points',
    adopt.status === 200 && Boolean(adopted) && adopted.points === MEMBERS[latecomer].points && adopted.pass_serial === latecomer,
    'HTTP ' + adopt.status + ' row=' + JSON.stringify(adopted && { points: adopted.points, serial: adopted.pass_serial }) + ' passkit=' + (MEMBERS[latecomer] && MEMBERS[latecomer].points));

  // A PassKit record with nothing readable where the balance should be: no
  // card rather than a card showing nothing.
  const blankBalance = 'BLANKPOINTS991';
  MEMBERS[blankBalance] = { id: blankBalance, programId: 'P1', status: 'ENROLLED', points: '', person: { displayName: 'Blank Balance' } };
  const refused = await realFetch(base + '/u/' + blankBalance, { redirect: 'manual', headers: iphone });
  check('a balance PassKit cannot give us means no card, not a card showing zero',
    refused.status === 302 && refused.headers.get('location') === '/upgrade' && !NATIVE.some((m) => m.passkit_member_id === blankBalance),
    'HTTP ' + refused.status + ' ' + refused.headers.get('location') + ' created=' + NATIVE.some((m) => m.passkit_member_id === blankBalance));

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

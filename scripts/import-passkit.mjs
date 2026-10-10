#!/usr/bin/env node
/**
 * Feeds a PassKit member export into /api/admin/import in batches.
 *
 *   node scripts/import-passkit.mjs <export.csv> --base https://lbm-loyalty.vercel.app --secret-file ~/Documents/"LBM Pass Certificate"/admin-secret.txt [--dry-run] [--only <passkit id>]
 *
 * The CSV is PassKit's "members" export (columns such as members.member.id,
 * person.forename, person.surname, person.emailAddress, person.mobileNumber,
 * members.member.points). Nothing is sent to any customer; rows land in our
 * members table with source = passkit-import. Safe to re-run: re-runs update
 * points and never duplicate.
 */
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const dryRun = args.includes('--dry-run');
const only = opt('--only', null);
const base = (opt('--base', process.env.BASE_URL || '')).replace(/\/+$/, '');
const secretFile = opt('--secret-file', null);
const secret = process.env.ADMIN_SECRET || (secretFile ? fs.readFileSync(secretFile.replace(/^~/, process.env.HOME), 'utf8').trim() : '');
if (!file || !base || !secret) { console.error('usage: node scripts/import-passkit.mjs <export.csv> --base <url> --secret-file <path> [--dry-run] [--only <id>]'); process.exit(1); }

function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.replace(/^﻿/, '').trim());
  return rows.filter((r) => r.some((v) => v.trim())).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] || '').trim()])));
}

const pick = (r, ...names) => { for (const n of names) if (r[n] !== undefined && r[n] !== '') return r[n]; return ''; };
const records = parseCsv(fs.readFileSync(file, 'utf8'));
let members = records.map((r) => {
  const first = pick(r, 'person.forename', 'forename', 'first_name');
  const last = pick(r, 'person.surname', 'surname', 'last_name');
  const display = pick(r, 'person.displayName', 'displayName');
  return {
    passkit_member_id: pick(r, 'members.member.id', 'member.id', 'id'),
    full_name: [first, last].filter(Boolean).join(' ') || display,
    email: pick(r, 'person.emailAddress', 'email', 'members.member.externalId'),
    phone: pick(r, 'person.mobileNumber', 'mobile', 'phone'),
    points: pick(r, 'members.member.points', 'points'),
    pass_status: pick(r, 'member.passMetaData.status'),
  };
});
if (only) members = members.filter((m) => m.passkit_member_id === only);
console.log(`${records.length} rows in the file, ${members.length} to send${dryRun ? ' (dry run)' : ''}`);

const totals = { received: 0, created: 0, updated: 0, linked: 0, skipped: 0, problems: [] };
for (let i = 0; i < members.length; i += 500) {
  const batch = members.slice(i, i + 500);
  const resp = await fetch(`${base}/api/admin/import`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-secret': secret }, body: JSON.stringify({ members: batch, dry_run: dryRun }) });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) { console.error(`batch ${i / 500 + 1}: HTTP ${resp.status}`, JSON.stringify(data).slice(0, 500)); process.exit(2); }
  for (const k of ['received', 'created', 'updated', 'linked', 'skipped']) totals[k] += data[k] || 0;
  totals.problems.push(...(data.problems || []));
  console.log(`batch ${i / 500 + 1}: created ${data.created}, updated ${data.updated}, linked ${data.linked}, skipped ${data.skipped}`);
}
console.log('TOTAL', JSON.stringify({ ...totals, problems: totals.problems.length }));
if (totals.problems.length) console.log('first problems:', JSON.stringify(totals.problems.slice(0, 10)));

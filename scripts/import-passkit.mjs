#!/usr/bin/env node
/**
 * Feeds a PassKit member export into /api/admin/import in batches.
 *
 *   node scripts/import-passkit.mjs <export.csv> --base https://lbm-loyalty.vercel.app --secret-file ~/Documents/"LBM Pass Certificate"/admin-secret.txt [--dry-run] [--only <passkit id>]
 *
 * The CSV is PassKit's "members" export (columns such as members.member.id,
 * person.forename, person.surname, person.emailAddress, person.mobileNumber,
 * members.member.points). Nothing is sent to any customer; rows land in our
 * members table with source = passkit-import.
 *
 * Re-running is safe in the sense that it updates rather than duplicates, but
 * it is also the dangerous direction: points are written as an absolute value,
 * so a re-run can lower a balance as easily as raise it. Read the points
 * summary this prints before letting a re-run through, and note that a dry run
 * reports counts, not values -- "updated: 5000" looks the same whether
 * balances went up or to zero. A dry run also cannot see an email shared by
 * two members in different batches; the real run reports it.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export function parseCsv(text) {
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

export const pick = (r, ...names) => { for (const n of names) if (r[n] !== undefined && r[n] !== '') return r[n]; return ''; };

const POINTS_COLUMNS = ['members.member.points', 'points'];

/**
 * Turn parsed rows into what /api/admin/import expects, and say what was done
 * with the balances.
 *
 * The balance needs care, because the endpoint writes it as an *absolute*
 * value. PassKit's export never writes "0" -- a member on nothing has a blank
 * cell, 1,657 of 5,271 on the switch-day export -- so a blank under a live
 * points column is a real zero and must be sent as one, or the endpoint's
 * unreadable-points guard refuses the whole import.
 *
 * "Live" is the part that matters. Asking only whether the *header* names the
 * column is not enough: an export whose points column is present but empty
 * throughout (a filtered export, a permissions change at PassKit, a failed
 * join on their side) would then map every row to 0, the endpoint would see
 * nothing unreadable, and a re-run would write every customer down to nothing
 * and report it as `updated`. So the column also has to carry a value
 * somewhere. If it carries none, the rows stay unreadable and the endpoint's
 * guard does its job -- which is exactly what happens for a renamed column.
 */
export function mapRecords(records) {
  const inHeader = records.length > 0 && POINTS_COLUMNS.some((c) => c in records[0]);
  const alive = inHeader && records.some((r) => pick(r, ...POINTS_COLUMNS) !== '');
  const points = { readable: 0, blankAsZero: 0, unreadable: 0, columnInHeader: inHeader, columnAlive: alive };

  const members = records.map((r) => {
    const first = pick(r, 'person.forename', 'forename', 'first_name');
    const last = pick(r, 'person.surname', 'surname', 'last_name');
    const display = pick(r, 'person.displayName', 'displayName');
    const raw = pick(r, ...POINTS_COLUMNS);
    let balance = raw;
    if (raw !== '') points.readable += 1;
    else if (alive) { balance = '0'; points.blankAsZero += 1; }
    else points.unreadable += 1;
    return {
      passkit_member_id: pick(r, 'members.member.id', 'member.id', 'id'),
      full_name: [first, last].filter(Boolean).join(' ') || display,
      email: pick(r, 'person.emailAddress', 'email', 'members.member.externalId'),
      phone: pick(r, 'person.mobileNumber', 'mobile', 'phone'),
      points: balance,
      pass_status: pick(r, 'member.passMetaData.status'),
    };
  });

  return { members, points };
}

/** One line the operator has to be able to read before a re-run. */
export function describePoints(points, total) {
  if (!points.columnInHeader) return `points: no points column in the export -- all ${total} rows unreadable, the import will be refused`;
  if (!points.columnAlive) return `points: the points column is present but empty in all ${total} rows -- treating them as unreadable, not as zero, so the import will be refused`;
  return `points: ${points.readable} with a value, ${points.blankAsZero} blank read as zero (PassKit writes no "0")`;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const dryRun = args.includes('--dry-run');
  const only = opt('--only', null);
  const base = (opt('--base', process.env.BASE_URL || '')).replace(/\/+$/, '');
  const secretFile = opt('--secret-file', null);
  const secret = process.env.ADMIN_SECRET || (secretFile ? fs.readFileSync(secretFile.replace(/^~/, process.env.HOME), 'utf8').trim() : '');
  if (!file || !base || !secret) { console.error('usage: node scripts/import-passkit.mjs <export.csv> --base <url> --secret-file <path> [--dry-run] [--only <id>]'); process.exit(1); }

  const records = parseCsv(fs.readFileSync(file, 'utf8'));
  // Mapped before --only is applied, so one-member runs still judge the
  // points column against the whole export rather than a single row.
  const { members: all, points } = mapRecords(records);
  const members = only ? all.filter((m) => m.passkit_member_id === only) : all;
  console.log(`${records.length} rows in the file, ${members.length} to send${dryRun ? ' (dry run)' : ''}`);
  console.log(describePoints(points, records.length));

  const totals = { received: 0, created: 0, updated: 0, unchanged: 0, linked: 0, skipped: 0, email_dropped: 0, unreadable_points: 0, would_zero: 0, problems: [] };
  for (let i = 0; i < members.length; i += 500) {
    const batch = members.slice(i, i + 500);
    const resp = await fetch(`${base}/api/admin/import`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-secret': secret }, body: JSON.stringify({ members: batch, dry_run: dryRun }) });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) { console.error(`batch ${i / 500 + 1}: HTTP ${resp.status}`, JSON.stringify(data).slice(0, 500)); process.exit(2); }
    for (const k of ['received', 'created', 'updated', 'unchanged', 'linked', 'skipped', 'email_dropped', 'unreadable_points', 'would_zero']) totals[k] += data[k] || 0;
    totals.problems.push(...(data.problems || []));
    console.log(`batch ${i / 500 + 1}: created ${data.created}, updated ${data.updated}, unchanged ${data.unchanged}, linked ${data.linked}, skipped ${data.skipped}${data.email_dropped ? `, email dropped ${data.email_dropped}` : ''}${data.would_zero ? `, dropped to zero ${data.would_zero}` : ''}`);
  }
  console.log('TOTAL', JSON.stringify({ ...totals, problems: totals.problems.length }));
  if (totals.would_zero) console.log(`NOTE: ${totals.would_zero} member${totals.would_zero === 1 ? '' : 's'} had a balance written down to zero. If that is not what you meant, check the points column in the export.`);
  if (totals.problems.length) console.log('first problems:', JSON.stringify(totals.problems.slice(0, 10)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

#!/usr/bin/env node
/**
 * npm audit, with the advisories we have already assessed written down.
 *
 * `npm audit --audit-level=high` cannot simply be added to `npm run verify`:
 * there are three high-severity advisories with no non-breaking fix, so the
 * gate would be red permanently and everyone would learn to ignore it. This
 * instead fails only on an advisory that is *not* in ACCEPTED below, so a new
 * one surfaces on its own while the known ones stay documented rather than
 * merely tolerated.
 *
 * Each accepted entry has to say why it is accepted and when to look again.
 * Past its RECHECK date the check fails, which is the point: an accepted
 * advisory is a decision with an expiry, not a permanent exemption.
 *
 * Network failures are reported and skipped, so `npm run verify` still works
 * offline and on a plane.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

// exec rather than execFile: a fixed command string with nothing interpolated
// into it, which is also what lets `npm` resolve as npm.cmd on Windows.
const run = promisify(exec);

const RECHECK = '2027-01-15';

const ACCEPTED = {
  'GHSA-6w3j-5fw6-r9vr': {
    what: 'joi: prototype pollution via a __proto__ language key in custom messages',
    why: 'Reached only through joi custom messages. passkit-generator passes none: its lib/cjs/messages.js holds its own error strings, not joi message overrides, and nothing in this repo calls joi directly.',
  },
  'GHSA-wr44-6hxh-3jwq': {
    what: 'joi: messages compilation allows prototype replacement through __proto__ error codes',
    why: 'Same surface as GHSA-6w3j-5fw6-r9vr: no custom joi messages anywhere in the dependency path.',
  },
  'GHSA-gg4h-3hg2-grpc': {
    what: 'joi: object().rename() with a template target can set the validated object prototype',
    why: 'object().rename() is not used: zero occurrences in passkit-generator, and we do not call joi ourselves.',
  },
  'GHSA-6h2x-m376-mqjq': {
    what: 'joi: quadratic regular-expression backtracking in Joi.string().isoDate()',
    why: 'isoDate() is in passkit-generator schemas (startDate, endDate, date, relevantDate), but lib/pass.js sets no date field on any pass, so no attacker-controlled string ever reaches one. The member-supplied values we do pass (full_name) are validated as plain strings.',
  },
  'GHSA-86w9-cpqp-85rv': {
    what: 'node-forge: RSA PKCS#1 v1.5 signature verification accepts extra nested DigestAlgorithm elements',
    why: 'No patched release exists -- the advisory covers every version, including the current 1.4.0 -- so there is nothing to upgrade to. It is a flaw in signature *verification*; here node-forge only signs (the .pkpass, and the throwaway dev certificate in scripts/selfsigned-cert.js). We never verify a third-party signature with it.',
  },
};

// Why not pin a patched joi: passkit-generator depends on an exact 17.13.4,
// and the only version outside the vulnerable range is joi 18, a major bump.
// An override to ^18.2.9 was tried and the whole suite passed, including the
// real sign-and-zip round trip with manifest verification -- but it clears no
// reachable risk (see each entry above), it cannot make the audit clean while
// node-forge has no fix at all, and it would run the library that signs
// production Wallet passes against a major version its author did not pin.
// Not worth it. Revisit when passkit-generator moves, which is what RECHECK
// is for.

function advisories(report) {
  const found = new Map();
  for (const vuln of Object.values(report.vulnerabilities || {})) {
    for (const via of vuln.via || []) {
      if (typeof via !== 'object' || !via.url) continue;
      const id = String(via.url).split('/').pop();
      if (!found.has(id)) found.set(id, { id, severity: via.severity, title: via.title, package: via.name });
    }
  }
  return found;
}

async function audit() {
  try {
    // npm audit exits non-zero when it finds anything, so take stdout either way.
    const { stdout } = await run('npm audit --json', { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (err) {
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {
        /* fall through to the offline path */
      }
    }
    return null;
  }
}

const report = await audit();
if (!report || !report.vulnerabilities) {
  console.log('audit: skipped (npm audit did not return a report -- offline?)');
  process.exit(0);
}

const found = advisories(report);
const unexpected = [...found.values()].filter((a) => !ACCEPTED[a.id]);
const gone = Object.keys(ACCEPTED).filter((id) => !found.has(id));
const expired = Date.now() > Date.parse(RECHECK + 'T00:00:00Z');

console.log(`audit: ${found.size} advisor${found.size === 1 ? 'y' : 'ies'}, ${found.size - unexpected.length} already assessed`);

for (const a of unexpected) {
  console.error(`  NEW  ${a.severity.padEnd(8)} ${a.id}  ${a.package}: ${a.title}`);
}
if (gone.length) {
  console.log(`  ${gone.length} accepted advisor${gone.length === 1 ? 'y has' : 'ies have'} gone away -- remove from ACCEPTED in this file: ${gone.join(', ')}`);
}

if (unexpected.length) {
  console.error(`\naudit: ${unexpected.length} advisory not assessed. Trace whether it is reachable, then either fix it or add it to ACCEPTED in scripts/audit-check.mjs with the reason.`);
  process.exit(1);
}
if (expired) {
  console.error(`\naudit: the accepted advisories were last assessed for ${RECHECK}, which has passed. Re-check them (has passkit-generator moved off joi 17.13.4 and node-forge?) and set a new RECHECK date.`);
  process.exit(1);
}
console.log(`audit: ok (next review ${RECHECK})`);

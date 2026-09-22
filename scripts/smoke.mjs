#!/usr/bin/env node
/**
 * Smoke test for the loyalty API without a camera.
 *
 *   node scripts/smoke.mjs <base-url> <qr-data> [--add N] [--redeem]
 *
 * Example against a preview deployment, using a PassKit TEST member:
 *   node scripts/smoke.mjs https://qr-scanner-git-feat-passkit-direct-api-efficeicnais-projects.vercel.app 3B4tGqZ1bM9xK2pLqR8sT0 --add 1
 *
 * Preview deployments on this project are behind Vercel Authentication. Either
 * log in to Vercel in the browser, or pass a Protection Bypass secret:
 *   VERCEL_BYPASS=<secret> node scripts/smoke.mjs ...
 *
 * WARNING: --add and --redeem change a real PassKit balance. Use a test member.
 */

const [base, qr, ...flags] = process.argv.slice(2);
if (!base || !qr) {
  console.error('usage: node scripts/smoke.mjs <base-url> <qr-data> [--add N] [--redeem]');
  process.exit(1);
}

const addIdx = flags.indexOf('--add');
const add = addIdx >= 0 ? parseInt(flags[addIdx + 1], 10) : 0;
const redeem = flags.includes('--redeem');
const url = base.replace(/\/+$/, '') + '/api/loyalty';

async function call(payload) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.VERCEL_BYPASS) headers['x-vercel-protection-bypass'] = process.env.VERCEL_BYPASS;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...payload, timestamp: new Date().toISOString() }),
  });
  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  console.log(`${payload.action} -> HTTP ${resp.status}`, JSON.stringify(data));
  return data;
}

await call({ action: 'lookup_customer', qr_data: qr });
if (add > 0) {
  await call({ action: 'add_points', qr_data: qr, points: add });
  await call({ action: 'lookup_customer', qr_data: qr });
}
if (redeem) {
  await call({ action: 'redeem_points', qr_data: qr, points_to_remove: 9 });
  await call({ action: 'lookup_customer', qr_data: qr });
}

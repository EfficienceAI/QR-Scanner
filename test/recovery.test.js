const { test } = require('node:test');
const assert = require('node:assert/strict');
const rec = require('../lib/recovery');

const env = { RESEND_API_KEY: 'key', RESEND_FROM: 'La Bottega Milanese <loyalty@example.com>' };
function world(extra = {}) {
  const row = { id: 'b24101aa-16a1-4d8d-a42f-5610b6cf787a', email: 'yunus@example.com', full_name: 'Yunus', points: 5, pass_serial: 'LBM-1', download_token: 'old-token', recovery_attempts: 0, ...extra };
  const sent = [];
  const db = { update: async (table, q, patch) => { Object.assign(row, patch); return [{ ...row }]; } };
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{"id":"e1"}' }; };
  return { row, sent, db, fetchImpl };
}

test('settings and masking', () => {
  assert.equal(rec.settings({}).enabled, false);
  assert.equal(rec.settings(env).enabled, true);
  assert.equal(rec.maskEmail('yunus@example.com'), 'y•••@example.com');
  assert.equal(rec.maskEmail('nope'), null);
});

test('a code is stored hashed, emailed to the card\'s address, and throttled to one a minute', async () => {
  const w = world();
  let now = 1_000_000_000_000;
  const r1 = await rec.startRecovery(w.row, { db: w.db, env, fetchImpl: w.fetchImpl, now: () => now });
  assert.deepEqual(r1, { sent: true, hint: 'y•••@example.com' });
  assert.equal(w.sent.length, 1);
  assert.deepEqual(w.sent[0].to, ['yunus@example.com']);
  const code = /\b(\d{6})\b/.exec(w.sent[0].text)[1];
  assert.equal(w.row.recovery_code_hash, rec._internals.hashCode(w.row.id, code), 'the stored value is a hash, not the code');
  assert.ok(!JSON.stringify(w.row).includes(code), 'the code itself is nowhere in the row');
  now += 30_000;
  const r2 = await rec.startRecovery(w.row, { db: w.db, env, fetchImpl: w.fetchImpl, now: () => now });
  assert.equal(r2.sent, false); assert.equal(r2.reason, 'throttled'); assert.equal(w.sent.length, 1);
  now += 31_000;
  const r3 = await rec.startRecovery(w.row, { db: w.db, env, fetchImpl: w.fetchImpl, now: () => now });
  assert.equal(r3.sent, true); assert.equal(w.sent.length, 2);
  assert.deepEqual(await rec.startRecovery({ id: 'x', email: null }, { db: w.db, env, fetchImpl: w.fetchImpl }), { sent: false, reason: 'no_email', hint: null });
});

test('verify: right code rotates the link and clears the code; wrong codes count; expiry and the cap hold', async () => {
  const w = world();
  let now = 1_000_000_000_000;
  await rec.startRecovery(w.row, { db: w.db, env, fetchImpl: w.fetchImpl, now: () => now });
  const code = /\b(\d{6})\b/.exec(w.sent[0].text)[1];
  const wrongCode = code === '000000' ? '111111' : '000000';
  assert.equal(await rec.verifyCode(w.row, wrongCode, { db: w.db, now: () => now }), null);
  assert.equal(w.row.recovery_attempts, 1);
  assert.equal(await rec.verifyCode(w.row, '12', { db: w.db, now: () => now }), null, 'malformed');
  const fresh = await rec.verifyCode(w.row, code.slice(0, 3) + ' ' + code.slice(3), { db: w.db, now: () => now });
  assert.ok(fresh, 'spaces in the code are fine');
  assert.notEqual(fresh.download_token, 'old-token', 'the link is rotated');
  assert.equal(fresh.recovery_code_hash, null);
  assert.equal(await rec.verifyCode(w.row, code, { db: w.db, now: () => now }), null, 'a used code is dead');
  // expiry
  const w2 = world();
  await rec.startRecovery(w2.row, { db: w2.db, env, fetchImpl: w2.fetchImpl, now: () => now });
  const code2 = /\b(\d{6})\b/.exec(w2.sent[0].text)[1];
  assert.equal(await rec.verifyCode(w2.row, code2, { db: w2.db, now: () => now + rec._internals.CODE_TTL_MS + 1 }), null, 'expired');
  // attempts cap
  const w3 = world();
  await rec.startRecovery(w3.row, { db: w3.db, env, fetchImpl: w3.fetchImpl, now: () => now });
  const code3 = /\b(\d{6})\b/.exec(w3.sent[0].text)[1];
  const wrong3 = code3 === '000000' ? '111111' : '000000';
  for (let i = 0; i < rec._internals.MAX_ATTEMPTS; i += 1) await rec.verifyCode(w3.row, wrong3, { db: w3.db, now: () => now });
  assert.equal(await rec.verifyCode(w3.row, code3, { db: w3.db, now: () => now }), null, 'five wrong tries lock the code even for the right one');
});

test('a Resend failure is thrown, not swallowed', async () => {
  const w = world();
  const failing = async () => ({ ok: false, status: 422, text: async () => '{"message":"bad from"}' });
  await assert.rejects(() => rec.startRecovery(w.row, { db: w.db, env, fetchImpl: failing }), /Resend 422/);
});

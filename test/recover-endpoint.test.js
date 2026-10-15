const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../api/recover');
const join = require('../api/join');

function res() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } }; }
const member = { id: 'b24101aa-16a1-4d8d-a42f-5610b6cf787a', email: 'yunus@example.com', phone: '+447700900123', full_name: 'Yunus', points: 5, pass_serial: 'LBM-1', download_token: 'tok' };
function world({ enabled = true } = {}) {
  const calls = [];
  const db = {
    enabled: () => true,
    selectOne: async (table, q) => (q.includes('email_norm=eq.yunus%40example.com') || q.includes('phone=eq.%2B447700900123') ? { ...member } : null),
  };
  const recovery = {
    settings: () => ({ enabled }),
    startRecovery: async (m) => { calls.push(['start', m.id]); return { sent: true, hint: 'y•••@example.com' }; },
    verifyCode: async (m, code) => { calls.push(['verify', m.id, code]); return code === '123456' ? { ...member, download_token: 'new-tok' } : null; },
  };
  return { calls, handler: createHandler({ db, recovery, env: { PUBLIC_BASE_URL: 'https://x.test' } }) };
}

test('asking for a code: same answer for a known email, a known number and an unknown email', async () => {
  join._internals.hits.clear();
  const w = world();
  const headers = { 'x-forwarded-for': '9.9.9.9' };
  let r = res(); await w.handler({ method: 'POST', headers, body: { email: 'Yunus@Example.com' } }, r);
  assert.equal(r.statusCode, 200); assert.deepEqual(r.body, { ok: true, sent: true, hint: 'y•••@example.com' });
  r = res(); await w.handler({ method: 'POST', headers, body: { phone: '07700 900123' } }, r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.sent, true);
  r = res(); await w.handler({ method: 'POST', headers, body: { email: 'nobody@example.com' } }, r);
  assert.equal(r.statusCode, 200); assert.deepEqual(r.body, { ok: true, sent: true, hint: null });
  assert.deepEqual(w.calls.map((c) => c[0]), ['start', 'start'], 'nothing was sent for the unknown email');
  r = res(); await w.handler({ method: 'POST', headers, body: {} }, r); assert.equal(r.statusCode, 400);
});

test('the right code returns the card and its links; a wrong one is refused; off means 503', async () => {
  join._internals.hits.clear();
  const w = world();
  const headers = { 'x-forwarded-for': '8.8.8.8' };
  let r = res(); await w.handler({ method: 'POST', headers, body: { email: 'yunus@example.com', code: '000000' } }, r);
  assert.equal(r.statusCode, 400); assert.equal(r.body.error, 'bad_code');
  r = res(); await w.handler({ method: 'POST', headers, body: { phone: '+447700900123', code: '123456' } }, r);
  assert.equal(r.statusCode, 200); assert.equal(r.body.recovered, true); assert.equal(r.body.member.name, 'Yunus');
  assert.equal(r.body.passUrl, '/api/pass/LBM-1?t=new-tok');
  r = res(); await w.handler({ method: 'POST', headers, body: { email: 'nobody@example.com', code: '123456' } }, r);
  assert.equal(r.statusCode, 400, 'no card, no recovery');
  const off = world({ enabled: false });
  r = res(); await off.handler({ method: 'POST', headers, body: { email: 'yunus@example.com' } }, r);
  assert.equal(r.statusCode, 503);
});

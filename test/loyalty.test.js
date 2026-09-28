const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.PASSKIT_API_KEY = 'k'; process.env.PASSKIT_API_SECRET = 's';
process.env.SUPABASE_URL = ''; process.env.SUPABASE_SERVICE_KEY = '';
const handler = require('../api/loyalty');

function fakePassKit(db) {
  return async (url, init) => {
    const u = new URL(url);
    const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    let m;
    if ((m = u.pathname.match(/^\/members\/member\/id\/(.+)$/))) { const r = db[decodeURIComponent(m[1])]; return r ? json(200, r) : json(404, { message: 'no member record found' }); }
    if (u.pathname.startsWith('/members/program/list/events/')) return { ok: true, status: 200, text: async () => '' };
    if (u.pathname === '/members/member/points/earn' || u.pathname === '/members/member/points/burn') {
      const b = JSON.parse(init.body); const r = db[b.id]; if (!r) return json(404, { message: 'no member' });
      r.points += u.pathname.endsWith('earn') ? b.points : -b.points;
      return json(200, { id: r.id, points: r.points });
    }
    return json(404, { message: 'no route' });
  };
}
async function invoke(body) {
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(x) { this.body = x ? JSON.parse(x) : null; } };
  await handler({ method: 'POST', body }, res);
  return res;
}

test('remove_points burns points, refuses to go below zero, and add_points still earns', async () => {
  const db = { M1: { id: 'M1', programId: 'P', tierId: 't', points: 5, status: 'ENROLLED', person: { displayName: 'A B' } } };
  global.fetch = fakePassKit(db);
  let r = await invoke({ action: 'remove_points', qr_data: 'M1', points: 3 });
  assert.equal(r.statusCode, 200); assert.equal(r.body.removed, 3); assert.equal(r.body.points, 2);
  r = await invoke({ action: 'remove_points', qr_data: 'M1', points: 5 });
  assert.equal(r.statusCode, 409); assert.equal(r.body.error, 'insufficient_points'); assert.equal(r.body.points, 2);
  r = await invoke({ action: 'remove_points', qr_data: 'M1', points: 0 });
  assert.equal(r.statusCode, 400);
  r = await invoke({ action: 'add_points', qr_data: 'M1', points: 4 });
  assert.equal(r.statusCode, 200); assert.equal(r.body.points, 6);
  r = await invoke({ action: 'lookup_customer', qr_data: 'M1' });
  assert.equal(r.statusCode, 200); assert.equal(r.body.points, 6); assert.equal(r.body.member.name, 'A B');
});

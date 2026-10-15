const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../api/admin/member');

function res() { return { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b ? JSON.parse(b) : null; } }; }
const row = { id: 'u1', full_name: 'Yunus Tufail', email: 'y@t.com', points: 5, status: 'active', source: 'passkit-import', pass_serial: '16dm9KIQ7haLWTVgchJPHI', passkit_member_id: '16dm9KIQ7haLWTVgchJPHI', download_token: 'tok', created_at: '2026-10-11T10:00:00Z' };
const db = {
  enabled: () => true,
  selectOne: async (table, q) => (/passkit_member_id=eq\.16dm9KIQ7haLWTVgchJPHI|email_norm=eq\.y%40t\.com|pass_serial=eq\.16dm9KIQ7haLWTVgchJPHI/.test(q) ? row : null),
  select: async (table, q) => (table === 'pass_registrations' ? [{ push_token: 'p' }] : []),
};

test('finds a member by PassKit id, email or serial and returns their pass link', async () => {
  const h = createHandler({ db, env: { ADMIN_SECRET: 's', PUBLIC_BASE_URL: 'https://lbm-loyalty.vercel.app/' } });
  for (const url of ['/api/admin/member?passkit_id=16dm9KIQ7haLWTVgchJPHI', '/api/admin/member?email=Y%40T.com', '/api/admin/member?serial=16dm9KIQ7haLWTVgchJPHI']) {
    const r = res(); await h({ method: 'GET', url, headers: { 'x-admin-secret': 's' } }, r);
    assert.equal(r.statusCode, 200, url);
    assert.equal(r.body.member.name, 'Yunus Tufail'); assert.equal(r.body.member.devices, 1);
    assert.equal(r.body.passUrl, 'https://lbm-loyalty.vercel.app/api/pass/16dm9KIQ7haLWTVgchJPHI?t=tok');
  }
  let r = res(); await h({ method: 'GET', url: '/api/admin/member?passkit_id=nobody0000', headers: { 'x-admin-secret': 's' } }, r); assert.equal(r.statusCode, 404);
  r = res(); await h({ method: 'GET', url: '/api/admin/member', headers: { 'x-admin-secret': 's' } }, r); assert.equal(r.statusCode, 400);
  r = res(); await h({ method: 'GET', url: '/api/admin/member?email=y@t.com', headers: {} }, r); assert.equal(r.statusCode, 401);
  r = res(); await h({ method: 'POST', url: '/api/admin/member', headers: { 'x-admin-secret': 's' } }, r); assert.equal(r.statusCode, 405);
});

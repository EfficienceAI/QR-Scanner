const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../lib/members');

test('phone numbers normalise to E.164, UK first', () => {
  assert.equal(M.normalizePhone('07700 900123'), '+447700900123');
  assert.equal(M.normalizePhone('+44 7700 900123'), '+447700900123');
  assert.equal(M.normalizePhone('0044 (0)7700-900123'.replace('(0)', '')), '+447700900123');
  assert.equal(M.normalizePhone('447700900123'), '+447700900123');
  assert.equal(M.normalizePhone('+1 (415) 555-0199'), '+14155550199');
  assert.equal(M.normalizePhone('hello'), null);
  assert.equal(M.normalizePhone('12345'), null);
  assert.equal(M.normalizePhone(''), null);
});

test('join validation returns per-field errors and clean values', () => {
  const bad = M.validateJoin({ full_name: 'A', email: 'nope', phone: 'x' });
  assert.equal(bad.ok, false);
  assert.deepEqual(Object.keys(bad.errors).sort(), ['email', 'full_name', 'phone']);
  const good = M.validateJoin({ full_name: '  Yunus   Tufail ', email: ' Yunus@Example.COM ', phone: '07700 900123', consent: 'on' });
  assert.equal(good.ok, true);
  assert.deepEqual(good.values, { full_name: 'Yunus Tufail', email: 'yunus@example.com', phone: '+447700900123', consent_marketing: true });
});

test('serials, tokens and the QR message', () => {
  const s = M.newSerial();
  assert.match(s, /^LBM-[A-HJ-NP-Z2-9]{10}$/);
  assert.notEqual(M.newSerial(), s);
  assert.ok(M.newToken().length >= 30);
  const id = '3f2a9c7e-1b2d-4e5f-8a9b-0c1d2e3f4a5b';
  assert.equal(M.qrMessage({ id }), 'LBM:' + id);
  assert.equal(M.memberIdFromQr('LBM:' + id.toUpperCase()), id);
  assert.equal(M.memberIdFromQr('16dm9KIQ7haLWTVgchJPHI'), null, 'a PassKit id is not ours');
  assert.equal(M.memberIdFromQr('LBM:not-a-uuid'), null);
  assert.equal(M.timingSafeEqual('abc', 'abc'), true);
  assert.equal(M.timingSafeEqual('abc', 'abd'), false);
  assert.equal(M.timingSafeEqual('', ''), false);
});

test('createMember inserts tokens and adjustPoints maps database errors', async () => {
  const calls = [];
  const db = {
    enabled: () => true,
    insert: async (table, row) => { calls.push(['insert', table, row]); return { id: 'uuid-1', points: 0, ...row }; },
    rpc: async (fn, args) => { calls.push(['rpc', fn, args]); if (args.p_delta < -5) throw new M.DbError(400, 'insufficient_points'); if (args.p_member === 'missing') throw new M.DbError(400, 'member_not_found'); return [{ points: 5 + args.p_delta }]; },
  };
  const m = await M.createMember({ full_name: 'A B', email: 'a@b.co', phone: '+447700900123', consent_marketing: false }, { db });
  assert.equal(calls[0][1], 'members');
  assert.match(m.pass_serial, /^LBM-/);
  assert.ok(m.pass_auth_token.length >= 16, 'Apple needs a 16+ character authenticationToken');
  assert.ok(m.download_token && m.download_token !== m.pass_auth_token);
  assert.equal(await M.adjustPoints('uuid-1', 2, { db }), 7);
  await assert.rejects(() => M.adjustPoints('uuid-1', -9, { db }), M.InsufficientPointsError);
  await assert.rejects(() => M.adjustPoints('missing', 1, { db }), M.NotFoundError);
});

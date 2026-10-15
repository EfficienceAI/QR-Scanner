// The scanner API routes "LBM:" QRs to the members table and everything else
// to PassKit, through the real modules with PostgREST and PassKit stubbed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.PASSKIT_API_KEY = 'k'; process.env.PASSKIT_API_SECRET = 's';
process.env.SUPABASE_URL = 'https://db.test'; process.env.SUPABASE_SERVICE_KEY = 'service';
const handler = require('../api/loyalty');

const UUID = 'b24101aa-16a1-4d8d-a42f-5610b6cf787a';
const PK = '16dm9KIQ7haLWTVgchJPHI';

function stubWorld() {
  const member = { id: UUID, full_name: 'Yunus', points: 0, status: 'active', pass_serial: PK, passkit_member_id: PK, created_at: '2026-10-09T15:12:36Z' };
  const passkit = { [PK]: { id: PK, programId: 'P', points: 5, person: { forename: 'Yunus' } } };
  const ledger = []; const patches = [];
  const json = (status, body) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  global.fetch = async (rawUrl, init = {}) => {
    const url = new URL(String(rawUrl)); const p = url.pathname; const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    if (p === '/rest/v1/members' && method === 'GET') {
      const id = url.searchParams.get('id'); const pk = url.searchParams.get('passkit_member_id');
      if (id === `eq.${UUID}` || pk === `eq.${PK}`) return json(200, [{ ...member }]);
      return json(200, []);
    }
    if (p === '/rest/v1/members' && method === 'PATCH') { patches.push(body); Object.assign(member, body); return json(200, [{ ...member }]); }
    if (p === '/rest/v1/rpc/adjust_member_points') { member.points += body.p_delta; return json(200, [{ points: member.points }]); }
    if (p === '/rest/v1/scan_events' && method === 'GET') return json(200, ledger.filter((r) => (url.searchParams.get('member_id') || '').includes(`"${r.member_id}"`)).map((r) => ({ action: r.action, points: r.points, occurred_at: r.occurred_at })));
    if (p === '/rest/v1/scan_events') { ledger.push(...body); return json(201, ''); }
    if (p === '/rest/v1/pass_registrations') return json(200, []);
    let m;
    if ((m = p.match(/^\/members\/member\/id\/(.+)$/))) { const r = passkit[decodeURIComponent(m[1])]; return r ? json(200, r) : json(404, { message: 'no member record found' }); }
    if (p.startsWith('/members/program/list/events/')) return json(200, '');
    if (p === '/members/member/points/earn' || p === '/members/member/points/burn') { const r = passkit[body.id]; r.points += p.endsWith('earn') ? body.points : -body.points; return json(200, { id: r.id, points: r.points }); }
    return json(404, { message: 'no route ' + p });
  };
  return { member, passkit, ledger, patches };
}
async function invoke(body) {
  const res = { statusCode: 0, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(x) { this.body = x ? JSON.parse(x) : null; } };
  await handler({ method: 'POST', body, headers: {} }, res);
  return res;
}

test('an LBM: QR is served from the members table, and a linked PassKit record follows it', async () => {
  const w = stubWorld();
  const look = await invoke({ action: 'lookup_customer', qr_data: `LBM:${UUID}`, request_id: 'n1' });
  assert.equal(look.statusCode, 200);
  assert.equal(look.body.member.native, true);
  assert.equal(look.body.member.name, 'Yunus');
  assert.equal(look.body.points, 0);
  assert.equal(look.body.history.recorded, true);
  const add = await invoke({ action: 'add_points', qr_data: `LBM:${UUID}`, points: 2, request_id: 'n2' });
  assert.deepEqual(add.body, { ok: true, action: 'add_points', added: 2, points: 2 });
  assert.equal(w.passkit[PK].points, 7, 'the linked PassKit record follows the native scan (overlap period)');
  const again = await invoke({ action: 'lookup_customer', qr_data: `LBM:${UUID}`, request_id: 'n3' });
  assert.equal(again.body.history.visits, 1, 'the add is now a visit in our own history');
  assert.deepEqual(w.ledger.map((r) => [r.action, r.member_id, r.external_id]), [['lookup', UUID, 'scan:n1'], ['add', UUID, 'scan:n2'], ['lookup', UUID, 'scan:n3']]);
});

test('a PassKit QR still goes to PassKit, and the imported copy is mirrored after the reply', async () => {
  const w = stubWorld();
  const add = await invoke({ action: 'add_points', qr_data: PK, points: 1, request_id: 'p1' });
  assert.deepEqual(add.body, { ok: true, action: 'add_points', added: 1, points: 6 });
  assert.equal(w.passkit[PK].points, 6);
  assert.equal(w.member.points, 6, 'our row now matches PassKit');
  assert.equal(w.patches.length, 1); assert.ok(w.patches[0].last_visit_at, 'an add is a visit');
  const redeem = await invoke({ action: 'redeem_points', qr_data: PK, points_to_remove: 9, request_id: 'p2' });
  assert.equal(redeem.statusCode, 409, 'PassKit balance 6 < 9');
  w.passkit[PK].points = 9;
  const ok = await invoke({ action: 'redeem_points', qr_data: PK, points_to_remove: 9, request_id: 'p3' });
  assert.equal(ok.body.points, 0); assert.equal(w.member.points, 0); assert.equal(w.patches.length, 2); assert.equal(w.patches[1].last_visit_at, undefined);
});

test('an unreadable PassKit balance is not mirrored, so an imported member is never zeroed', async () => {
  // H1, end to end. num() answers 0 for anything unreadable, and syncPoints
  // is an absolute SET, so PassKit replying 200 with no usable `points` used
  // to zero the imported member -- the longest-standing customers -- and push
  // the zero to their phone. The ledger records the +1 delta, not the
  // overwrite, so nobody could reconstruct the balance afterwards.
  for (const unreadable of [undefined, null, '', 'n/a', {}]) {
    const w = stubWorld();
    w.member.points = 13;
    const earn = global.fetch;
    global.fetch = async (rawUrl, init = {}) => {
      const p = new URL(String(rawUrl)).pathname;
      if (p === '/members/member/points/earn') return { ok: true, status: 200, text: async () => JSON.stringify({ id: PK, points: unreadable }) };
      return earn(rawUrl, init);
    };
    const r = await invoke({ action: 'add_points', qr_data: PK, points: 1, request_id: 'u' + String(unreadable) });
    assert.equal(r.statusCode, 200, 'the scan still succeeds');
    assert.equal(w.member.points, 13, `balance survived an unreadable ${JSON.stringify(unreadable)}`);
    assert.ok(!w.patches.some((x) => x.points !== undefined), 'no balance was written at all');
  }

  // A readable 0 is a real balance and still mirrors.
  const w = stubWorld();
  w.member.points = 13; w.passkit[PK].points = 1;
  const r = await invoke({ action: 'redeem_points', qr_data: PK, points_to_remove: 1, request_id: 'zero' });
  assert.equal(r.statusCode, 409, 'below the redeem cost');
  w.passkit[PK].points = 9;
  await invoke({ action: 'redeem_points', qr_data: PK, points_to_remove: 9, request_id: 'zero2' });
  assert.equal(w.member.points, 0, 'a genuine zero from PassKit is still mirrored');
});

test('a malformed LBM: QR is not a native scan', async () => {
  stubWorld();
  const r = await invoke({ action: 'lookup_customer', qr_data: 'LBM:not-a-uuid' });
  assert.equal(r.statusCode, 404, 'falls through to PassKit, which does not know it');
});

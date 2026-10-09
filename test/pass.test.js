const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const passLib = require('../lib/pass');
const { makeSelfSignedPassCert } = require('../scripts/selfsigned-cert');

const member = {
  id: '3f2a9c7e-1b2d-4e5f-8a9b-0c1d2e3f4a5b', full_name: 'Yunus Tufail', points: 4,
  pass_serial: 'LBM-ABCDEFGHJK', pass_auth_token: 'tok_0123456789abcdefghij', download_token: 'dl', created_at: '2026-03-01T11:50:51Z', pass_updated_at: '2026-10-05T10:00:00Z',
};
const env = { APPLE_TEAM_ID: 'TEAM123456', PASS_TYPE_ID: 'pass.com.example.loyalty', PUBLIC_BASE_URL: 'https://loyalty.example.com/', LOYALTY_REDEEM_COST: '9' };

test('pass.json carries the identifiers, the QR and the stamp copy', () => {
  const s = passLib.settings(env);
  const j = passLib.buildPassJson(member, s);
  assert.equal(j.passTypeIdentifier, 'pass.com.example.loyalty');
  assert.equal(j.teamIdentifier, 'TEAM123456');
  assert.equal(j.serialNumber, 'LBM-ABCDEFGHJK');
  assert.equal(j.authenticationToken, member.pass_auth_token);
  assert.equal(j.webServiceURL, 'https://loyalty.example.com/api/wallet');
  assert.equal(j.barcodes[0].message, 'LBM:' + member.id);
  assert.equal(j.barcodes[0].format, 'PKBarcodeFormatQR');
  assert.equal(j.storeCard.headerFields[0].label, 'POINTS');
  assert.equal(j.storeCard.headerFields[0].value, 4);
  assert.deepEqual(j.storeCard.secondaryFields.map((f) => [f.label, f.value]), [['FIRST NAME', 'Yunus'], ['LAST NAME', 'Tufail']]);
  assert.equal(j.logoText, undefined, 'no logo text: the logo image carries the wordmark');
  assert.equal(passLib.buildPassJson(member, passLib.settings({ ...env, PASS_LOGO_TEXT: 'La Bottega' })).logoText, 'La Bottega');
  assert.equal(j.backgroundColor, 'rgb(0, 0, 0)');
  assert.deepEqual(j.storeCard.backFields[0], { key: 'reward', label: 'NEXT FREE DRINK', value: '5 more stamps' });
  assert.equal(passLib.rewardCopy(9, 9).value, 'Free drink ready');
  assert.equal(passLib.rewardCopy(8, 9).value, '1 more stamp');
  assert.equal(j.sharingProhibited, true);
  assert.equal(j.storeCard.backFields.find((f) => f.key === 'since').value, 'Mar 2026');
  assert.deepEqual(passLib.splitName('Anna Maria de Luca'), { first: 'Anna', last: 'Maria de Luca' });
  assert.deepEqual(passLib.splitName(''), { first: 'Member', last: '' });
});

test('the strip shows the balance as filled beans, capped at the reward cost', () => {
  assert.equal(passLib.filledStamps(0, 9), 0);
  assert.equal(passLib.filledStamps(5, 9), 5);
  assert.equal(passLib.filledStamps(9, 9), 9);
  assert.equal(passLib.filledStamps(47, 9), 9);
  assert.equal(passLib.filledStamps(-2, 9), 0);
  const T = passLib._internals.templateImages;
  const five = T('default', 5), nine = T('default', 9), xmas = T('christmas', 0), full = T('default', 9);
  for (const f of ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@3x.png', 'strip.png', 'strip@2x.png', 'strip@3x.png']) assert.ok(five[f], `${f} present`);
  assert.notEqual(five['strip@3x.png'].toString('base64'), nine['strip@3x.png'].toString('base64'), 'different bean counts are different images');
  assert.equal(nine['strip@3x.png'].toString('base64'), full['strip@3x.png'].toString('base64'));
  assert.notEqual(xmas['strip.png'].toString('base64'), T('default', 0)['strip.png'].toString('base64'), 'themes differ');
  assert.ok(T('no-such-theme', 3)['strip.png'], 'unknown theme falls back to default');
});

test('theme resolution: explicit, auto by date, unknown', () => {
  assert.equal(passLib.resolveTheme('christmas'), 'christmas');
  assert.equal(passLib.resolveTheme('DEFAULT'), 'default');
  assert.equal(passLib.resolveTheme('rubbish'), 'default');
  assert.equal(passLib.resolveTheme('auto', new Date('2026-12-15T10:00:00Z')), 'christmas');
  assert.equal(passLib.resolveTheme('auto', new Date('2027-01-02T10:00:00Z')), 'christmas');
  assert.equal(passLib.resolveTheme('auto', new Date('2027-01-03T10:00:00Z')), 'default');
  assert.equal(passLib.resolveTheme('auto', new Date('2026-10-09T10:00:00Z')), 'default');
  assert.equal(passLib.settings({ PASS_THEME: 'christmas' }).theme, 'christmas');
});

test('missing configuration is named, not guessed', () => {
  assert.deepEqual(passLib.missingConfig(passLib.settings({})), ['APPLE_TEAM_ID', 'PASS_TYPE_ID', 'PUBLIC_BASE_URL', 'PASS_CERT_PEM_B64', 'PASS_KEY_PEM_B64']);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'certs', 'AppleWWDRCAG4.pem')), 'WWDR is bundled');
  assert.equal(passLib._internals.pem('-----BEGIN X-----\nabc\n-----END X-----'), '-----BEGIN X-----\nabc\n-----END X-----');
  assert.equal(passLib._internals.pem(Buffer.from('-----BEGIN Y-----').toString('base64')), '-----BEGIN Y-----');
});

test('a pass signs, zips and carries a manifest that matches its files', async () => {
  const c = makeSelfSignedPassCert({ teamId: 'TEAM123456', passTypeId: 'pass.com.example.loyalty', bits: 1024 });
  const s = passLib.settings({ ...env, PASS_CERT_PEM_B64: Buffer.from(c.certPem).toString('base64'), PASS_KEY_PEM_B64: Buffer.from(c.keyPem).toString('base64') });
  const buf = await passLib.buildPkpass(member, { settings: s });
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK', 'a .pkpass is a zip');

  // minimal zip reader (stored or deflated entries, no zip64)
  const entries = {};
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const method = buf.readUInt16LE(off + 8), csize = buf.readUInt32LE(off + 18), nlen = buf.readUInt16LE(off + 26), xlen = buf.readUInt16LE(off + 28);
    const name = buf.subarray(off + 30, off + 30 + nlen).toString('utf8');
    const data = buf.subarray(off + 30 + nlen + xlen, off + 30 + nlen + xlen + csize);
    entries[name] = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    off += 30 + nlen + xlen + csize;
  }
  for (const f of ['pass.json', 'manifest.json', 'signature', 'icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'logo@3x.png', 'strip.png', 'strip@2x.png', 'strip@3x.png']) assert.ok(entries[f], `${f} present`);
  const manifest = JSON.parse(entries['manifest.json'].toString('utf8'));
  for (const [name, sha1] of Object.entries(manifest)) {
    assert.equal(crypto.createHash('sha1').update(entries[name]).digest('hex'), sha1, `manifest hash for ${name}`);
  }
  const json = JSON.parse(entries['pass.json'].toString('utf8'));
  assert.equal(json.serialNumber, 'LBM-ABCDEFGHJK');
  assert.ok(entries.signature.length > 200, 'PKCS#7 signature present');
});

test('buildPkpass refuses without certificates', async () => {
  await assert.rejects(() => passLib.buildPkpass(member, { settings: passLib.settings(env) }), (e) => e.code === 'not_configured' && e.missing.includes('PASS_CERT_PEM_B64'));
});

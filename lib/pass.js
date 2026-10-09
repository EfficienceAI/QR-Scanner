'use strict';

/**
 * Builds and signs the Apple Wallet pass for a member.
 *
 * pass.json is assembled here from the member row and a handful of env
 * settings; the artwork comes from pass-template/ (placeholders until the
 * real design is dropped in); signing uses the Pass Type ID certificate and
 * key from env (PEM, base64-encoded) plus Apple's WWDR G4 intermediate,
 * which is public and bundled in certs/.
 */

const fs = require('fs');
const path = require('path');
const { qrMessage } = require('./members');

const TEMPLATE_DIR = path.join(__dirname, '..', 'pass-template');
const WWDR_PATH = path.join(__dirname, '..', 'certs', 'AppleWWDRCAG4.pem');
const COMMON_FILES = ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'logo@3x.png'];
const SCALES = ['', '@2x', '@3x'];
const THEMES = ['default', 'christmas'];

function pem(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v.startsWith('-----BEGIN')) return v;
  try {
    return Buffer.from(v, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

/**
 * Which artwork set to use. PASS_THEME=default|christmas, or "auto" for
 * Christmas from 1 December to 2 January on the shop's clock.
 */
function resolveTheme(value, now = new Date()) {
  const v = String(value || 'default').toLowerCase();
  if (v === 'auto') {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', month: 'numeric', day: 'numeric' }).formatToParts(now);
    const m = Number(parts.find((x) => x.type === 'month').value);
    const d = Number(parts.find((x) => x.type === 'day').value);
    return m === 12 || (m === 1 && d <= 2) ? 'christmas' : 'default';
  }
  return THEMES.includes(v) ? v : 'default';
}

function settings(env = process.env) {
  const cost = parseInt(env.LOYALTY_REDEEM_COST, 10);
  return {
    teamId: env.APPLE_TEAM_ID || '',
    passTypeId: env.PASS_TYPE_ID || '',
    baseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    orgName: env.PASS_ORG_NAME || 'La Bottega Milanese',
    description: env.PASS_DESCRIPTION || 'La Bottega Milanese loyalty card',
    // The logo image carries the wordmark, so no logo text by default.
    logoText: env.PASS_LOGO_TEXT || '',
    backgroundColor: env.PASS_BACKGROUND_COLOR || 'rgb(0, 0, 0)',
    foregroundColor: env.PASS_FOREGROUND_COLOR || 'rgb(255, 255, 255)',
    labelColor: env.PASS_LABEL_COLOR || 'rgb(255, 255, 255)',
    theme: resolveTheme(env.PASS_THEME),
    supportText: env.PASS_SUPPORT_TEXT || 'Ask a member of staff.',
    redeemCost: Number.isFinite(cost) && cost > 0 ? cost : 9,
    certs: {
      wwdr: pem(env.PASS_WWDR_PEM_B64) || (fs.existsSync(WWDR_PATH) ? fs.readFileSync(WWDR_PATH, 'utf8') : ''),
      signerCert: pem(env.PASS_CERT_PEM_B64),
      signerKey: pem(env.PASS_KEY_PEM_B64),
      signerKeyPassphrase: env.PASS_KEY_PASSPHRASE || undefined,
    },
  };
}

function missingConfig(s = settings()) {
  const missing = [];
  if (!s.teamId) missing.push('APPLE_TEAM_ID');
  if (!s.passTypeId) missing.push('PASS_TYPE_ID');
  if (!s.baseUrl) missing.push('PUBLIC_BASE_URL');
  if (!s.certs.signerCert) missing.push('PASS_CERT_PEM_B64');
  if (!s.certs.signerKey) missing.push('PASS_KEY_PEM_B64');
  if (!s.certs.wwdr) missing.push('PASS_WWDR_PEM_B64');
  return missing;
}

function monthYear(iso) {
  const d = new Date(iso || Date.now());
  return d.toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'Europe/London' });
}

function rewardCopy(points, cost) {
  if (points >= cost) return { label: 'REWARD', value: 'Free drink ready' };
  const left = cost - points;
  return { label: 'NEXT FREE DRINK', value: `${left} more stamp${left === 1 ? '' : 's'}` };
}

/** How many of the nine beans are filled: the balance, capped at the reward cost, so 10s or 100s of points stay full. */
function filledStamps(points, cost) {
  return Math.max(0, Math.min(cost, Number(points) || 0));
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: 'Member', last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/** The pass.json object for a member. Pure: no I/O. Mirrors the layout of the current PassKit card. */
function buildPassJson(member, s = settings()) {
  const points = Number(member.points) || 0;
  const reward = rewardCopy(points, s.redeemCost);
  const name = splitName(member.full_name);
  const shortId = String(member.pass_serial || '').replace(/^LBM-/, '');
  const json = {
    formatVersion: 1,
    passTypeIdentifier: s.passTypeId,
    teamIdentifier: s.teamId,
    serialNumber: member.pass_serial,
    authenticationToken: member.pass_auth_token,
    webServiceURL: `${s.baseUrl}/api/wallet`,
    organizationName: s.orgName,
    description: s.description,
    backgroundColor: s.backgroundColor,
    foregroundColor: s.foregroundColor,
    labelColor: s.labelColor,
    sharingProhibited: true,
    barcodes: [{ message: qrMessage(member), format: 'PKBarcodeFormatQR', messageEncoding: 'iso-8859-1', altText: member.pass_serial }],
    barcode: { message: qrMessage(member), format: 'PKBarcodeFormatQR', messageEncoding: 'iso-8859-1', altText: member.pass_serial },
    storeCard: {
      headerFields: [{ key: 'points', label: 'POINTS', value: points, textAlignment: 'PKTextAlignmentRight' }],
      secondaryFields: [
        { key: 'first', label: 'FIRST NAME', value: name.first },
        { key: 'last', label: 'LAST NAME', value: name.last || ' ', textAlignment: 'PKTextAlignmentRight' },
      ],
      backFields: [
        { key: 'reward', label: reward.label, value: reward.value },
        { key: 'how', label: 'How it works', value: `Show this pass when you buy a coffee. Every coffee earns a point, and ${s.redeemCost} points earn a free drink.` },
        { key: 'since', label: 'Member since', value: monthYear(member.created_at) },
        { key: 'id', label: 'Member ID', value: shortId },
        { key: 'support', label: 'Questions', value: s.supportText },
      ],
    },
  };
  // Apple (and the library) reject an empty logoText; leave it out unless set.
  if (s.logoText) json.logoText = s.logoText;
  return json;
}

const imageCache = new Map(); // `${theme}:${filled}` -> files
/** logo + icon from pass-template/common, the strip with N beans filled from pass-template/<theme>. */
function templateImages(theme = 'default', filled = 0) {
  const key = `${theme}:${filled}`;
  if (imageCache.has(key)) return imageCache.get(key);
  const out = {};
  for (const f of COMMON_FILES) {
    const p = path.join(TEMPLATE_DIR, 'common', f);
    if (fs.existsSync(p)) out[f] = fs.readFileSync(p);
  }
  if (!out['icon.png']) throw new Error('pass-template/common/icon.png is missing');
  const themeDir = path.join(TEMPLATE_DIR, fs.existsSync(path.join(TEMPLATE_DIR, theme)) ? theme : 'default');
  for (const scale of SCALES) {
    const candidates = [`strip-${filled}${scale}.png`, `strip${scale}.png`];
    for (const c of candidates) {
      const p = path.join(themeDir, c);
      if (fs.existsSync(p)) { out[`strip${scale}.png`] = fs.readFileSync(p); break; }
    }
  }
  imageCache.set(key, out);
  return out;
}

/** Signed .pkpass bytes for a member. */
async function buildPkpass(member, { settings: s = settings(), PKPassImpl } = {}) {
  const missing = missingConfig(s);
  if (missing.length) {
    const err = new Error(`pass signing not configured: ${missing.join(', ')}`);
    err.code = 'not_configured';
    err.missing = missing;
    throw err;
  }
  const PKPass = PKPassImpl || require('passkit-generator').PKPass;
  const json = buildPassJson(member, s);
  const files = { 'pass.json': Buffer.from(JSON.stringify(json)), ...templateImages(s.theme, filledStamps(member.points, s.redeemCost)) };
  const pass = new PKPass(files, s.certs);
  return pass.getAsBuffer();
}

module.exports = { settings, missingConfig, buildPassJson, buildPkpass, rewardCopy, filledStamps, resolveTheme, splitName, _internals: { pem, templateImages, COMMON_FILES, THEMES } };

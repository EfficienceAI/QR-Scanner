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
const IMAGE_FILES = ['icon.png', 'icon@2x.png', 'icon@3x.png', 'logo.png', 'logo@2x.png', 'logo@3x.png', 'strip.png', 'strip@2x.png', 'strip@3x.png'];

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

function settings(env = process.env) {
  const cost = parseInt(env.LOYALTY_REDEEM_COST, 10);
  return {
    teamId: env.APPLE_TEAM_ID || '',
    passTypeId: env.PASS_TYPE_ID || '',
    baseUrl: (env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
    orgName: env.PASS_ORG_NAME || 'La Bottega Milanese',
    description: env.PASS_DESCRIPTION || 'La Bottega Milanese loyalty card',
    logoText: env.PASS_LOGO_TEXT || 'La Bottega Milanese',
    backgroundColor: env.PASS_BACKGROUND_COLOR || 'rgb(17, 17, 20)',
    foregroundColor: env.PASS_FOREGROUND_COLOR || 'rgb(255, 255, 255)',
    labelColor: env.PASS_LABEL_COLOR || 'rgb(160, 160, 170)',
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

/** The pass.json object for a member. Pure: no I/O. */
function buildPassJson(member, s = settings()) {
  const points = Number(member.points) || 0;
  const reward = rewardCopy(points, s.redeemCost);
  const shortId = String(member.pass_serial || '').replace(/^LBM-/, '');
  return {
    formatVersion: 1,
    passTypeIdentifier: s.passTypeId,
    teamIdentifier: s.teamId,
    serialNumber: member.pass_serial,
    authenticationToken: member.pass_auth_token,
    webServiceURL: `${s.baseUrl}/api/wallet`,
    organizationName: s.orgName,
    description: s.description,
    logoText: s.logoText,
    backgroundColor: s.backgroundColor,
    foregroundColor: s.foregroundColor,
    labelColor: s.labelColor,
    sharingProhibited: true,
    barcodes: [{ message: qrMessage(member), format: 'PKBarcodeFormatQR', messageEncoding: 'iso-8859-1', altText: member.pass_serial }],
    barcode: { message: qrMessage(member), format: 'PKBarcodeFormatQR', messageEncoding: 'iso-8859-1', altText: member.pass_serial },
    storeCard: {
      headerFields: [{ key: 'stamps', label: 'STAMPS', value: points, textAlignment: 'PKTextAlignmentRight' }],
      secondaryFields: [
        { key: 'member', label: 'MEMBER', value: member.full_name || 'Member' },
        { key: 'reward', label: reward.label, value: reward.value, textAlignment: 'PKTextAlignmentRight' },
      ],
      auxiliaryFields: [{ key: 'since', label: 'MEMBER SINCE', value: monthYear(member.created_at) }],
      backFields: [
        { key: 'how', label: 'How it works', value: `Show this pass when you buy a coffee. Every coffee earns a stamp, and ${s.redeemCost} stamps earn a free drink.` },
        { key: 'id', label: 'Member ID', value: shortId },
        { key: 'support', label: 'Questions', value: s.supportText },
      ],
    },
  };
}

let imageCache = null;
function templateImages() {
  if (imageCache) return imageCache;
  const out = {};
  for (const f of IMAGE_FILES) {
    const p = path.join(TEMPLATE_DIR, f);
    if (fs.existsSync(p)) out[f] = fs.readFileSync(p);
  }
  if (!out['icon.png']) throw new Error('pass-template/icon.png is missing');
  imageCache = out;
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
  const files = { 'pass.json': Buffer.from(JSON.stringify(json)), ...templateImages() };
  const pass = new PKPass(files, s.certs);
  return pass.getAsBuffer();
}

module.exports = { settings, missingConfig, buildPassJson, buildPkpass, rewardCopy, _internals: { pem, templateImages, IMAGE_FILES } };

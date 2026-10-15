'use strict';

/**
 * A throwaway Pass Type ID certificate for local runs and tests. Apple will
 * never accept a pass signed with it, but it exercises the exact signing
 * path the real certificate goes through.
 */

const forge = require('node-forge');

function makeSelfSignedPassCert({ teamId = 'MOCKTEAM01', passTypeId = 'pass.com.example.loyalty', bits = 2048 } = {}) {
  const keys = forge.pki.rsa.generateKeyPair({ bits, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Date.now());
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86400_000);
  const attrs = [
    { name: 'commonName', value: `Pass Type ID: ${passTypeId}` },
    { shortName: 'OU', value: teamId },
    { name: 'organizationName', value: 'Local development' },
    { name: 'countryName', value: 'GB' },
    { type: '0.9.2342.19200300.100.1.1', value: passTypeId }, // UID, as Apple sets it
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey), teamId, passTypeId };
}

module.exports = { makeSelfSignedPassCert };

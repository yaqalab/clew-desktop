'use strict';
/**
 * The app's own TLS certificate for the bundled hosts: generated on first run, kept in
 * `userData/tls`, renewed when it nears expiry or the host list changes. It is trusted only
 * inside the app's session, and only for those hostnames (see network.js): nothing is added
 * to the system's trust store.
 */
const fs = require('node:fs');
const path = require('node:path');

const VALID_DAYS = 825;
const RENEW_BEFORE_DAYS = 30;

async function generate(hosts) {
  const selfsigned = require('selfsigned');
  const notBeforeDate = new Date(Date.now() - 24 * 3600 * 1000);
  const notAfterDate = new Date(notBeforeDate.getTime() + VALID_DAYS * 24 * 3600 * 1000);
  const pems = await selfsigned.generate([{ name: 'commonName', value: hosts[0] }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: hosts.map((value) => ({ type: 2, value })) },
    ],
  });
  return { key: pems.private, cert: pems.cert, notAfter: notAfterDate.toISOString() };
}

async function loadOrCreate(dir, hosts) {
  const wanted = [...hosts].sort();
  const files = {
    key: path.join(dir, 'key.pem'),
    cert: path.join(dir, 'cert.pem'),
    meta: path.join(dir, 'meta.json'),
  };
  try {
    const meta = JSON.parse(fs.readFileSync(files.meta, 'utf8'));
    const fresh = new Date(meta.notAfter).getTime() - Date.now() > RENEW_BEFORE_DAYS * 24 * 3600 * 1000;
    if (fresh && JSON.stringify(meta.hosts) === JSON.stringify(wanted)) {
      return { key: fs.readFileSync(files.key, 'utf8'), cert: fs.readFileSync(files.cert, 'utf8') };
    }
  } catch {
    /* none yet, or unreadable: make a new one */
  }
  const made = await generate(wanted);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(files.key, made.key, { mode: 0o600 });
  fs.writeFileSync(files.cert, made.cert);
  fs.writeFileSync(files.meta, JSON.stringify({ hosts: wanted, notAfter: made.notAfter }, null, 2));
  return { key: made.key, cert: made.cert };
}

/** PEM without line-break differences, for comparing certificates. */
function normalizePem(pem) {
  return String(pem).replace(/\r/g, '').replace(/\s+$/g, '').trim();
}

module.exports = { loadOrCreate, normalizePem };

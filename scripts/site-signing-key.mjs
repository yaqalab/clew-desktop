#!/usr/bin/env node
// Keys for signing the sites' builds (src/site-updates.js: version.json.sig).
//
//   node scripts/site-signing-key.mjs new <folder>
//       makes an Ed25519 key pair: <folder>/site-signing-<date>-<id>.key holds the private key
//       (one line, base64 PKCS#8: the value of DESKTOP_SIGNING_KEY in the sites' builds); the
//       public key is printed, for `siteUpdates.publicKeys` in desktop.config.json. Keep the
//       private key out of any repository.
//
//   node scripts/site-signing-key.mjs check [https://clew.alefa.net ...]
//       reads each site's /desktop/version.json and .sig and says whether a key of
//       desktop.config.json signed it (default: the bundled sites).
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'new') {
  const dir = args[0];
  if (!dir) throw new Error('usage: site-signing-key.mjs new <folder>');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const priv = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  // The same key read back from its line, as the sites' build will.
  const again = createPublicKey(createPrivateKey({ key: Buffer.from(priv, 'base64'), format: 'der', type: 'pkcs8' }));
  if (again.export({ type: 'spki', format: 'der' }).toString('base64') !== pub) throw new Error('key check failed');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `site-signing-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString('hex')}.key`);
  writeFileSync(file, `${priv}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`private key: ${file}`);
  console.log(`public key:  ${pub}`);
} else if (cmd === 'check') {
  const { verifySignature } = require('../src/site-updates.js');
  const config = JSON.parse(readFileSync(new URL('../desktop.config.json', import.meta.url), 'utf8'));
  const keys = config.siteUpdates.publicKeys || [];
  const sites = args.length ? args : ['https://clew.alefa.net', 'https://yaqatw.alefa.net'];
  for (const site of sites) {
    const get = async (f) => {
      const r = await fetch(`${site}/desktop/${f}?t=${Date.now()}`, { cache: 'no-store' });
      return r.ok && !/text\/html/.test(r.headers.get('content-type') || '') ? Buffer.from(await r.arrayBuffer()) : null;
    };
    const v = await get('version.json');
    const sig = await get('version.json.sig');
    let verdict;
    if (!v) verdict = 'no version.json';
    else {
      try {
        verdict = verifySignature(v, sig?.toString('utf8') ?? null, keys) ? 'signed by a known key' : 'not signed';
      } catch (err) {
        verdict = `REFUSED: ${err.message}`;
      }
    }
    const commit = v ? JSON.parse(v.toString('utf8')).commit?.slice(0, 12) : '';
    console.log(`${site}: ${verdict}${commit ? ` (${commit})` : ''}`);
  }
} else {
  console.log('usage: site-signing-key.mjs new <folder> | check [site ...]');
  process.exit(1);
}

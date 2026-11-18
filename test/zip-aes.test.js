'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { writeZip, verifyZip, WrongPassphrase, passphraseProblem } = require('../src/zip-aes');

const PASS = 'Correct horse, battery staple! 42';

test('only printable ASCII passphrases: archivers read the rest differently', async () => {
  assert.equal(passphraseProblem(PASS), null);
  assert.match(passphraseProblem('café au lait'), /without accents/);
  assert.match(passphraseProblem('電池電池電池'), /without accents/);
  assert.match(passphraseProblem('tab\there'), /without accents/);
  assert.equal(passphraseProblem(''), 'no passphrase');
  const f = fixture();
  await assert.rejects(writeZip(f.zip, f.entries, 'café'), /without accents/);
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-zip-'));
  const big = crypto.randomBytes(3 * 1024 * 1024 + 7);
  fs.writeFileSync(path.join(dir, 'big.bin'), big);
  const text = Buffer.from('Entretien n°1 — 日本語のテキスト\n'.repeat(5000), 'utf8');
  fs.writeFileSync(path.join(dir, 'text.txt'), text);
  fs.writeFileSync(path.join(dir, 'empty'), '');
  const entries = [
    { name: 'profile/', mtime: new Date(2026, 10, 18, 9, 30) },
    { name: 'profile/big.bin', path: path.join(dir, 'big.bin') },
    { name: 'profile/Vault é/text.txt', path: path.join(dir, 'text.txt') },
    { name: 'profile/empty', path: path.join(dir, 'empty') },
    { name: 'README.txt', data: Buffer.from('restore notes') },
  ];
  return { dir, entries, big, text, zip: path.join(dir, 'backup.zip') };
}

test('a zip written is read back whole with the passphrase', async () => {
  const f = fixture();
  const seen = new Map();
  const progress = [];
  const w = await writeZip(f.zip, f.entries, PASS, { onProgress: (p) => progress.push(p.done) });
  assert.equal(w.entries, 5);
  assert.equal(w.bytes, f.big.length + f.text.length + 13);
  assert.deepEqual(progress, [1, 2, 3, 4, 5]);
  const r = await verifyZip(f.zip, PASS, { onEntry: (name, bytes) => seen.set(name, bytes) });
  assert.equal(r.bytes, w.bytes);
  assert.ok(seen.get('profile/big.bin').equals(f.big));
  assert.ok(seen.get('profile/Vault é/text.txt').equals(f.text));
  assert.equal(seen.get('profile/empty').length, 0);
  assert.equal(seen.get('README.txt').toString(), 'restore notes');
  // Compressed: the repeated text takes far less room than itself.
  assert.ok(fs.statSync(f.zip).size < f.big.length + f.text.length / 4);
});

test('a wrong passphrase is refused', async () => {
  const f = fixture();
  await writeZip(f.zip, f.entries, PASS);
  await assert.rejects(verifyZip(f.zip, 'not it'), WrongPassphrase);
});

test('a damaged byte is caught', async () => {
  const f = fixture();
  await writeZip(f.zip, f.entries, PASS);
  const buf = fs.readFileSync(f.zip);
  buf[1000] ^= 0x01; // inside big.bin's encrypted data
  fs.writeFileSync(f.zip, buf);
  await assert.rejects(verifyZip(f.zip, PASS), /damaged|invalid|incorrect/i);
});

const SEVEN = ['C:\\Program Files\\7-Zip\\7z.exe', '/usr/bin/7z', '/usr/local/bin/7z', '/opt/homebrew/bin/7z'].find((p) =>
  fs.existsSync(p),
);

test('7-Zip opens it: tests every entry and extracts the same bytes', { skip: !SEVEN && 'no 7-Zip here' }, async () => {
  const f = fixture();
  await writeZip(f.zip, f.entries, PASS);
  const tested = execFileSync(SEVEN, ['t', `-p${PASS}`, f.zip], { encoding: 'utf8' });
  assert.match(tested, /Everything is Ok/);
  const listed = execFileSync(SEVEN, ['l', '-slt', f.zip], { encoding: 'utf8' });
  assert.match(listed, /Method = AES-256 Deflate/);
  const out = path.join(f.dir, 'out');
  execFileSync(SEVEN, ['x', `-p${PASS}`, `-o${out}`, f.zip], { encoding: 'utf8' });
  assert.ok(fs.readFileSync(path.join(out, 'profile', 'big.bin')).equals(f.big));
  assert.ok(fs.readFileSync(path.join(out, 'profile', 'Vault é', 'text.txt')).equals(f.text));
  assert.throws(() => execFileSync(SEVEN, ['t', '-pwrong', f.zip], { stdio: 'pipe' }));
});

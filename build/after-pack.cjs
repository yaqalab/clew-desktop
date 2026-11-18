'use strict';
// electron-builder's afterPack hook (package.json build.afterPack): the packed app holds only what
// `build.files` names. A platform's `files` that only excludes gets an implicit "everything"
// added, which once packed private/, env/ and the rest of the working folder into the app; this
// stops such a build before an installer is made.
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const ALLOWED = new Set(['src', 'node_modules', 'package.json', 'sites.config.json', 'desktop.config.json']);

exports.default = async function afterPack(context) {
  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(context.appOutDir, 'resources');
  const archive = path.join(resources, 'app.asar');
  if (!fs.existsSync(archive)) throw new Error(`after-pack: no app.asar in ${resources}`);
  const top = new Set(asar.listPackage(archive).map((p) => p.split(/[\\/]/).filter(Boolean)[0]));
  const extra = [...top].filter((name) => !ALLOWED.has(name));
  if (extra.length) {
    throw new Error(`after-pack: the app would carry files it must not: ${extra.join(', ')} (check build.files)`);
  }
  console.log(`  • after-pack: app.asar holds ${[...top].sort().join(', ')}`);
};

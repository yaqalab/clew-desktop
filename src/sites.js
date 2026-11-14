'use strict';
/**
 * The one table of bundled sites: hostname → folder (or dev server). Everything comes from
 * `sites.config.json`; a third app is one more entry there.
 */
const path = require('node:path');
const fs = require('node:fs');
const config = require('../sites.config.json');

const DEV = process.env.CLEW_DESKTOP_DEV === '1';

function sitesRoot() {
  if (process.env.CLEW_DESKTOP_SITES) return path.resolve(process.env.CLEW_DESKTOP_SITES);
  // Packaged: electron-builder copies `sites/` next to app.asar (extraResources).
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'sites');
  if (packaged && !process.defaultApp && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', 'sites');
}

const root = sitesRoot();

const list = config.sites.map((s) => ({
  name: s.name,
  host: s.host,
  origin: `https://${s.host}`,
  root: path.join(root, s.name),
  devUrl: DEV ? `http://localhost:${s.devPort}` : null,
}));

const byHostMap = new Map(list.map((s) => [s.host.toLowerCase(), s]));
const origins = new Set(list.map((s) => s.origin));
const main = list.find((s) => s.name === config.main) ?? list[0];

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function buildInfo(site) {
  try {
    return JSON.parse(fs.readFileSync(path.join(site.root, '.build-info.json'), 'utf8'));
  } catch {
    return null;
  }
}

module.exports = {
  DEV,
  list,
  main,
  mainUrl: `${main.origin}/`,
  origins: [...origins],
  byHost: (host) => byHostMap.get(String(host).toLowerCase()) ?? null,
  isBundledOrigin: (origin) => origins.has(origin),
  isBundledUrl: (url) => origins.has(originOf(url)),
  originOf,
  buildInfo,
};

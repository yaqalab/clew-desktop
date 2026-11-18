'use strict';
/**
 * The app's own preferences (`<profile>/desktop-settings.json`), apart from the tools' `tools.json`
 * (the tools may be off in a run). A missing or broken file is the defaults.
 *
 * Plain Node, so it runs under `node --test`.
 */
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  /** Developer tools in the View menu: they show an open vault's data to anyone at the keyboard. */
  devTools: false,
});

function createAppSettings(file) {
  function read() {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    } catch {
      return {};
    }
  }

  function get() {
    const saved = read();
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof saved[key] === typeof DEFAULTS[key]) out[key] = saved[key];
    }
    return out;
  }

  /** Changes the known keys given, keeps the rest of the file; returns the settings. */
  function set(patch) {
    const saved = read();
    for (const [key, value] of Object.entries(patch || {})) {
      if (Object.hasOwn(DEFAULTS, key) && typeof value === typeof DEFAULTS[key]) saved[key] = value;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(saved, null, 2)}\n`);
    fs.renameSync(temp, file);
    return get();
  }

  return { get, set };
}

module.exports = { createAppSettings, DEFAULTS };

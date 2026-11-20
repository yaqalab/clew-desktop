'use strict';
/** What the tabs read from Clew's addresses (`#/p/<project>/…`), without Electron. */

/** The project a Clew URL shows (`#/p/<id>/…`), or null for the hub's own pages. */
function projectOf(url) {
  let hash;
  try {
    hash = new URL(url).hash;
  } catch {
    return null;
  }
  const match = /^#\/p\/([^/?#]+)/.exec(hash);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** A hub route Clew may ask for: `#/…`, of a sane length. */
function isRoute(hash) {
  return typeof hash === 'string' && hash.startsWith('#/') && hash.length < 4096;
}

/**
 * What a tab is called on the strip: the page's title before " · <app>" ("Transcripts · Clew"),
 * else its project's id made readable, else the app's name.
 */
function labelFor(title, url, appName) {
  const own = String(title || '')
    .split(' · ')[0]
    .trim();
  if (own && own !== appName) return own;
  const project = projectOf(url);
  if (project) return project.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return own || appName;
}

module.exports = { isRoute, labelFor, projectOf };

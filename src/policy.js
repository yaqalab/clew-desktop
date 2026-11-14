'use strict';
/**
 * Where a URL may open: in the app, in an in-app popup, or in the system browser.
 *
 * - The bundled hosts open in the app (windows and popups alike).
 * - Hosts on `inAppPopupHosts` (sign-in pages that report back to their opener) open as
 *   in-app popups, as does `about:blank` (a popup a page fills in itself).
 * - Everything else http(s)/mailto/tel goes to the system browser; any other scheme is refused.
 *
 * Top-level navigations follow the same rule in the main window. An in-app popup may navigate
 * anywhere over https: a sign-in flow crosses hosts (a user's own Nextcloud server, say),
 * and still has to land back on the bundled page that posts the result to its opener.
 */
const { shell } = require('electron');
const desktopConfig = require('../desktop.config.json');

const popupHosts = new Set((desktopConfig.inAppPopupHosts || []).map((h) => h.toLowerCase()));

function classify(rawUrl, sites) {
  if (rawUrl === 'about:blank' || rawUrl === '') return 'blank';
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'deny';
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    if (sites.byHost(url.hostname)) return 'app';
    if (popupHosts.has(url.hostname.toLowerCase())) return 'popup';
    return 'external';
  }
  if (url.protocol === 'mailto:' || url.protocol === 'tel:') return 'external';
  return 'deny';
}

function openExternal(url) {
  shell.openExternal(url).catch((err) => console.warn('[policy] openExternal failed:', err.message));
}

/**
 * Applies the policy to one webContents. `childOptions()` gives the options for windows it
 * may open; `isPopup` marks a window that was itself opened as an in-app popup.
 */
function apply(contents, sites, childOptions, isPopup = false) {
  contents.setWindowOpenHandler(({ url }) => {
    const kind = classify(url, sites);
    if (kind === 'app' || kind === 'popup' || kind === 'blank') {
      return { action: 'allow', overrideBrowserWindowOptions: childOptions() };
    }
    if (kind === 'external') openExternal(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    const kind = classify(url, sites);
    if (kind === 'app' || kind === 'popup' || kind === 'blank') return;
    if (isPopup && kind === 'external' && /^https:/i.test(url)) return;
    event.preventDefault();
    if (kind === 'external') openExternal(url);
  });
}

module.exports = { apply, classify };

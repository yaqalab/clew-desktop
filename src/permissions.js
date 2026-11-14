'use strict';
/**
 * Permissions: granted only to the bundled origins (a yaqatw frame inside Clew included),
 * and only those listed in `desktop.config.json`. Everything else is denied.
 */
const { systemPreferences } = require('electron');
const desktopConfig = require('../desktop.config.json');

const granted = new Set(desktopConfig.grantedPermissions || []);

async function macMediaAccess(mediaTypes = []) {
  if (process.platform !== 'darwin') return true;
  for (const type of mediaTypes) {
    const kind = type === 'video' ? 'camera' : type === 'audio' ? 'microphone' : null;
    if (!kind) continue;
    if (systemPreferences.getMediaAccessStatus(kind) === 'granted') continue;
    if (!(await systemPreferences.askForMediaAccess(kind))) return false;
  }
  return true;
}

function install(ses, sites) {
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const origin = sites.originOf(details.securityOrigin || details.requestingUrl);
    const ok = sites.isBundledOrigin(origin) && granted.has(permission);
    if (!ok) {
      if (!sites.isBundledOrigin(origin)) console.warn(`[permissions] denied ${permission} to ${origin}`);
      callback(false);
      return;
    }
    if (permission === 'media') {
      macMediaAccess(details.mediaTypes).then(callback, () => callback(false));
      return;
    }
    callback(true);
  });

  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return sites.isBundledOrigin(sites.originOf(requestingOrigin)) && granted.has(permission);
  });
}

module.exports = { install };

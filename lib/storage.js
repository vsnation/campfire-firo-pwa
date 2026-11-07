// Whether the browser keeps this app's storage (the wallets in IndexedDB, the
// verified copy in Cache Storage) or may clear it under pressure. Asked for once
// a wallet exists; the answer is shown in Settings -> About. No network.
//
// Chrome grants it silently, and only to a site it trusts more: installed, bookmarked, allowed to
// notify, or often used. So it is asked again when one of those changes while the app runs: the app
// installed (here), notifications allowed (screens/notifications.js).
//
// Safari deletes a site's script-written storage after 7 days of use without a visit to it, in a tab
// (a Home Screen or Dock app has its own count and storage); other browsers clear least-used sites
// when the device runs low on space unless the site's storage is kept (persist()). evictionRisk()
// says which applies here; Home says so with the way to keep the wallet (screens/home_screen_guide.js).
import { t } from './i18n.js';
import { isIos, isStandalone, macSafariVersion } from './install_prompt.js';

let watching = false;

export async function refreshPersistence(app, { request = false } = {}) {
  const s = navigator.storage;
  if (!s || typeof s.persisted !== 'function') {
    app.persisted = null;
    return null;
  }
  if (!watching && typeof window !== 'undefined') {
    watching = true;
    window.addEventListener('appinstalled', () => {
      if (app.record) refreshPersistence(app, { request: true });
    });
  }
  try {
    let kept = await s.persisted();
    if (!kept && request && typeof s.persist === 'function') kept = await s.persist();
    app.persisted = Boolean(kept);
  } catch {
    app.persisted = null;
  }
  return app.persisted;
}

export function persistenceText(persisted) {
  if (persisted === true) return t('kept');
  if (persisted === false) return t('may be cleared by the system');
  return t('unknown in this browser');
}

/** Safari (any iPhone or iPad browser, Safari on a Mac) in a tab, not the Home Screen / Dock app. */
export function isSafariTab(env = globalThis) {
  return (isIos(env) || macSafariVersion(env) > 0) && !isStandalone(env);
}

/**
 * Whether this browser may delete what this app keeps: 'safariTab' (not kept, in a Safari tab:
 * gone after 7 days without a visit), 'mayClear' (not kept elsewhere: cleared when space runs low),
 * or null (kept, or the browser cannot say).
 */
export function evictionRisk(app, env = globalThis) {
  if (!app || app.persisted !== false) return null;
  return isSafariTab(env) ? 'safariTab' : 'mayClear';
}

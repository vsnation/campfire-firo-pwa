// Installing Firo PWA: which way this browser offers, and the browser's own Install prompt.
//
// Three ways, by browser (measured on pwa.buyfiro.app, 2026-11-07):
// - 'prompt': Chrome, Edge and other Chromium browsers (computer and Android) fire
//   beforeinstallprompt about a second after load (never in incognito). Its prompt() shows the
//   browser's own Install dialog. The installed app shares this site's storage, so a wallet made in
//   the tab is there too, and Chrome keeps an installed app's storage (persist(), lib/storage.js).
// - 'ios': any iPhone or iPad browser. No prompt exists; Share -> Add to Home Screen. The Home Screen
//   app has its own storage: a wallet made in the tab does not move.
// - 'mac': Safari 17 or later on a Mac. File -> Add to Dock (or Share -> Add to Dock); the Dock app
//   has its own storage too.
// Anything else (Firefox, older Safari, already installed): null, and nothing is offered.
//
// The listener is attached when this module is first imported (app.js imports it at boot), before
// the event can fire: it is sent once per page load.

let deferred = null;
let installed = false;
const subs = new Set();
const emit = () => subs.forEach((fn) => {
  try {
    fn();
  } catch (e) {
    console.warn('[campfire] install', e);
  }
});

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Our own card offers it (Android would otherwise show its own bar once and never again).
    e.preventDefault();
    deferred = e;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    emit();
  });
}

/** Running as the installed app (Home Screen, Dock, or a Chromium app window), not in a tab. */
export function isStandalone(env = globalThis) {
  const nav = env.navigator || {};
  if (nav.standalone === true) return true;
  try {
    const mm = env.matchMedia;
    if (!mm) return false;
    // i18n-ignore: CSS media queries
    return ['(display-mode: standalone)', '(display-mode: fullscreen)', '(display-mode: minimal-ui)', '(display-mode: window-controls-overlay)'].some((q) => mm.call(env, q).matches);
  } catch {
    return false;
  }
}

/** An iPhone or iPad (an iPad asks for the desktop site and says Macintosh, with a touch screen). */
export function isIos(env = globalThis) {
  const nav = env.navigator || {};
  const ua = String(nav.userAgent || '');
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1);
}

/** Safari on a Mac, and its major version (0 when not Safari on a Mac). */
export function macSafariVersion(env = globalThis) {
  const nav = env.navigator || {};
  const ua = String(nav.userAgent || '');
  if (!/Macintosh/.test(ua) || Number(nav.maxTouchPoints) > 1) return 0;
  // Other Mac browsers built on Safari's engine (DuckDuckGo) have no Add to Dock.
  if (/Chrome|Chromium|CriOS|FxiOS|Firefox|Edg|OPR|Ddg\//.test(ua)) return 0;
  const m = /Version\/(\d+)[\d.]*.*Safari\//.exec(ua);
  return m ? Number(m[1]) : 0;
}

/** Safari 17 brought Add to Dock (macOS Sonoma and later). */
export const MAC_DOCK_SAFARI = 17;

/** 'prompt' | 'ios' | 'mac' | null: how Firo PWA can be installed from here (null: it is, or it cannot). */
export function installWay(env = globalThis) {
  if (installed || isStandalone(env)) return null;
  if (isIos(env)) return 'ios';
  if (macSafariVersion(env) >= MAC_DOCK_SAFARI) return 'mac';
  return deferred ? 'prompt' : null;
}

/** Ways whose installed app has its own storage: a wallet must be started there, not moved. */
export const SEPARATE_STORAGE = Object.freeze(new Set(['ios', 'mac']));

/** The browser's Install dialog. Resolves 'accepted' | 'dismissed' | 'unavailable'. Usable once per page load. */
export async function promptInstall() {
  const e = deferred;
  if (!e || typeof e.prompt !== 'function') return 'unavailable';
  deferred = null;
  emit();
  try {
    await e.prompt();
    const choice = await e.userChoice;
    return choice && choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch {
    return 'unavailable';
  }
}

/** Called when the way changes (the prompt arrived, was used, or the app was installed). Returns an unsubscribe. */
export function onInstallChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

/** Tests: a stand-in prompt event, or none. */
export function _setDeferredForTest(e, { wasInstalled = false } = {}) {
  deferred = e;
  installed = wasInstalled;
  emit();
}

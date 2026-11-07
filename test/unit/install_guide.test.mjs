// 0.1.20 (owner, 2026-11-05: "Why I don't see Install recommendation and requirement"): which way
// each browser installs Firo PWA, when Safari can delete a tab's wallet, and the passphrase box drawn
// as dots where a mouse is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installWay, isStandalone, isIos, macSafariVersion, promptInstall, onInstallChange, _setDeferredForTest, SEPARATE_STORAGE } from '../../src/lib/install_prompt.js';
import { isSafariTab, evictionRisk } from '../../src/lib/storage.js';
import { textDots } from '../../src/lib/ui.js';
import { lastStep } from '../../src/screens/home_screen_guide.js';

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.0 Mobile/15E148 Safari/604.1',
  // An iPad asks for the desktop site: it says Macintosh, with a touch screen.
  ipad: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  mac18: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  mac16: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:140.0) Gecko/20100101 Firefox/140.0',
};

/** A browser as the module sees it: user agent, touch points, the media queries that match. */
function env(ua, { touch = 0, modes = [], standalone, pointer = 'fine', css = true } = {}) {
  return {
    navigator: { userAgent: ua, maxTouchPoints: touch, ...(standalone !== undefined ? { standalone } : {}) },
    matchMedia: (q) => ({ matches: modes.some((m) => q === `(display-mode: ${m})`) || q === `(pointer: ${pointer})` }),
    CSS: css ? { supports: (p, v) => p === '-webkit-text-security' && v === 'disc' } : undefined,
  };
}

const prompt = (outcome = 'accepted') => ({ prompt: async () => {}, userChoice: Promise.resolve({ outcome }) });

test('iPhone and iPad, any browser, in a tab: the Home Screen steps; installed: nothing', () => {
  _setDeferredForTest(null);
  assert.equal(installWay(env(UA.iphone, { touch: 5 })), 'ios');
  assert.equal(installWay(env(UA.iphoneChrome, { touch: 5 })), 'ios');
  assert.equal(installWay(env(UA.ipad, { touch: 5 })), 'ios', 'an iPad that says Macintosh');
  assert.equal(isIos(env(UA.ipad, { touch: 5 })), true);
  assert.equal(installWay(env(UA.iphone, { touch: 5, standalone: true })), null, 'opened from the Home Screen');
  assert.equal(installWay(env(UA.iphone, { touch: 5, modes: ['standalone'] })), null);
});

test('Safari on a Mac: Add to Dock from Safari 17; older Safari and other Mac browsers without the prompt: nothing', () => {
  _setDeferredForTest(null);
  assert.equal(macSafariVersion(env(UA.mac18)), 18);
  assert.equal(installWay(env(UA.mac18)), 'mac');
  assert.equal(installWay(env(UA.mac16)), null, 'Add to Dock came with Safari 17');
  assert.equal(macSafariVersion(env(UA.macChrome)), 0, 'Chrome on a Mac is not Safari');
  assert.equal(installWay(env(UA.macChrome)), null);
  assert.equal(installWay(env(UA.firefox)), null);
  assert.equal(installWay(env(`${UA.mac18} Ddg/18.5`)), null, 'DuckDuckGo on a Mac: Safari\'s engine, no Add to Dock');
  assert.equal(installWay(env(UA.mac18, { modes: ['standalone'] })), null, 'the Dock app itself');
});

test('Chrome, Edge, Android: Install once the browser offers it, and not once it is installed or in its own window', async () => {
  _setDeferredForTest(prompt());
  assert.equal(installWay(env(UA.macChrome)), 'prompt');
  assert.equal(installWay(env(UA.winEdge)), 'prompt');
  assert.equal(installWay(env(UA.android, { touch: 5, pointer: 'coarse' })), 'prompt');
  assert.equal(installWay(env(UA.winEdge, { modes: ['window-controls-overlay'] })), null, 'an app window');
  assert.equal(installWay(env(UA.winEdge, { modes: ['minimal-ui'] })), null);
  assert.equal(isStandalone(env(UA.winEdge, { modes: ['fullscreen'] })), true);
  // The way follows the browser's own event: Firefox never sends one, so it is never offered there.
  _setDeferredForTest(null);
  assert.equal(installWay(env(UA.firefox)), null);
  _setDeferredForTest(null, { wasInstalled: true });
  assert.equal(installWay(env(UA.iphone, { touch: 5 })), null, 'installed during this page load: nothing more is offered');
  _setDeferredForTest(null);
});

test('the browser\'s prompt is used once: accepted or dismissed, then gone; changes are told to who listens', async () => {
  const seen = [];
  const off = onInstallChange(() => seen.push(installWay(env(UA.macChrome))));
  _setDeferredForTest(prompt('accepted'));
  assert.equal(await promptInstall(), 'accepted');
  assert.equal(await promptInstall(), 'unavailable', 'a prompt event works once');
  _setDeferredForTest(prompt('dismissed'));
  assert.equal(await promptInstall(), 'dismissed');
  _setDeferredForTest({ prompt: async () => { throw new Error('not allowed'); }, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  assert.equal(await promptInstall(), 'unavailable');
  off();
  assert.deepEqual(seen, ['prompt', null, 'prompt', null, 'prompt', null]);
  _setDeferredForTest(null);
  assert.equal(seen.length, 6, 'unsubscribed');
});

test('the installed app has its own storage only on iPhone, iPad and Mac Safari', () => {
  assert.deepEqual([...SEPARATE_STORAGE].sort(), ['ios', 'mac']);
});

test('Safari can delete a tab\'s wallet: only Safari (iPhone, iPad, Mac), only in a tab, only when storage is not kept', () => {
  assert.equal(isSafariTab(env(UA.iphone, { touch: 5 })), true);
  assert.equal(isSafariTab(env(UA.mac16)), true, 'the 7-day rule is older than Add to Dock');
  assert.equal(isSafariTab(env(UA.iphone, { touch: 5, standalone: true })), false);
  assert.equal(isSafariTab(env(UA.macChrome)), false);
  const app = (persisted) => ({ persisted });
  assert.equal(evictionRisk(app(false), env(UA.iphone, { touch: 5 })), 'safariTab');
  assert.equal(evictionRisk(app(false), env(UA.macChrome)), 'mayClear');
  assert.equal(evictionRisk(app(true), env(UA.iphone, { touch: 5 })), null, 'kept');
  assert.equal(evictionRisk(app(null), env(UA.iphone, { touch: 5 })), null, 'the browser cannot say');
});

test('the passphrase box: dots in a text box with a mouse where the browser draws them; a password box with a touch screen or none', () => {
  assert.equal(textDots(env(UA.macChrome)), true);
  assert.equal(textDots(env(UA.android, { pointer: 'coarse' })), false, 'keyboards learn what is typed in text boxes');
  assert.equal(textDots(env(UA.firefox, { css: false })), false, 'no dots: a password box, as before');
  assert.equal(textDots({}), false);
});

test('the last step names what the person brings to the installed app', () => {
  assert.equal(lastStep(null), 'start');
  assert.equal(lastStep({ watchOnly: true }), 'view');
  assert.equal(lastStep({ wordsConfirmed: false }), 'file', 'restored from a backup file, words never written down');
  assert.equal(lastStep({ restored: true, words: 24 }), 'words');
});

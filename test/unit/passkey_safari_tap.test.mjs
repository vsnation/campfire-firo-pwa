// Saving a passkey on a Mac (owner, 2026-11-17: "MacOS Desktop Save Passkey doesn't work"). Safari
// lets a page make a passkey only right after the person's tap. Two things kept it from working:
// createPasskey awaited a check before navigator.credentials.create, and from Settings the password
// was checked first (a second or so), then the passkey asked for. Now create() is called at once,
// and where the tap's window has closed the screen asks for one more tap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { one } from './helpers/fake_dom.mjs';
import { redirect, standIn } from './helpers/redirect.mjs';

const SETUP = ['/src/screens/passkey_setup.js'];
redirect([
  { parents: SETUP, spec: '../lib/session.js', to: standIn('session_passkey') },
  { parents: SETUP, spec: '../lib/auth_ui.js', to: standIn('auth_ui') },
]);

const created = [];
const signals = [];
let prfOnCreate = true;
globalThis.window = globalThis.window || {};
globalThis.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.PublicKeyCredential = {
  getClientCapabilities: async () => ({ 'extension:prf': true }),
  isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
  signalUnknownCredential: async (o) => signals.push(o),
};
globalThis.window.PublicKeyCredential = globalThis.PublicKeyCredential;
globalThis.location ??= { hostname: 'pwa.buyfiro.app' };
const activation = { isActive: true };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    userActivation: activation,
    credentials: {
      create: async (o) => {
        created.push(o);
        return { rawId: new Uint8Array([1, 2, 3]).buffer, getClientExtensionResults: () => (prfOnCreate ? { prf: { enabled: true, results: { first: new Uint8Array(32).buffer } } } : { prf: { enabled: false } }) };
      },
      get: async () => ({ getClientExtensionResults: () => ({}) }),
    },
  },
});

const { createPasskey } = await import('../../src/lib/passkey.js');
const passkeySetup = (await import('../../src/screens/passkey_setup.js')).default;
const { added } = await import('./helpers/stand_ins/session_passkey.mjs');
const { sheets, answer } = await import('./helpers/stand_ins/auth_ui.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('createPasskey asks the browser at once, within the tap: nothing awaited before create()', async () => {
  created.length = 0;
  const p = createPasskey('wallet-1', 'Main');
  assert.equal(created.length, 1, 'create() called in the same turn as the tap');
  const r = await p;
  assert.equal(r.credId, 'AQID');
});

test('a passkey made without PRF is not kept: the password manager is asked to drop it', async () => {
  signals.length = 0;
  prfOnCreate = false;
  await assert.rejects(createPasskey('wallet-1', 'Main'), (e) => e.code === 'no_prf');
  prfOnCreate = true;
  assert.deepEqual(signals, [{ rpId: 'pwa.buyfiro.app', credentialId: 'AQID' }]);
});

const app = () => {
  const a = { record: { id: 'w1', name: 'Main' }, currentName: 'passkeySetup', go() {}, openWallet() {} };
  return a;
};

test('from Settings, once the password took longer than Safari allows: one more tap, then the passkey', async () => {
  added.length = 0;
  sheets.length = 0;
  activation.isActive = false;
  const s = passkeySetup(app(), {});
  document.body.append(s.el);
  one('passkey-on', s.el).click();
  await sleep(5);
  assert.equal(sheets.length, 1, 'the password asked first');
  answer(0, true);
  await sleep(5);
  assert.equal(added.length, 0, 'no passkey asked for outside the tap');
  assert.match(one('passkey-tap-again', s.el).textContent, /Password checked\. Tap Turn on Face ID again/);
  activation.isActive = true; // the person taps again
  one('passkey-on', s.el).click();
  await sleep(5);
  assert.equal(sheets.length, 1, 'the password is not asked twice');
  assert.deepEqual(added, ['w1']);
  s.el.remove();
});

test('from Settings, still within the tap (Chrome): the passkey is asked for right after the password', async () => {
  added.length = 0;
  sheets.length = 0;
  activation.isActive = true;
  const s = passkeySetup(app(), {});
  one('passkey-on', s.el).click();
  await sleep(5);
  answer(0, true);
  await sleep(5);
  assert.deepEqual(added, ['w1']);
});

test('right after the password was set (first run): no password sheet, the passkey at once', async () => {
  added.length = 0;
  sheets.length = 0;
  activation.isActive = false;
  const s = passkeySetup(app(), { first: true });
  one('passkey-on', s.el).click();
  await sleep(5);
  assert.equal(sheets.length, 0);
  assert.deepEqual(added, ['w1']);
});

test('a failed or cancelled passkey asks for the password again (release audit of 0.1.21)', async () => {
  const { ctl } = await import('./helpers/stand_ins/session_passkey.mjs');
  added.length = 0;
  sheets.length = 0;
  activation.isActive = true;
  ctl.failNext = true;
  const s = passkeySetup(app(), {});
  one('passkey-on', s.el).click();
  await sleep(5);
  answer(0, true);
  await sleep(5);
  assert.equal(added.length, 0, 'the first one was cancelled');
  one('passkey-on', s.el).click();
  await sleep(5);
  assert.equal(sheets.length, 2, 'the password asked again');
  answer(1, true);
  await sleep(5);
  assert.deepEqual(added, ['w1']);
});

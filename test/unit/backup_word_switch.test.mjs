// "Use 12 words instead" tapped while the 24 words were still being made: the late list of the screen
// left behind once became the words kept, while the new screen showed others, and the confirm step
// asked for words never shown. Now only the screen in front keeps and shows its words.
import test from 'node:test';
import assert from 'node:assert/strict';
import './helpers/fake_dom.mjs';
import { redirect, standIn } from './helpers/redirect.mjs';

const BACKUP = ['/src/screens/backup.js'];
redirect([{ parents: BACKUP, spec: '../lib/chain.js', to: standIn('chain_keys') }]);
globalThis.window = globalThis.window || {};
globalThis.window.addEventListener ??= () => {};
globalThis.window.removeEventListener ??= () => {};
globalThis.window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.matchMedia ??= globalThis.window.matchMedia;
globalThis.CSS ??= { supports: () => false };
document.addEventListener ??= () => {};
document.removeEventListener ??= () => {};
globalThis.addEventListener ??= () => {};
globalThis.removeEventListener ??= () => {};
document.visibilityState ??= 'visible';

const backup = (await import('../../src/screens/backup.js')).default;
const { delays } = await import('./helpers/stand_ins/chain_keys.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a switch to 12 words before the 24 are made: the 12 shown are the 12 kept', async () => {
  const app = { setup: null, record: null, go(name) { this.went = name; } };
  delays.push(30, 0); // the 24 words come late, after the 12
  backup(app);
  const setup = app.setup;
  setup.words = null;
  setup.count = 12; // what "Use 12 words instead" does, then the screen for 12 opens
  backup(app);
  await sleep(60);
  assert.equal(app.setup, setup);
  assert.equal(setup.words.length, 12, 'the words kept are the 12 of the screen in front');
});

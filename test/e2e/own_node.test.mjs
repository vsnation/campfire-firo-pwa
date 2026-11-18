// An own Firo node is used only as the open wallet's secret approved it (outside security audit
// 2026-11-18, #3; lib/trust.js). Stored preferences alone (as someone with this browser's data could
// write them) never make the wallet connect to a node: a forged approval is not used, and one saved
// before 0.1.24 (no seal) is asked about once after the unlock, before anything connects.
//
//   npm run e2e:own-node   (stand-in engine, own build folder and port 8857)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, recordedPage, waitScreen, shot, PWA, SHOTS } from './harness.mjs';
import { createWallet, waitHome, waitSynced, unlockWithPassword, givePassword } from './flows.mjs';

const PORT = 8857;
const PASSWORD = `node-${Math.random().toString(36).slice(2, 10)}`;
const MINE = 'mynode.example:50004';
const EVIL = 'node.attacker.example:50004';
const tid = (id) => `[data-testid="${id}"]`;
let tmp, srv, browser, ctx, page;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-own-node-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.route((u) => ['buyfiro.app', 'api.coingecko.com'].includes(u.hostname), (r) => r.abort());
  ({ page } = await recordedPage(ctx, { label: 'own-node' }));
  console.log(`# screenshots: ${SHOTS}`);
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** Writes the device's preferences as someone with this browser's data could (the first wallet's own are in them). */
const writePrefs = (patch) =>
  page.evaluate(async (p) => {
    const { rawStore } = await import('./lib/store.js');
    await rawStore.set('prefs', { ...(await rawStore.get('prefs')), ...p });
  }, patch);
const prefs = () => page.evaluate(async () => (await import('./lib/store.js')).rawStore.get('prefs'));
const lockNow = () => page.evaluate(async () => (await import('./app.js')).app.lock('manual'));

test('a wallet, unlocked', { timeout: 5 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD, words: 12 });
  await waitHome(page);
  await waitSynced(page);
});

test('a forged approval in storage is never used: asked about before anything connects; the public ones chosen, it is gone', { timeout: 3 * 60000 }, async () => {
  await lockNow();
  await writePrefs({ server: EVIL, trusted: { firo: EVIL, mac: { firo: 'ab'.repeat(32) } } });
  await unlockWithPassword(page, PASSWORD);
  await waitScreen(page, 'ownNodeConfirm', 30000);
  assert.equal(await page.evaluate(() => window.__campfire.running()), false, 'nothing connected');
  assert.match(await page.textContent('#app'), /its approval of it doesn't check out/);
  await page.click(tid('own-node-public'));
  await waitHome(page);
  assert.notEqual(await page.evaluate(() => window.__campfire.server()), `wss://${EVIL}`);
  const p = await prefs();
  assert.equal(p.server, 'firo');
  assert.equal(p.trusted.firo, undefined);
  await page.evaluate(() => window.__campfire.go('servers'));
  await waitScreen(page, 'servers');
  assert.match(await page.textContent(tid('servers-mode')), /Firo's public nodes/);
});

test('an approval left over from a node this device no longer uses is dropped without a question', { timeout: 3 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('home'));
  await lockNow();
  await writePrefs({ server: 'firo', trusted: { firo: MINE } });
  await unlockWithPassword(page, PASSWORD);
  await waitHome(page);
  assert.equal((await prefs()).trusted.firo, undefined);
});

test('one saved before 0.1.24 (no seal) is asked about after the unlock, before anything connects; the public ones chosen, it is gone', { timeout: 3 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('home'));
  await lockNow();
  await writePrefs({ server: MINE, trusted: { firo: MINE } });
  await unlockWithPassword(page, PASSWORD);
  await waitScreen(page, 'ownNodeConfirm', 30000);
  assert.equal(await page.evaluate(() => window.__campfire.running()), false, 'the engine has not started: nothing connected');
  assert.match(await page.textContent(tid('own-node-list')), /Your own Firo node: mynode\.example:50004/);
  await shot(page, 'own-node-confirm');
  await page.click(tid('own-node-public'));
  await waitHome(page);
  const p = await prefs();
  assert.equal(p.server, 'firo', "the device is back on Firo's public nodes");
  assert.equal(p.trusted.firo, undefined, 'the approval is gone');
  assert.equal(await page.evaluate(() => window.__campfire.running()), true);
});

test('kept: sealed under the wallet\'s secret, and not asked again', { timeout: 4 * 60000 }, async () => {
  await lockNow();
  await writePrefs({ server: MINE, trusted: { firo: MINE } });
  await unlockWithPassword(page, PASSWORD);
  await waitScreen(page, 'ownNodeConfirm', 30000);
  // Keeping it takes the password; this page's policy does not name the node yet: the app reopens on
  // it (unlock again), as when a node is first chosen.
  await page.click(tid('own-node-keep'));
  await Promise.all([page.waitForEvent('load', { timeout: 60000 }), givePassword(page, PASSWORD)]);
  await waitScreen(page, 'unlock', 60000);
  assert.match(await page.textContent('#app'), /Unlock to connect through your own node, mynode\.example:50004/);
  await unlockWithPassword(page, PASSWORD);
  await waitHome(page);
  const p = await prefs();
  assert.equal(p.trusted.firo, MINE);
  assert.match(p.trusted.mac.firo, /^[0-9a-f]{64}$/, 'sealed');
  await lockNow();
  await unlockWithPassword(page, PASSWORD);
  await waitHome(page);
  await page.evaluate(() => window.__campfire.go('servers'));
  await waitScreen(page, 'servers');
  assert.match(await page.textContent(tid('servers-mode')), /Your own node, mynode\.example:50004/);
});

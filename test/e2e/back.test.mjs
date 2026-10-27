// System back (lib/back.js) in a real browser: in German (the Back's label is translated) a Back
// goes to the previous screen, and in a Home Screen app a Back on Home stays on Home, also after a
// reload, which left entries from the page before it (owner, 2026-10-26: a swipe asked for Face ID).
//
//   npm run e2e:back   (stand-in engine, own build folder and port 8852)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, recordedPage, waitScreen, sleep, PWA } from './harness.mjs';
import { createWallet, waitHome, unlockWithPassword } from './flows.mjs';

const PORT = 8852;
const PASSWORD = `back-${Math.random().toString(36).slice(2, 10)}`;
let tmp, srv, browser;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-back-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const screen = (page) => page.evaluate(() => window.__campfire.screen());

/** The system's Back, as the edge swipe gives it, once the app has had a touch. */
async function systemBack(page) {
  await page.evaluate(() => history.back());
  await sleep(400);
}

async function open(page, name) {
  await page.evaluate((n) => window.__campfire.go(n), name);
  await waitScreen(page, name);
}

test('in German a Back goes to the previous screen; in a Home Screen app Home stays, also after a reload', { timeout: 5 * 60000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'de-DE' });
  // A Home Screen app, as iOS reports it.
  await ctx.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
  const { page } = await recordedPage(ctx, { label: 'back' });
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD, words: 12 });
  await waitHome(page);
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'de');
  await page.mouse.click(5, 400); // the first touch, after which the app has its entries

  await open(page, 'settings');
  await open(page, 'about');
  assert.equal(await page.getAttribute('.topbar button[data-nav="back"]', 'aria-label'), 'Zurück');
  await systemBack(page);
  assert.equal(await screen(page), 'settings', 'About -> Settings');
  await systemBack(page);
  assert.equal(await screen(page), 'home', 'Settings -> Home');
  await systemBack(page);
  assert.equal(await screen(page), 'home', 'Home stays');

  // A reload (an update, a lock in another tab) leaves this page's entries behind it: a Back on Home
  // must not reach them, which started the app again at Unlock.
  await page.reload();
  await unlockWithPassword(page, PASSWORD);
  await waitHome(page);
  await page.mouse.click(5, 400);
  const loads = await page.evaluate(() => performance.getEntriesByType('navigation').length);
  for (let i = 0; i < 3; i++) await systemBack(page);
  assert.equal(await screen(page), 'home', 'still Home, not Unlock');
  assert.equal(await page.evaluate(() => performance.getEntriesByType('navigation').length), loads, 'no new page load');
  await ctx.close();
});

const entry = (page) => page.evaluate(() => (history.state && history.state.campfire === 'back' ? history.state.n : null));

test('the history holds one entry per step a Back can take: screens, a sheet; the app\'s own Back and the Wallet tab go back over them', { timeout: 5 * 60000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page } = await recordedPage(ctx, { label: 'back-entries' });
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD, words: 12 });
  await waitHome(page);
  await page.mouse.click(5, 400);
  await sleep(200);
  const n0 = await entry(page);
  assert.equal(typeof n0, 'number', 'entries from the first touch');
  await open(page, 'settings');
  assert.equal(await entry(page), n0 + 1, 'Settings: Wallet under it');
  await open(page, 'about');
  assert.equal(await entry(page), n0 + 2);
  await page.click('.topbar button[data-nav="back"]');
  await waitScreen(page, 'settings');
  await sleep(300);
  assert.equal(await entry(page), n0 + 1, 'the top bar\'s Back went back over its entry');
  // A sheet has its own entry; a Back closes it, and the screen stays.
  await page.evaluate(async () => {
    const { openSheet } = await import(new URL('lib/ui.js', document.baseURI).href);
    openSheet((close) => [Object.assign(document.createElement('p'), { textContent: 'a sheet' }), Object.assign(document.createElement('button'), { textContent: 'Close', onclick: () => close() })]);
  });
  await sleep(200);
  assert.equal(await entry(page), n0 + 2, 'the sheet\'s entry');
  await systemBack(page);
  assert.equal(await page.locator('.overlay').count(), 0, 'the Back closed the sheet');
  assert.equal(await screen(page), 'settings');
  assert.equal(await entry(page), n0 + 1);
  await open(page, 'about');
  await open(page, 'home'); // as the Wallet tab does
  await sleep(300);
  assert.equal(await entry(page), n0, 'Wallet went back over the entries');
  await page.evaluate(() => history.forward());
  await sleep(400);
  assert.equal(await screen(page), 'home', 'nothing ahead to go Forward to');
  assert.equal(await entry(page), n0);
  await ctx.close();
});

test('in a browser tab a Back on Home still leaves the app', { timeout: 5 * 60000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const { page } = await recordedPage(ctx, { label: 'back-tab' });
  await page.goto('about:blank');
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD, words: 12 });
  await waitHome(page);
  await page.mouse.click(5, 400);
  await page.evaluate(() => void setTimeout(() => history.back(), 0)); // the page goes: not inside evaluate
  await page.waitForURL('about:blank', { timeout: 10000 });
  await ctx.close();
});

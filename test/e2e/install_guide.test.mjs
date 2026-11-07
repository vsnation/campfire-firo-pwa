// 0.1.20: installing Firo PWA on every browser that can (owner, 2026-11-05: "Why I don't see Install
// recommendation and requirement"), the passphrase said on Home and kept out of password managers'
// reach, and public FIRO counted on one node's proof, said as such.
//
//   node --test --test-concurrency=1 test/e2e/install_guide.test.mjs   (stand-in engine, no network)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, waitScreen, shot, sleep, PWA, SHOTS } from './harness.mjs';
import { createWallet, restoreWallet, waitHome, waitSynced, SAMPLE_WORDS } from './flows.mjs';

const PORT = Number(process.env.CAMPFIRE_INSTALL_PORT || 8857);
const tid = (id) => `[data-testid="${id}"]`;
const pw = () => `inst-${Math.random().toString(36).slice(2, 12)}`;
const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
};
let tmp, srv, browser;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-install-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  console.log(`# screenshots: ${SHOTS}`);
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function open(kind, { scheme = 'light' } = {}) {
  const phone = kind === 'iphone' || kind === 'android';
  const ctx = await browser.newContext({ viewport: phone ? { width: 375, height: 667 } : { width: 1280, height: 800 }, deviceScaleFactor: 2, ...(UA[kind] ? { userAgent: UA[kind] } : {}), colorScheme: scheme, hasTouch: phone, isMobile: kind === 'android' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(srv.url);
  await waitScreen(page, 'welcome', 60000);
  return { ctx, page, errors };
}

/** The browser's own install event, as Chrome sends it about a second after load; `outcome` is the person's answer. */
const offerInstall = (page, outcome = 'accepted') =>
  page.evaluate((o) => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    e.prompt = async () => {
      window.__prompted = (window.__prompted || 0) + 1;
    };
    e.userChoice = Promise.resolve({ outcome: o });
    window.dispatchEvent(e);
  }, outcome);

test('iPhone Safari tab: Welcome says to add it to the Home Screen first, with the iOS 26 steps; the X hides it', async () => {
  const { ctx, page, errors } = await open('iphone');
  await page.waitForSelector(tid('a2hs'));
  assert.equal(await page.getAttribute(tid('a2hs'), 'data-way'), 'ios');
  assert.match(await page.textContent(tid('a2hs')), /^First, add Firo PWA to your Home Screen/);
  assert.match(await page.textContent(tid('a2hs')), /Safari deletes a site's data after 7 days without a visit\. The Home Screen app is not under that rule\. A wallet made in a Safari tab does not move to the Home Screen app\./);
  await shot(page, 'install-01-iphone-welcome');
  await page.click(tid('a2hs-how'));
  await page.waitForSelector(tid('a2hs-steps'));
  const steps = await page.$$eval(`${tid('a2hs-steps')} li`, (els) => els.map((e) => e.textContent.trim()));
  assert.equal(steps.length, 3);
  assert.match(steps[0], /^Tap Share \. No Share button\? Tap +or +next to the address first\.$/);
  assert.match(steps[2], /^Open Firo PWA from your Home Screen and start your wallet there\.$/);
  assert.equal(await page.locator(`${tid('a2hs-steps')} li:first-child svg`).count(), 3, 'Share, ••• and ☰ drawn');
  await shot(page, 'install-02-iphone-steps');
  await page.click(tid('a2hs-got-it'));
  await page.click(tid('a2hs-close'));
  await page.waitForFunction(() => !document.querySelector('[data-testid="a2hs"]'));
  await page.reload();
  await waitScreen(page, 'welcome');
  await sleep(500);
  assert.equal(await page.locator(tid('a2hs')).count(), 0, 'hidden for good on Welcome (Home and Settings still offer it)');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Mac Safari 17+: Welcome says Add to Dock, with File -> Add to Dock', async () => {
  const { ctx, page, errors } = await open('mac');
  await page.waitForSelector(tid('a2hs'));
  assert.equal(await page.getAttribute(tid('a2hs'), 'data-way'), 'mac');
  assert.match(await page.textContent(tid('a2hs')), /^First, add Firo PWA to the Dock/);
  await page.click(tid('a2hs-how'));
  const steps = await page.$$eval(`${tid('a2hs-steps')} li`, (els) => els.map((e) => e.textContent.trim()));
  assert.match(steps[0], /^In the menu bar, choose File, then Add to Dock\. Or click Share +in the toolbar, then Add to Dock\.$/);
  assert.equal(steps[1], 'Click Add.');
  assert.equal(steps[2], 'Open Firo PWA from the Dock and start your wallet there.');
  await shot(page, 'install-03-mac-steps');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Chrome: nothing until the browser offers Install; then one tap opens its Install dialog, and the card goes', async () => {
  const { ctx, page, errors } = await open('desktop');
  await sleep(800);
  assert.equal(await page.locator(tid('a2hs')).count(), 0, 'no card where nothing can be installed (yet)');
  await offerInstall(page);
  await page.waitForSelector(tid('a2hs'));
  assert.equal(await page.getAttribute(tid('a2hs'), 'data-way'), 'prompt');
  assert.match(await page.textContent(tid('a2hs')), /^Install Firo PWA\s*It opens like an app, and the browser keeps its data instead of clearing it when space runs low\.\s*Install$/);
  assert.equal(await page.isVisible(tid('create')), true, 'the screen\'s one strong action stays');
  await shot(page, 'install-04-chrome-welcome');
  await page.click(tid('a2hs-install'));
  await page.waitForFunction(() => window.__prompted === 1);
  await page.waitForFunction(() => !document.querySelector('[data-testid="a2hs"]'));
  assert.match(await page.textContent('.toast'), /Firo PWA is installed\./);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Home, Chrome: a wallet in a tab is offered Install (it comes along), Later hides it for a week; Settings keeps the row; installed, both go', async () => {
  const { ctx, page, errors } = await open('android');
  await createWallet(page, { password: pw() });
  await waitHome(page);
  await offerInstall(page, 'dismissed');
  await page.waitForSelector(tid('install-home'));
  assert.match(await page.textContent(tid('install-home')), /Install Firo PWA It opens like an app, and the browser keeps its data instead of clearing it when space runs low\. Your wallet comes with it\./);
  const pay = await page.locator('.home-pay').boundingBox();
  const card = await page.locator(tid('install-home')).boundingBox();
  assert.ok(card.y > pay.y, 'under Send / Receive, which stay above the fold');
  assert.ok(pay.y + pay.height <= 667, 'Send / Receive visible at 375x667');
  await shot(page, 'install-05-android-home');
  await page.click(tid('install-later'));
  await page.waitForFunction(() => !document.querySelector('[data-testid="install-home"]'));
  await page.click(tid('tab-settings'));
  await page.waitForSelector(tid('install-row'));
  assert.match(await page.textContent(tid('install-row')), /^Install Firo PWA/);
  await page.click(tid('install-row'));
  await page.waitForFunction(() => window.__prompted === 1);
  assert.equal(await page.locator(tid('install-row')).count(), 0, 'the browser\'s prompt is used once');
  await offerInstall(page);
  await page.waitForSelector(tid('install-row'));
  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await page.waitForFunction(() => !document.querySelector('[data-testid="install-row"]'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('Home, iPhone Safari tab: the wallet can be deleted by Safari: said with the way out (restore it in the Home Screen app); a passphrase wallet says so, always', async () => {
  const { ctx, page, errors } = await open('iphone');
  await restoreWallet(page, { words: SAMPLE_WORDS, password: pw(), passphrase: 'tree house' });
  await waitHome(page);
  await page.waitForSelector(tid('install-home'));
  assert.equal(await page.getAttribute(tid('install-home'), 'data-way'), 'ios');
  assert.match(await page.textContent(tid('install-home')), /^Safari can delete this wallet after 7 days without a visit\. Add Firo PWA to your Home Screen \(Share, then Add to Home Screen\) and restore your wallet there with your recovery words: the Home Screen app keeps its data\./);
  await page.click(tid('install-home-how'));
  const last = await page.$eval(`${tid('a2hs-steps')} li:last-child`, (e) => e.textContent.trim());
  assert.equal(last, 'Open Firo PWA from your Home Screen and restore your wallet there with your recovery words.');
  await page.click(tid('a2hs-got-it'));
  // The passphrase line, and what it means.
  await page.waitForSelector(tid('home-passphrase'));
  assert.equal((await page.textContent(tid('home-passphrase'))).trim(), 'This wallet uses a passphrase');
  await shot(page, 'install-06-iphone-home');
  await page.click(tid('home-passphrase'));
  await page.waitForSelector(tid('passphrase-got-it'));
  const sheet = await page.textContent('.sheet');
  assert.match(sheet, /The same words with no passphrase, or another one, open a different wallet with different coins\./);
  assert.match(sheet, /Didn't type a passphrase\? Your browser's password manager may have filled it in\. Add the wallet again from the same words and leave the passphrase empty\./);
  await shot(page, 'install-07-passphrase-sheet');
  await page.click(tid('passphrase-add-again'));
  await waitScreen(page, 'addWallet');
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('a wallet without a passphrase says nothing about one', async () => {
  const { ctx, page } = await open('desktop');
  await restoreWallet(page, { words: SAMPLE_WORDS, password: pw() });
  await waitHome(page);
  await waitSynced(page);
  assert.equal(await page.locator(tid('home-passphrase')).count(), 0);
  await ctx.close();
});

test('the passphrase box: dots in a text box with a mouse (no password manager fills it); filled all the same, it is said, with one tap to clear', async () => {
  const { ctx, page } = await open('desktop');
  await page.click(tid('restore'));
  await waitScreen(page, 'restore');
  await page.click('[data-testid="advanced"] summary');
  const box = page.locator(tid('passphrase'));
  assert.equal(await box.getAttribute('type'), 'text');
  assert.match(await box.getAttribute('class'), /\bdots\b/);
  assert.equal(await box.evaluate((e) => getComputedStyle(e).webkitTextSecurity), 'disc');
  await box.fill('filled by a password manager');
  // As the browser's autofill style does (css/app.css: its animation starts).
  await box.evaluate((e) => e.dispatchEvent(new AnimationEvent('animationstart', { animationName: 'cf-autofill' })));
  await page.waitForSelector(tid('passphrase-clear'));
  assert.match(await page.textContent(tid('passphrase-autofilled')), /^Your browser filled in a passphrase\. A passphrase is not a password for this site: with one, these words open a different wallet\. Clear it unless this wallet was made with one\./);
  await shot(page, 'install-08-passphrase-autofilled');
  await page.click(tid('passphrase-clear'));
  assert.equal(await box.inputValue(), '');
  assert.equal(await page.locator(tid('passphrase-clear')).count(), 0);
  // Show the passphrase: the dots go, and come back.
  await page.check(tid('passphrase-show'));
  assert.doesNotMatch(await box.getAttribute('class'), /\bdots\b/);
  await page.uncheck(tid('passphrase-show'));
  assert.match(await box.getAttribute('class'), /\bdots\b/);
  await ctx.close();
});

test('the passphrase box with a touch screen stays a password box (keyboards learn text boxes)', async () => {
  const { ctx, page } = await open('android');
  await page.click(tid('restore'));
  await waitScreen(page, 'restore');
  await page.click('[data-testid="advanced"] summary');
  assert.equal(await page.getAttribute(tid('passphrase'), 'type'), 'password');
  await ctx.close();
});

test('public FIRO counted on one node\'s proof: in the figure, and said so under it; the one-node line says payments count on its word', async () => {
  const { ctx, page } = await open('desktop');
  await createWallet(page, { password: pw() });
  await waitHome(page);
  await waitSynced(page);
  const ff = (fn, ...args) => page.evaluate(([f, a]) => globalThis.__firoFake[f](...a), [fn, args]);
  await ff('hold', true);
  await ff('publicOneNode', '150000000');
  await ff('noSecond', 3);
  await page.waitForFunction(() => /confirmed by one Firo node/.test(document.querySelector('[data-testid="balance-pending"]')?.textContent || ''));
  assert.match(await page.textContent(tid('balance-pending')), /Public includes 1\.5 FIRO confirmed by one Firo node/);
  assert.match(await page.textContent(tid('balance-public')), /^1\.5 FIRO$/);
  await page.waitForFunction(() => /Synced with one Firo node/.test(document.querySelector('[data-testid="sync"]')?.textContent || ''));
  assert.equal((await page.textContent(tid('sync-detail'))).trim(), "No second Firo node could be reached: public payments received count on this node's word until one can confirm them.");
  await shot(page, 'install-09-one-node');
  await ff('publicOneNode', 0);
  await ff('noSecond', 0);
  await ctx.close();
});

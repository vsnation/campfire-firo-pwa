// Someone holding the unlocked wallet (security audit of 0.1.21): what could redirect the owner's
// next payment now takes the password — a node of one's own (it decides who a Spark name pays), a
// saved contact's new address, a longer auto-lock — and Review shows the whole address, so one
// swapped in the clipboard or a contact can be checked in full. Cancelled, nothing changes.
//
//   npm run e2e:guards   (stand-in engine, own build folder and port 8855)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, recordedPage, waitScreen, shot, sleep, PWA, SHOTS } from './harness.mjs';
import { createWallet, waitHome, waitSynced, givePassword } from './flows.mjs';

const PORT = 8855;
const PASSWORD = `guard-${Math.random().toString(36).slice(2, 10)}`;
const tid = (id) => `[data-testid="${id}"]`;
let tmp, srv, browser, ctx, page, rec;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-guards-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.route((u) => ['buyfiro.app', 'api.coingecko.com'].includes(u.hostname), (r) => r.abort());
  ({ page, rec } = await recordedPage(ctx, { label: 'guards' }));
  console.log(`# screenshots: ${SHOTS}`);
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const cancelSheet = async () => {
  await page.waitForSelector(tid('auth-pw'));
  await page.click(tid('auth-cancel'));
  await page.waitForSelector(tid('auth-pw'), { state: 'detached' });
};
const other = (kind) => page.evaluate((k) => window.__firoFake.otherAddress(k), kind);
const contacts = () => page.evaluate(async () => {
  const { loadContacts } = await import('./lib/contacts.js');
  return (await loadContacts(window.__campfire.app ?? { })).map((c) => ({ name: c.name, address: c.address }));
}).catch(() => null);

test('a wallet, unlocked', { timeout: 5 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD });
  await waitHome(page);
  await waitSynced(page);
});

test("adding a contact and changing its address need the password; cancelled, the contact keeps its address", { timeout: 3 * 60000 }, async () => {
  const a = await other('spark');
  const b = await other('transparent');
  await page.evaluate(() => window.__campfire.go('contacts'));
  await waitScreen(page, 'contacts');
  await page.click(tid('contact-add'));
  await page.fill(tid('contact-name'), 'Alice');
  await page.fill(tid('contact-address-input'), a);
  await page.click(tid('contact-save'));
  // Every address-book write asks for the password (round-2 audit), adding too.
  await givePassword(page, PASSWORD);
  await page.waitForSelector(tid('contacts-list'));
  await page.click(`${tid('contacts-list')} .row`);
  await page.click(tid('contact-edit'));
  await page.fill(tid('contact-address-input'), b);
  await page.click(tid('contact-save'));
  await cancelSheet();
  await sleep(300);
  // Still Alice's first address.
  await page.evaluate(() => window.__campfire.go('contacts'));
  await waitScreen(page, 'contacts');
  await page.click(`${tid('contacts-list')} .row`);
  assert.equal((await page.textContent(tid('contact-address'))).replace(/\s/g, ''), a, 'unchanged');
  await page.click(tid('contact-edit'));
  await page.fill(tid('contact-address-input'), b);
  await page.click(tid('contact-save'));
  await shot(page, 'guards-01-contact-password');
  await givePassword(page, PASSWORD);
  await page.evaluate(() => window.__campfire.go('contacts'));
  await waitScreen(page, 'contacts');
  await page.click(`${tid('contacts-list')} .row`);
  assert.equal((await page.textContent(tid('contact-address'))).replace(/\s/g, ''), b, 'changed with the password');
});

test('deleting a contact needs the password; a second contact with the same name is refused', { timeout: 2 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('contacts'));
  await waitScreen(page, 'contacts');
  await page.click(tid('contact-add'));
  await page.fill(tid('contact-name'), 'alice');
  await page.fill(tid('contact-address-input'), await other('spark'));
  await page.click(tid('contact-save'));
  await page.waitForFunction(() => /already in your contacts/.test(document.querySelector('.overlay .sheet')?.textContent || ''), null, { timeout: 10000 });
  await page.click(tid('contact-cancel'));
  await page.click(`${tid('contacts-list')} .row`);
  await page.click(tid('contact-delete'));
  await page.click(tid('contact-delete-confirm'));
  await cancelSheet();
  await page.evaluate(() => window.__campfire.go('contacts'));
  await waitScreen(page, 'contacts');
  assert.ok(await page.isVisible(`${tid('contacts-list')} .row`), 'still there');
});

test('your own Firo node needs the password; cancelled, nothing is saved', { timeout: 2 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('servers'));
  await waitScreen(page, 'servers');
  await page.fill(tid('own-server'), 'node.attacker.test:50004');
  await page.click(tid('use-own-server'));
  await cancelSheet();
  await sleep(500);
  // Read from the store itself (release audit of the fixes: the earlier check read nothing).
  const saved = await page.evaluate(async () => (await (await import('./lib/store.js')).getPrefs()).server);
  assert.equal(saved, 'firo', "not saved: Firo's public nodes");
  assert.equal(await page.isDisabled(tid('use-own-server')), false, 'the button works again');
  await shot(page, 'guards-02-own-node-cancelled');
});

test('a longer auto-lock needs the password; a shorter one does not', { timeout: 2 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  const was = await page.inputValue(tid('autolock-select'));
  await page.selectOption(tid('autolock-select'), '15');
  await cancelSheet();
  assert.equal(await page.inputValue(tid('autolock-select')), was, 'back to what it was');
  await page.selectOption(tid('autolock-select'), '1');
  await sleep(400);
  assert.equal(await page.isVisible(tid('auth-pw')), false, 'shorter: no password');
  assert.equal(await page.inputValue(tid('autolock-select')), '1');
});

test('Review shows the whole address', { timeout: 2 * 60000 }, async () => {
  await page.evaluate(() => { window.__firoFake.credit({ to: 'private', amount: '500000000' }); window.__firoFake.mine(); });
  await sleep(1500);
  const to = await other('spark');
  await page.evaluate(() => window.__campfire.go('send'));
  await waitScreen(page, 'send');
  await page.fill(tid('send-address'), to);
  await page.fill(tid('send-amount'), '1');
  await page.waitForFunction(() => !document.querySelector('[data-testid="review"]').disabled, null, { timeout: 20000 });
  await page.click(tid('review'));
  await waitScreen(page, 'review');
  assert.equal((await page.textContent(tid('review-to'))).trim(), to);
  await shot(page, 'guards-03-review-full-address');
  assert.deepEqual(rec.errors, []);
});

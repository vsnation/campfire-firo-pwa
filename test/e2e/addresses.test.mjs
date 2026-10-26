// My addresses (owner, 2026-10-26): every address of the wallet, numbered, with what it holds; a
// search that finds one by a part of it; a pasted address said to be this wallet's or not, also one
// another wallet of the same words handed out; Send names any of them.
//
//   npm run e2e:addresses   (stand-in engine, own build folder and port 8853)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, recordedPage, waitScreen, shot, sleep, PWA, SHOTS } from './harness.mjs';
import { createWallet, waitHome, waitSynced } from './flows.mjs';

const PORT = 8853;
const tid = (id) => `[data-testid="${id}"]`;
let tmp, srv, browser, ctx, page;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-addr-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2 });
  ({ page } = await recordedPage(ctx, { label: 'addresses' }));
  console.log(`# screenshots: ${SHOTS}`);
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

async function both(name) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(250);
    await shot(page, `${name}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const names = () => page.$$eval(tid('addr-name'), (els) => els.map((e) => e.textContent));
const verdict = () => page.textContent(tid('addr-verdict'));

test('Receive -> My addresses lists them, numbered, the current one marked; a search finds one by a part', { timeout: 5 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: `addr-${Math.random().toString(36).slice(2, 10)}`, words: 12 });
  await waitHome(page);
  await waitSynced(page);
  await page.evaluate(() => {
    window.__firoFake.credit({ to: 'private', amount: '125000000' });
    window.__firoFake.credit({ to: 'public', amount: '30000000' });
    window.__firoFake.mine();
  });
  await sleep(500);
  await page.click(tid('receive'));
  await waitScreen(page, 'receive');
  await page.click(tid('new-address'));
  await page.click(tid('new-address'));
  await sleep(300);
  await page.click(tid('my-addresses'));
  await waitScreen(page, 'addresses');
  await page.waitForSelector(tid('addr-list-spark'));
  assert.deepEqual(await names(), ['Spark address 1', 'Spark address 2', 'Spark address 3']);
  const current = await page.$$eval(tid('addr-row'), (rows) => rows.map((r) => Boolean(r.querySelector('[data-testid="addr-current"]'))));
  assert.deepEqual(current, [false, false, true], 'the one Receive shows');
  assert.deepEqual(await page.$$eval(tid('addr-holds'), (els) => els.map((e) => e.textContent)), ['Holds 1.25 FIRO · 1 payment', 'Holds nothing now · 0 payments', 'Holds nothing now · 0 payments']);
  // The search field and the first row are on a small phone's screen.
  for (const id of ['addr-search', 'addr-row']) {
    const b = await page.locator(tid(id)).first().boundingBox();
    assert.ok(b && b.y + b.height <= 667, `${id} visible at 375 x 667`);
  }
  await both('addresses-spark');

  const second = await page.$$eval(tid('addr-row'), (rows) => rows[1].dataset.address);
  await page.fill(tid('addr-search'), second.slice(20, 32));
  await sleep(200);
  assert.deepEqual(await names(), ['Spark address 2'], 'found by a part of it');
  await page.fill(tid('addr-search'), 'zzzzzzzz');
  await page.waitForSelector(tid('addr-none'));
  await page.fill(tid('addr-search'), '');

  await page.click(tid('addr-kind-transparent'));
  await page.waitForSelector(tid('addr-list-transparent'));
  assert.deepEqual(await names(), ['Public address 1']);
  await both('addresses-public');

  await page.click(tid('addr-row'));
  await page.waitForSelector(tid('addr-sheet-title'));
  assert.equal(await page.textContent(tid('addr-sheet-title')), 'Public address 1');
  assert.equal(await page.textContent(tid('addr-sheet-address')), await page.$eval(tid('addr-row'), (r) => r.dataset.address));
  await both('addresses-sheet');
});

test('a pasted address: this wallet\'s (also one handed out elsewhere) or not, said at once', { timeout: 2 * 60000 }, async () => {
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.__campfire.go('addresses'));
  await waitScreen(page, 'addresses');
  await page.waitForSelector(tid('addr-list-spark'));
  const unlisted = await page.evaluate(() => window.__firoFake.unlistedAddress('spark', 10));
  await page.fill(tid('addr-search'), unlisted);
  await page.waitForSelector(tid('addr-mine'));
  assert.match(await verdict(), /Yes, this address is yours: Spark address 13\. Payments to it come to this wallet\./);
  await both('addresses-mine');
  await page.fill(tid('addr-search'), await page.evaluate(() => window.__firoFake.otherAddress('spark')));
  await page.waitForSelector(tid('addr-not-mine'));
  assert.match(await verdict(), /not one of this wallet’s/);
  await both('addresses-not-mine');
  // A public one of this wallet switches the list to Public.
  await page.fill(tid('addr-search'), await page.evaluate(() => window.__firoFake.unlistedAddress('transparent', 3)));
  await page.waitForSelector(tid('addr-mine'));
  assert.match(await verdict(), /yours: Public address 4\./);
  assert.equal(await page.getAttribute(tid('addr-kind-transparent'), 'aria-checked'), 'true');
});

test('Settings has My addresses; Send names any address of this wallet', { timeout: 2 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('settings'));
  await waitScreen(page, 'settings');
  await page.click(tid('my-addresses-row'));
  await waitScreen(page, 'addresses');
  await page.evaluate(() => window.__campfire.go('send'));
  await waitScreen(page, 'send');
  await page.fill(tid('send-address'), await page.evaluate(() => window.__firoFake.unlistedAddress('spark', 4)));
  await page.waitForFunction(() => /It is one of your addresses: Spark address 7\. The payment stays in this wallet\./.test(document.querySelector('[data-testid="address-hint"]')?.textContent || ''));
  await both('send-own-address');
  await page.fill(tid('send-address'), await page.evaluate(() => window.__firoFake.otherAddress('spark')));
  await sleep(500);
  assert.doesNotMatch(await page.textContent(tid('address-hint')), /your addresses/);
});

test('in German and Russian the screen fits a small phone: no text runs out of its box', { timeout: 5 * 60000 }, async () => {
  for (const locale of ['de-DE', 'ru-RU']) {
    const c = await browser.newContext({ viewport: { width: 375, height: 667 }, deviceScaleFactor: 2, locale });
    const { page: p } = await recordedPage(c, { label: `addresses-${locale}` });
    await p.goto(srv.url);
    await createWallet(p, { password: `addr-${Math.random().toString(36).slice(2, 10)}`, words: 12 });
    await waitHome(p);
    await p.evaluate(() => {
      window.__firoFake.credit({ to: 'private', amount: '125000000' });
      window.__firoFake.mine();
    });
    await p.evaluate(() => window.__campfire.go('addresses'));
    await waitScreen(p, 'addresses');
    await p.waitForSelector(tid('addr-list-spark'));
    await p.fill(tid('addr-search'), await p.evaluate(() => window.__firoFake.unlistedAddress('spark', 2)));
    await p.waitForSelector(tid('addr-mine'));
    const over = await p.evaluate(() => [...document.querySelectorAll('main *')].filter((e) => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX === 'visible' && e.children.length === 0).map((e) => e.textContent.slice(0, 40)));
    assert.deepEqual(over, [], `${locale}: nothing wider than its box`);
    assert.ok((await p.evaluate(() => document.documentElement.scrollWidth)) <= 375, `${locale}: no sideways scroll`);
    await shot(p, `addresses-${locale}`);
    // Receive's two links share a row and stay inside it.
    await p.evaluate(() => window.__campfire.go('receive'));
    await waitScreen(p, 'receive');
    await p.waitForSelector(tid('my-addresses'));
    const fit = await p.evaluate(() => ['new-address', 'my-addresses'].map((id) => { const e = document.querySelector(`[data-testid="${id}"]`); const r = e.getBoundingClientRect(); return e.scrollWidth <= e.clientWidth + 1 && r.right <= 375 && r.left >= 0; }));
    assert.deepEqual(fit, [true, true], `${locale}: Receive's links fit`);
    assert.ok((await p.evaluate(() => document.documentElement.scrollWidth)) <= 375);
    await shot(p, `receive-${locale}`);
    await c.close();
  }
});

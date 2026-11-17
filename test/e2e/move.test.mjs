// Privatize and Make public (0.1.21, owner 2026-11-17: "make an amount optional, so a user can select
// like 25%", and both ways: "we can't do limitations to the user to insist for them to use only
// private transactions"). Home has the Privatize pill and "Make FIRO public" under it; each opens the
// same screen, the way switchable at the top; the amount is typed or picked (25%, 50%, 75%, All); the
// fee is worked out for that amount; the move ends on its status screen and in Activity.
//
//   npm run e2e:move   (stand-in engine, own build folder and port 8851)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, recordedPage, waitScreen, shot, sleep, PWA, SHOTS } from './harness.mjs';
import { createWallet, waitHome, waitSynced, unlockWithPassword } from './flows.mjs';

const PORT = 8851;
const PASSWORD = `move-${Math.random().toString(36).slice(2, 10)}`;
const tid = (id) => `[data-testid="${id}"]`;
let tmp, srv, browser, ctx, page, rec;

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-move-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.route((u) => ['buyfiro.app', 'api.coingecko.com'].includes(u.hostname), (r) => r.abort());
  ({ page, rec } = await recordedPage(ctx, { label: 'move' }));
  console.log(`# screenshots: ${SHOTS}`);
});

test.after(async () => {
  if (browser) await browser.close();
  if (srv) srv.stop();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const credit = (to, amount) =>
  page.evaluate(([t, a]) => {
    window.__firoFake.credit({ to: t, amount: a });
    window.__firoFake.mine();
  }, [to, amount]);
const balance = () => page.evaluate(async () => {
  const { wallet } = await import('./lib/wallet.js');
  const b = wallet.state.balance;
  return { private: String(b.private.available), public: String(b.public.available) };
});

async function both(name) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await sleep(250);
    await shot(page, `${name}-${scheme}`);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

async function confirmPassword() {
  await page.waitForSelector(tid('auth-pw'));
  await page.fill(tid('auth-pw'), PASSWORD);
  await page.click(tid('auth-submit'));
}

const fee = () => page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="privatize-fee"]')?.textContent || '') && !document.querySelector('[data-testid="privatize-confirm"]').disabled, null, { timeout: 15000 });

test('a wallet with both balances: Home offers Privatize and Make FIRO public', { timeout: 5 * 60000 }, async () => {
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD });
  await waitHome(page);
  await waitSynced(page);
  await credit('public', '400000000000'); // 4,000 FIRO public
  await credit('private', '1000000000000'); // 10,000 FIRO private
  await page.waitForFunction(() => /4,000/.test(document.querySelector('[data-testid="privatize"]')?.textContent || ''), null, { timeout: 20000 });
  assert.ok(await page.isVisible(tid('make-public')), 'Make FIRO public on Home');
  await both('move-01-home');
});

test('Privatize opens with everything in; 25% moves a quarter, the fee on top; confirmed in Activity', { timeout: 3 * 60000 }, async () => {
  await page.click(tid('privatize'));
  await waitScreen(page, 'privatize');
  assert.equal(await page.inputValue(tid('move-amount')), '4000', 'the whole public balance');
  assert.equal(await page.getAttribute(tid('move-max'), 'aria-pressed'), 'true', 'All is on');
  await fee();
  assert.match(await page.textContent(tid('privatize-confirm')), /^Privatize 3,999\.\d+ FIRO$/, 'All: the fee comes out of it');
  await both('move-02-privatize-all');
  await page.click(tid('move-pct-25'));
  assert.equal(await page.inputValue(tid('move-amount')), '1000');
  await fee();
  assert.equal(await page.textContent(tid('privatize-confirm')), 'Privatize 1,000 FIRO');
  assert.match(await page.textContent(tid('privatize-gets')), /^1,000 FIRO$/);
  assert.match(await page.textContent(tid('privatize-total')), /^1,000\.\d+ FIRO$/, 'what leaves: the amount and the fee');
  await both('move-03-privatize-25');
  await page.click(tid('privatize-confirm'));
  await confirmPassword();
  await waitScreen(page, 'txStatus');
  await page.evaluate(() => window.__firoFake.mine());
  await page.waitForFunction(() => document.querySelector('[data-testid="tx-title"]')?.textContent === 'Privatized', null, { timeout: 20000 });
  const b = await balance();
  assert.ok(BigInt(b.public) < 300000000000n && BigInt(b.public) > 299000000000n, `about 3,000 FIRO left public: ${b.public}`);
  assert.equal(b.private, '1100000000000', '11,000 FIRO private');
});

test('typing an amount turns the picks off; a too-large amount says so and moves nothing', { timeout: 2 * 60000 }, async () => {
  await page.evaluate(() => window.__campfire.go('privatize'));
  await waitScreen(page, 'privatize');
  await page.fill(tid('move-amount'), '123.45');
  assert.equal(await page.getAttribute(tid('move-max'), 'aria-pressed'), 'false');
  await fee();
  assert.equal(await page.textContent(tid('privatize-confirm')), 'Privatize 123.45 FIRO');
  await page.fill(tid('move-amount'), '999999');
  await page.waitForFunction(() => /more than your public balance/.test(document.querySelector('[data-testid="move-amount-hint"]')?.textContent || ''), null, { timeout: 10000 });
  assert.equal(await page.isDisabled(tid('privatize-confirm')), true);
  await both('move-04-too-much');
});

test('the way switches at the top, the amount kept; Make public opens empty and needs an amount', { timeout: 2 * 60000 }, async () => {
  await page.fill(tid('move-amount'), '50');
  await page.click(tid('move-way-makePublic'));
  await waitScreen(page, 'makePublic');
  assert.equal(await page.inputValue(tid('move-amount')), '50', 'the amount carried over');
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await page.click(tid('make-public'));
  await waitScreen(page, 'makePublic');
  assert.equal(await page.inputValue(tid('move-amount')), '', 'nothing made public unasked');
  assert.equal(await page.isDisabled(tid('privatize-confirm')), true);
  await both('move-05-make-public-empty');
});

test('Make public 50%: half the private balance, confirmed; Activity says Made public', { timeout: 3 * 60000 }, async () => {
  await page.click(tid('move-pct-50'));
  assert.equal(await page.inputValue(tid('move-amount')), '5500');
  await fee();
  assert.equal(await page.textContent(tid('privatize-confirm')), 'Make 5,500 FIRO public');
  assert.match(await page.textContent(tid('privatize-to')), /Your public balance/);
  await both('move-06-make-public-50');
  const before = await balance();
  await page.click(tid('privatize-confirm'));
  await confirmPassword();
  await waitScreen(page, 'txStatus');
  assert.equal(await page.textContent(tid('tx-title')), 'Making public…');
  await both('move-07-making-public');
  await page.evaluate(() => window.__firoFake.mine());
  await page.waitForFunction(() => document.querySelector('[data-testid="tx-title"]')?.textContent === 'Made public', null, { timeout: 20000 });
  const after = await balance();
  assert.equal(BigInt(after.public) - BigInt(before.public), 550000000000n, '5,500 FIRO arrived publicly');
  assert.ok(BigInt(before.private) - BigInt(after.private) > 550000000000n, 'the amount and its fee left the private balance');
  await page.click(tid('tx-done'));
  await waitScreen(page, 'home');
  await page.evaluate(() => window.__campfire.go('activity'));
  await waitScreen(page, 'activity');
  await page.waitForFunction(() => [...document.querySelectorAll('.row .t, .row .title, .tx-title')].some((e) => e.textContent.trim() === 'Made public'), null, { timeout: 10000 });
  await both('move-08-activity');
});

test('desktop: the same screen at 1280 px', { timeout: 2 * 60000 }, async () => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.evaluate(() => window.__campfire.go('makePublic'));
  await waitScreen(page, 'makePublic');
  await page.click(tid('move-pct-25'));
  await fee();
  await both('move-09-desktop');
  await page.evaluate(() => window.__campfire.go('home'));
  await waitScreen(page, 'home');
  await both('move-10-desktop-home');
  assert.deepEqual(rec.errors, [], 'no page errors');
});

test('a small phone (375 x 667): the button stays in sight', { timeout: 2 * 60000 }, async () => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.evaluate(() => window.__campfire.go('privatize'));
  await waitScreen(page, 'privatize');
  await page.click(tid('move-pct-50'));
  await fee();
  const b = await page.locator(tid('privatize-confirm')).boundingBox();
  assert.ok(b && b.y >= 0 && b.y + b.height <= 667, `the button on screen: ${JSON.stringify(b)}`);
  await both('move-11-small-phone');
});

test('German and Russian (the longest): both ways fit a 375 px phone, nothing wider than the screen', { timeout: 4 * 60000 }, async () => {
  for (const lang of ['de', 'ru']) {
    await page.evaluate((l) => localStorage.setItem('campfire-lang', l), lang);
    await page.reload();
    await unlockWithPassword(page, PASSWORD);
    await waitScreen(page, 'home');
    await waitSynced(page);
    for (const way of ['privatize', 'makePublic']) {
      await page.evaluate((w) => window.__campfire.go(w), way);
      await waitScreen(page, way);
      await page.click(tid('move-pct-25'));
      await fee();
      const wide = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
      assert.ok(wide <= 0, `${lang} ${way}: ${wide} px wider than the screen`);
      const b = await page.locator(tid('privatize-confirm')).boundingBox();
      assert.ok(b && b.y + b.height <= 667, `${lang} ${way}: the button on screen`);
      await shot(page, `move-12-${lang}-${way}`);
    }
  }
  await page.evaluate(() => localStorage.removeItem('campfire-lang'));
});

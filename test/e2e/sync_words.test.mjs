// What Home says about the sync (0.1.19, the balance-sync audit): a node too slow to answer, the
// private side that could not start, a first sync that outlasts the auto-lock, payments only one node
// can vouch for, and what stopped a sync, each as what it is, with the way out on the same screen.
//
//   node --test --test-concurrency=1 test/e2e/sync_words.test.mjs   (stand-in engine, no network)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, launch, recordedPage, waitScreen, shot, sleep, PWA, SHOTS } from './harness.mjs';
import { createWallet, waitHome, waitSynced } from './flows.mjs';

const PORT = Number(process.env.CAMPFIRE_SYNCWORDS_PORT || 8855);
const tid = (id) => `[data-testid="${id}"]`;
const PASSWORD = `sync-${Math.random().toString(36).slice(2, 12)}`;
let tmp, srv, browser, ctx, page;

const ff = (fn, ...args) => page.evaluate(([f, a]) => globalThis.__firoFake[f](...a), [fn, args]);
const text = (id) => page.textContent(tid(id)).then((x) => (x || '').trim());
const has = (id) => page.locator(tid(id)).count();
const state = () => page.getAttribute(tid('sync'), 'data-state');
const dot = () => page.getAttribute(`${tid('sync')} .dot`, 'class');

test.before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'campfire-syncwords-'));
  execFileSync(process.execPath, [join(PWA, 'tools', 'build.mjs'), '--out', join(tmp, 'dist'), '--quiet', '--engine', 'fake'], { cwd: PWA });
  srv = await startServer({ root: join(tmp, 'dist'), port: PORT });
  browser = await launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  ({ page } = await recordedPage(ctx, { label: 'syncwords' }));
  console.log(`# screenshots: ${SHOTS}`);
  await page.goto(srv.url);
  await createWallet(page, { password: PASSWORD });
  await waitHome(page);
  await waitSynced(page);
  await ff('hold', true);
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

test('a slow node: said as slow, not as "check your internet"; the way to another node is right there', async () => {
  await ff('syncError', 'slow');
  await page.waitForFunction(() => document.querySelector('[data-testid="sync"]')?.dataset.state === 'slow');
  assert.equal(await text('sync'), 'A Firo node is slow to answer');
  assert.match(await text('sync-detail'), /^(electrumx\S*\.firo\.org|ru-firo-node) did not answer in time\. Firo PWA asks again in a moment; on a slow connection the first sync takes a while\. Sending is paused until your wallet is up to date\.$/);
  assert.doesNotMatch(await text('sync-detail'), /internet/);
  assert.match(await dot(), /\bwait\b/);
  assert.equal(await has('sync-choose-node'), 1);
  await both('syncwords-01-slow');
  // A line too slow for the spent-coins list: said as that, with what helps.
  await ff('syncError', 'slow-link', 'The connection is too slow to receive the list of spent private coins from a Firo node.');
  await page.waitForFunction(() => /Connection too slow/.test(document.querySelector('[data-testid="sync"]')?.textContent || ''));
  assert.equal(await text('sync'), 'Connection too slow for the private sync');
  assert.match(await text('sync-detail'), /^Firo's nodes stop sending the list of spent private coins \(about 25 MB\) when it takes more than a minute/);
  assert.match(await dot(), /\bwait\b/);
  assert.equal(await has('sync-choose-node'), 1);
  await both('syncwords-01b-slow-link');
  // A full disk: said, with what to do.
  await ff('syncError', 'storage', 'Storage write was aborted (is the disk full?).');
  await page.waitForFunction(() => document.querySelector('[data-testid="sync"]')?.dataset.state === 'error');
  assert.equal(await text('sync'), 'Firo PWA could not save to this device');
  assert.match(await text('sync-detail'), /Free some space on this device, then open Firo PWA again\./);
  assert.match(await dot(), /\bbad\b/);
  await both('syncwords-02-storage');
  await ff('syncError', null);
  await page.waitForFunction(() => document.querySelector('[data-testid="sync"]')?.dataset.state === 'synced');
});

test('the private side could not start: no private figure, never "Synced", the reason said', async () => {
  await ff('sparkOff', 'WebAssembly is not defined');
  await page.waitForFunction(() => /Private balance not available here/.test(document.querySelector('[data-testid="sync"]')?.textContent || ''));
  assert.match(await dot(), /\bbad\b/);
  assert.equal(await text('sync'), 'Private balance not available here');
  assert.match(await text('sync-detail'), /could not start in this browser \(WebAssembly is not defined\), so private FIRO and Spark names are not shown/);
  assert.equal(await text('balance-private'), '— FIRO');
  assert.equal(await has('sync-choose-node'), 0, 'not a node problem');
  assert.equal(await page.isDisabled(tid('send')), true);
  await both('syncwords-03-spark-off');
  await ff('sparkOff', null);
  await page.waitForFunction(() => document.querySelector('[data-testid="sync"]')?.dataset.state === 'synced');
});

test('one node only: amber "Synced with one Firo node", and a payment in a block waits apart from "arriving"', async () => {
  await ff('noSecond', 3);
  await ff('publicUnproven', '150000000');
  await page.waitForFunction(() => /Synced with one Firo node/.test(document.querySelector('[data-testid="sync"]')?.textContent || ''));
  assert.match(await dot(), /\bwait\b/);
  assert.match(await text('balance-pending'), /\+1\.5 public, in a block, not yet confirmed by a second Firo node/);
  assert.doesNotMatch(await text('balance-pending'), /arriving publicly/);
  assert.equal(await has('sync-choose-node'), 1);
  await both('syncwords-04-one-node');
  await ff('publicUnproven', 0);
  await ff('noSecond', 0);
});

test('a first sync that outlasts the auto-lock: after a while Home says so, and offers to stay unlocked until it is done', async () => {
  await ff('firstSync', 40);
  await page.waitForFunction(() => document.querySelector('[data-testid="sync"]')?.dataset.state === 'syncing');
  assert.equal(await has('first-sync'), 0, 'not at once');
  await page.waitForSelector(tid('first-sync'), { timeout: 30000 });
  assert.match(await text('first-sync'), /^First sync: \d+%\. It downloads Firo's lists of private coins \(about 350 MB\)/);
  await both('syncwords-05-first-sync');
  await page.click(tid('first-sync-awake'));
  await page.waitForSelector(tid('first-sync-awake-stop'));
  assert.match(await text('first-sync'), /stays unlocked until it is done/);
  await both('syncwords-06-first-sync-awake');
  // Done: the note and the keep-awake go.
  await ff('firstSync', null);
  await page.waitForFunction(() => !document.querySelector('[data-testid="first-sync"]'));
  assert.equal(await page.evaluate(async () => (await import('./lib/keep_awake.js')).keepingAwake()), false);
});

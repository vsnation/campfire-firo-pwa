// Ethereum Send's Scan (security audit of 0.1.21, finding 3): a payment link for a token this wallet
// does not know, or one for Ethereum scanned while on BNB Chain, filled in the address and left the
// coin as it was, so ETH or BNB went where a token, or another chain's coin, was asked for. Now
// such a link fills in nothing and says why; an Ethereum link on Ethereum fills in as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { one } from './helpers/fake_dom.mjs';
import { redirect, standIn } from './helpers/redirect.mjs';

const SEND = ['/src/screens/eth_send.js'];
redirect([
  { parents: SEND, spec: '../lib/eth/wallet.js', to: standIn('eth_wallet') },
  { parents: SEND, spec: '../lib/eth/rpc.js', to: standIn('eth_rpc') },
  { parents: SEND, spec: '../lib/eth/send.js', to: standIn('eth_send_lib') },
  { parents: SEND, spec: './eth_review.js', to: standIn('eth_review_sheet') },
  { parents: SEND, spec: './scan_sheet.js', to: standIn('scan_sheet_eth') },
]);
const { plainEthWallet } = await import('./helpers/stand_ins/eth_wallet.mjs');
const { makeApp } = await import('./helpers/stand_ins/app.mjs');
const { scanned } = await import('./helpers/stand_ins/scan_sheet_eth.mjs');
const { default: ethSend } = await import('../../src/screens/eth_send.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TO = `0x${'44'.repeat(20)}`;
const UNKNOWN_TOKEN = `0x${'69'.repeat(20)}`;

async function open(chain) {
  globalThis.__eth = { prepares: 0, signed: [], prepareMs: 0, signMs: 0 };
  globalThis.__ethWallet = plainEthWallet();
  const app = makeApp({ ethSend: (a, p) => ethSend(a, p) });
  app.go('ethSend', { chain });
  await sleep(20);
  return app.current.el;
}
async function scan(el, r) {
  scanned.next = r;
  one('eth-scan-to', el).click();
  await sleep(20);
}

test('a token link for a token this wallet does not have: nothing filled in, and said', async () => {
  const el = await open('ethereum');
  one('eth-send-to', el).value = `0x${'55'.repeat(20)}`; // an address typed before: emptied, not kept ready to pay
  await scan(el, { kind: 'eth', to: TO, token: UNKNOWN_TOKEN, link: true });
  assert.equal(one('eth-send-to', el).value, '');
  assert.match(one('eth-to-hint', el).textContent, /asks for a token this wallet doesn't have/);
});

test('an Ethereum link with an amount, scanned on BNB Chain: nothing filled in, and said', async () => {
  const el = await open('bsc');
  await scan(el, { kind: 'eth', to: TO, valueWei: '1000000000000000000', link: true });
  assert.equal(one('eth-send-to', el).value, '');
  assert.equal(one('eth-send-amount', el).value, '');
  assert.match(one('eth-to-hint', el).textContent, /for Ethereum\. Choose Ethereum at the top/);
});

test('an Ethereum link on Ethereum: address and amount filled in, as before; a plain address on BNB Chain too', async () => {
  const el = await open('ethereum');
  await scan(el, { kind: 'eth', to: TO, valueWei: '1000000000000000000', link: true });
  assert.equal(one('eth-send-to', el).value, TO);
  assert.equal(one('eth-send-amount', el).value, '1');
  const el2 = await open('bsc');
  await scan(el2, { kind: 'eth', to: TO });
  assert.equal(one('eth-send-to', el2).value, TO);
});

test('an "ethereum:" link with no amount, on BNB Chain: refused too (it is for Ethereum)', async () => {
  const el = await open('bsc');
  await scan(el, { kind: 'eth', to: TO, link: true });
  assert.equal(one('eth-send-to', el).value, '');
  assert.match(one('eth-to-hint', el).textContent, /for Ethereum/);
});

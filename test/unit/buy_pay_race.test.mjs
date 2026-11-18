// Outside audit 2026-11-18, #04: "Pay from this wallet" while the periodic status look is on its way
// got the old "waiting for your deposit" and opened Send for a buy already paid elsewhere. Real
// BuyController and screens/buy_order.js on the stand-in DOM; buyfiro.app is FakeBuyFiro (no network).
import test from 'node:test';
import assert from 'node:assert/strict';
const { one } = await import('./helpers/fake_dom.mjs');
const { redirect, standIn } = await import('./helpers/redirect.mjs');
const SCREEN = ['/src/screens/buy_order.js'];
redirect([
  { parents: SCREEN, spec: '../lib/wallet.js', to: standIn('wallet') },
  { parents: SCREEN, spec: '../lib/buy/wiring.js', to: standIn('buy_wiring') },
  { parents: SCREEN, spec: '../lib/eth/record.js', to: standIn('eth_record') },
  { parents: SCREEN, spec: '../lib/eth/wallet.js', to: standIn('eth_wallet') },
]);
const { plainEthWallet } = await import('./helpers/stand_ins/eth_wallet.mjs');
const { makeApp } = await import('./helpers/stand_ins/app.mjs');
const { default: buyOrder } = await import('../../src/screens/buy_order.js');
const { BuyController } = await import('../../src/lib/buy/controller.js');
const { BuyClient } = await import('../../src/lib/buy/buyfiro.js');
const { memoryBuyStore, makeOrder } = await import('../../src/lib/buy/store.js');
const { FakeBuyFiro, FakeClock, FIRO_ADDRESS } = await import('./buy_fakes.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEPOSIT = `0x${'dD'.repeat(20)}`;

async function rig() {
  const server = new FakeBuyFiro();
  server.depositAddress = DEPOSIT;
  let gate = Promise.resolve();
  let open = () => {};
  const hold = () => (gate = new Promise((r) => (open = r)));
  const fetch = async (url, init) => {
    if (String(url).includes('/order/')) await gate;
    return server.fetch(url, init);
  };
  const store = memoryBuyStore();
  await store.save(makeOrder({ depositAddress: DEPOSIT, assetId: 'coin:eth', symbol: 'ETH', chain: 'eth', decimals: 18, sendAmount: '0.5', sendAmountRaw: 500000000000000000n, walletAddress: FIRO_ADDRESS, walletId: 'w1', refundAddress: `0x${'ee'.repeat(20)}`, createdAt: Date.UTC(2026, 9, 9, 11), lastState: 'awaiting_deposit', terminal: false, estimate: 100, deadline: null }));
  const clock = new FakeClock();
  const controller = new BuyController({ client: new BuyClient({ fetch: fetch }), store, clock, autoPoll: false });
  await controller.resumeAll();
  globalThis.__buyController = controller;
  globalThis.__ethWallet = plainEthWallet({ reloadOutbox: async () => [] });
  const app = makeApp({ buyOrder: (a, p) => buyOrder(a, p) });
  app.go('buyOrder', { deposit: DEPOSIT });
  const end = Date.now() + 3000;
  while (Date.now() < end && !one('buy-pay-from-wallet', app.current.el)) await sleep(10);
  assert.ok(one('buy-pay-from-wallet', app.current.el), 'the button is offered');
  return { server, controller, clock, app, hold, open: () => open() };
}

test('control: no poll in flight, order already paid elsewhere -> the button refuses', async () => {
  const r = await rig();
  r.server.state = 'deposit_detected';
  await one('buy-pay-from-wallet', r.app.current.el).click();
  await sleep(50);
    assert.equal(r.app.currentName, 'buyOrder');
  assert.equal(r.app.ethSendDraft, undefined);
  assert.equal(r.controller.order(DEPOSIT).lastState, 'deposit_detected');
});

test('#04: the periodic look on its way: the tap waits for it and asks again, so a buy already paid is not paid twice', async () => {
  const r = await rig();
  r.server.state = 'deposit_detected'; // paid from another wallet; buyfiro.app has seen it
  r.hold();
  r.clock.t += 60000; // the buy's next look is due
  const periodic = r.controller.pollDue(); // its request now waits for the answer
  await sleep(20);
  assert.equal(r.controller._busy.has(DEPOSIT), true, 'the periodic look is on its way');
  const tap = one('buy-pay-from-wallet', r.app.current.el).click();
  await sleep(50);
  assert.equal(r.app.currentName, 'buyOrder', 'nothing opened while the answer is awaited');
  r.open();
  await periodic;
  await tap;
  await sleep(50);
  assert.equal(r.controller.order(DEPOSIT).lastState, 'deposit_detected');
  assert.equal(r.app.currentName, 'buyOrder', 'Send never opened');
  assert.equal(r.app.ethSendDraft, undefined);
  assert.ok(one('buy-pay-not-now', r.app.current.el) || !one('buy-pay-from-wallet', r.app.current.el), 'it says why, or no longer offers to pay');
});

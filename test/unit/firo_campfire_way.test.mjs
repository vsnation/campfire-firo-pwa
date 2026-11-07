// 0.1.20, the Campfire way for the two costly second-node checks (owner's choice; Campfire believes
// its one node): a public payment counts on the node in use's Merkle proof when no second node
// answers, said as such (oneNodeReceipts), and the spent-coins list is not downloaded a second time
// whole on a restore (tagFullCheck off: its count and its end are compared).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBackend } from '../../src/lib/firo/backend.js';
import { createMemoryStore } from '../../src/lib/firo/store.js';
import { buildSignedTransaction } from '../../src/lib/firo/tx.js';
import { addressToScript } from '../../src/lib/firo/address.js';
import { NETWORKS } from '../../src/lib/firo/params.js';
import { hexToBytes, bytesToHex, sha256d, bytesToBase64 } from '../../src/lib/firo/bytes.js';
import { COUNTED, PROVEN } from '../../src/lib/firo/history.js';
import { TransparentWallet, selectCoins } from '../../src/lib/firo/transparent.js';
import { openPaymentsTo, LET_GO_WARN_MS } from '../../src/lib/open_payments.js';
import { FakeNet } from '../fixtures/firo_fake_ws.mjs';
import { FakeChain, fakeCoin, fakeTag, headerHex } from '../fixtures/firo_fake_chain.mjs';
import { FakeSpark } from '../fixtures/firo_fake_spark.mjs';

const MAIN = NETWORKS.main;
const KEYS = JSON.parse(readFileSync(new URL('../fixtures/firo_keys.json', import.meta.url), 'utf8'));
const W = KEYS.vectors[0];
const OTHER = KEYS.vectors[2].addresses[0];
const URL1 = 'wss://fake.example:50004';
const URL2 = 'wss://fake2.example:50004';
const COIN = 100000000n;
const ELECTRUM = { pingIntervalMs: 0, timeoutMs: 2000, backoffInitialMs: 10 };
const CAMPFIRE_WAY = { oneNodeReceipts: true, tagFullCheck: false };

function fund(chain, address, value, height = chain.height - 10) {
  const tx = buildSignedTransaction({
    inputs: [{ txid: bytesToHex(sha256d(Uint8Array.of(chain.txs.size, 3))), vout: 0, value: value + 2000n, script: addressToScript(OTHER.address, MAIN), sk: hexToBytes(OTHER.privkey) }],
    outputs: [{ script: addressToScript(address, MAIN), value }],
    locktime: height - 1,
  });
  return chain.addTx(tx.hex, height);
}

async function nextBlock(chain, chain2, s1, backend) {
  chain.height++;
  chain2.height++;
  s1.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
  await new Promise((r) => setTimeout(r, 20));
  await backend.waitForSync();
}

test('COUNTED: what counts in the balance is the proven verdicts and one node\'s Merkle proof, nothing else', () => {
  assert.deepEqual([...PROVEN].sort(), ['own-node', 'two-servers']);
  assert.deepEqual([...COUNTED].sort(), ['one-node', 'own-node', 'two-servers']);
  for (const v of [undefined, 'unproven', 'failed', 'one-server', 'not-ours']) assert.equal(COUNTED.has(v), false, String(v));
});

test('no second node answers: a real receipt counts as shown by one node, is spendable, and is proven once one answers', async () => {
  const net = new FakeNet();
  const chain = new FakeChain();
  const chain2 = new FakeChain();
  const s1 = net.addServer(URL1, chain.handler());
  const s2 = net.addServer(URL2, chain2.handler(), { refuse: true });
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: ELECTRUM, ...CAMPFIRE_WAY });
  const real = fund(chain, W.addresses[0].address, 2n * COIN, chain.height - 20);
  chain2.addTx(chain.txs.get(real).hex, chain.height - 20);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  const t = backend.transparent;
  assert.equal(t.txs.get(real).proof, 'one-node');
  let s = backend.getState();
  assert.equal(s.balance.public.available, String(2n * COIN), 'counted (owner: the Campfire way)');
  assert.equal(s.balance.public.byOneNode, String(2n * COIN), 'and said as shown by one node');
  assert.equal(s.balance.public.unproven, undefined);
  const tx = s.txs.find((x) => x.txid === real);
  assert.ok(tx.confirmations > 0, 'confirmed on the node\'s proof');
  assert.notEqual(tx.unproven, true);
  assert.equal(t.utxos(backend.tip.height).find((u) => u.txid === real).spendable, true);
  assert.equal(tx.oneNodeProof, true, 'Activity says one node vouches for it (audit of 0.1.20)');
  // A payment of ours still followed: its change needs two nodes, as in 0.1.19 (audit of 0.1.20).
  t.pending.set(real, { hex: '', at: Date.now() });
  assert.equal(t.utxos(backend.tip.height).find((u) => u.txid === real).spendable, false);
  assert.equal(t.balance(backend.tip.height).byOneNode, 0n);
  t.pending.delete(real);
  // A second node answers at the next sync: proven by two, no longer "one node".
  s2.refuse = false;
  await nextBlock(chain, chain2, s1, backend);
  assert.equal(t.txs.get(real).proof, 'two-servers');
  s = backend.getState();
  assert.equal(s.balance.public.available, String(2n * COIN));
  assert.equal(s.balance.public.byOneNode, undefined);
  assert.notEqual(s.txs.find((x) => x.txid === real).oneNodeProof, true);
  await backend.close();
});

test('audit of 0.1.20: counted on one node once, a sync where nobody answers (a timeout) keeps it counted; a node that answers otherwise takes it back', async () => {
  const net = new FakeNet();
  const chain = new FakeChain();
  const real = chain.handler();
  let merkle = 'ok'; // 'ok' | 'silent' (no answer: the client times out) | 'refuses' (an error answer)
  const s1 = net.addServer(URL1, (m, p, sv) => {
    if (m === 'blockchain.transaction.get_merkle' && merkle === 'silent') return FakeNet.NO_ANSWER;
    if (m === 'blockchain.transaction.get_merkle' && merkle === 'refuses') throw Object.assign(new Error('tx not in block'), { code: 2 });
    return real(m, p, sv);
  });
  net.addServer(URL2, new FakeChain().handler(), { refuse: true });
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: ELECTRUM, ...CAMPFIRE_WAY });
  const txid = fund(chain, W.addresses[0].address, 2n * COIN, chain.height - 20);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  const t = backend.transparent;
  assert.equal(t.txs.get(txid).proof, 'one-node');
  const block = async () => {
    chain.height++;
    s1.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
    await new Promise((r) => setTimeout(r, 20));
    await backend.waitForSync();
  };
  merkle = 'silent';
  await block();
  assert.equal(t.txs.get(txid).proof, 'one-node', 'no answer is no contradiction');
  assert.equal(t.utxos(backend.tip.height).find((u) => u.txid === txid).spendable, true);
  assert.equal(backend.getState().balance.public.available, String(2n * COIN));
  merkle = 'refuses';
  await block();
  assert.equal(t.txs.get(txid).proof, 'unproven', 'the node says otherwise now: not counted');
  assert.equal(backend.getState().balance.public.available, '0');
  await backend.close();
});

// A wallet's let-go bookkeeping without the rest: coins by key, and which payments each was spent by.
function letGoWallet(coins, pays) {
  const proto = TransparentWallet.prototype;
  const w = Object.create(proto);
  w.conflicts = new Map(Object.entries(pays).map(([k, txids]) => [k, { pays: txids.map((txid) => ({ txid, at: Date.now() })) }]));
  w.utxos = () => coins;
  w.pending = new Map();
  w.txs = new Map();
  return w;
}
const key = (u) => `${u.txid}:${u.vout}`;
const coinOf = (n, value, extra = {}) => ({ txid: String(n).repeat(64).slice(0, 64), vout: 0, value, spendable: true, frozen: false, script: new Uint8Array(25), ...extra });

test('audit of 0.1.20: a public payment is refused while NO coin of a payment let go of can be spent; one spendable coin of it is enough', () => {
  const a = coinOf(1, COIN, { spendable: false });
  const b = coinOf(2, 2n * COIN);
  const byKey = (list) => new Map(list.map((u) => [key(u), u]));
  // One let-go payment spent a and b: b can be spent, so the next payment conflicts through b.
  let w = letGoWallet([a, b], { [key(a)]: ['p1'], [key(b)]: ['p1'] });
  assert.doesNotThrow(() => w.conflictCoinsReady(byKey([a, b])));
  assert.deepEqual(w.conflictPicks(byKey([a, b])), [b]);
  // Its only coin cannot be spent: refused, and said how long at most, and that private FIRO is fine.
  w = letGoWallet([a], { [key(a)]: ['p1'] });
  // Never "send it privately instead": a private payment does not conflict with the let-go one (round-3 audit).
  assert.throws(() => w.conflictCoinsReady(byKey([a])), (e) => e.code === 'conflict-coin' && /48 hours/.test(e.message) && !/private/i.test(e.message));
  assert.throws(() => w.planSend({ outputs: [{ script: new Uint8Array(25), value: 1000n }], feePerKb: 1000, tipHeight: 100 }), (e) => e.code === 'conflict-coin');
  // Gone from the list (two nodes agree it is spent, N-4): nothing to wait for.
  assert.doesNotThrow(() => w.conflictCoinsReady(new Map()));
});

test('audit of 0.1.20: with two payments let go of, the next payment spends a coin of EACH (the largest took only one)', () => {
  const c1 = coinOf(1, 3n * COIN);
  const c2 = coinOf(2, COIN);
  const other = coinOf(3, 10n * COIN);
  const w = letGoWallet([c1, c2, other], { [key(c1)]: ['p1'], [key(c2)]: ['p2'] });
  const picks = w.conflictPicks(new Map([c1, c2, other].map((u) => [key(u), u])));
  assert.deepEqual(new Set(picks), new Set([c1, c2]));
  const plan = selectCoins({ utxos: [c1, c2, other], outputs: [{ script: new Uint8Array(25), value: COIN / 2n }], feePerKb: 1000n, changeScript: new Uint8Array(25), mustInclude: picks });
  const used = new Set(plan.inputs.map(key));
  assert.ok(used.has(key(c1)) && used.has(key(c2)), 'both let-go payments conflict with this one');
  // A coin both were spent by covers both.
  const w2 = letGoWallet([c1, c2], { [key(c1)]: ['p1', 'p2'], [key(c2)]: ['p2'] });
  assert.deepEqual(w2.conflictPicks(new Map([c1, c2].map((u) => [key(u), u]))), [c1]);
});

test('audit of 0.1.20: a let-go payment\'s coin cannot be frozen', async () => {
  const c = coinOf(4, COIN);
  const w = letGoWallet([c], { [key(c)]: ['p1'] });
  w.frozen = new Set();
  await assert.rejects(w.setFrozen(c.txid, 0, true), (e) => e.code === 'conflict-coin');
  assert.equal(w.frozen.size, 0);
});

test('round-3 audit: a node in use ahead of the real chain, an invented payment in a block no second node has: it waits, never counted', async () => {
  const net = new FakeNet();
  const chain = new FakeChain();
  const honest = new FakeChain();
  net.addServer(URL1, chain.handler());
  net.addServer(URL2, honest.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: ELECTRUM, ...CAMPFIRE_WAY });
  // The node in use claims two blocks more than the honest one, and puts a payment in the first of them.
  chain.height = honest.height + 2;
  const invented = fund(chain, W.addresses[0].address, 5n * COIN, honest.height + 1);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: honest.height - 100 });
  await backend.waitForSync();
  assert.equal(backend.transparent.txs.get(invented).proof, 'unproven');
  assert.equal(backend.getState().balance.public.available, '0');
  assert.equal(backend.getState().balance.public.byOneNode, undefined);
  await backend.close();
});

test('round-3 audit: a lone node claiming to be far ahead does not pull the wallet onto it; one another node backs is moved to', async () => {
  const net = new FakeNet();
  const mine = new FakeChain();
  const liarChain = new FakeChain();
  liarChain.height = mine.height + 50;
  const URL3 = 'wss://fake3.example:50004';
  net.addServer(URL1, mine.handler());
  net.addServer(URL2, liarChain.handler());
  net.addServer(URL3, mine.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }, { url: URL3 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: ELECTRUM, ...CAMPFIRE_WAY });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: mine.height - 10 });
  await backend.waitForSync();
  let moved = null;
  backend._moveOffLagging = (url) => (moved = url);
  // Asked: the liar first, then the honest third node, which is not ahead.
  backend._secondTurn = 0;
  for (let i = 0; i < 3 && backend.serverCheck?.otherHeight !== liarChain.height; i++) {
    await backend._checkTip();
    if (moved) break;
  }
  assert.equal(moved, null, 'not moved on one node\'s word');
  // Now the third node is ahead too: the move happens.
  const ahead = new FakeChain();
  ahead.height = mine.height + 50;
  net.servers.get(URL3).handler = ahead.handler();
  for (let i = 0; i < 4 && !moved; i++) await backend._checkTip();
  assert.ok(moved === URL2 || moved === URL3, `moved once two nodes agree it is behind (${moved})`);
  await backend.close();
});

test('one node: a Merkle branch that does not lead to the header the node gives is never counted (a made-up receipt stays out)', async () => {
  const net = new FakeNet();
  const chain = new FakeChain();
  const real = chain.handler();
  // The node in use answers every Merkle branch with a made-up step: the root never matches.
  const liar = (m, p, sv) => {
    const r = real(m, p, sv);
    return m === 'blockchain.transaction.get_merkle' ? { ...r, merkle: [...r.merkle, 'ab'.repeat(32)] } : r;
  };
  net.addServer(URL1, liar);
  net.addServer(URL2, new FakeChain().handler(), { refuse: true });
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: ELECTRUM, ...CAMPFIRE_WAY });
  const txid = fund(chain, W.addresses[0].address, 2n * COIN, chain.height - 20);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  assert.equal(backend.transparent.txs.get(txid).proof, 'failed');
  const s = backend.getState();
  assert.equal(s.balance.public.available, '0');
  assert.equal(s.balance.public.byOneNode, undefined);
  await backend.close();
});

test('one node: a second node that gives ANOTHER header keeps the receipt out, also later with no other node to ask (FE-8: only silence counts as one node)', async () => {
  const net = new FakeNet();
  const chain = new FakeChain();
  const chain2 = new FakeChain();
  net.addServer(URL1, chain.handler());
  const other = chain2.handler();
  net.addServer(URL2, (m, p, sv) => (m === 'blockchain.block.headers' || m === 'blockchain.block.header' ? (() => { const r = other(m, p, sv); return typeof r === 'string' ? r.replace(/^../, 'ff') : { ...r, hex: String(r.hex).replace(/^../, 'ff') }; })() : other(m, p, sv)));
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: ELECTRUM, ...CAMPFIRE_WAY });
  const txid = fund(chain, W.addresses[0].address, 2n * COIN, chain.height - 20);
  chain2.addTx(chain.txs.get(txid).hex, chain.height - 20);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  const r = backend.transparent.txs.get(txid);
  assert.equal(r.proof, 'unproven');
  assert.deepEqual(r.disagreed, ['wss://fake2.example:50004']);
  assert.equal(backend.getState().balance.public.available, '0');
  // The next syncs: the node that disagreed is avoided, none other answers. Still out.
  for (let i = 0; i < 2; i++) {
    backend._requestSync();
    await backend.waitForSync();
  }
  assert.equal(backend.transparent.txs.get(txid).proof, 'unproven');
  assert.equal(backend.getState().balance.public.available, '0');
  assert.equal(backend.getState().balance.public.byOneNode, undefined);
  await backend.close();
});

test('the engine\'s default stays strict: no second node, the receipt waits unproven (tests of the strict checks keep their meaning)', async () => {
  const net = new FakeNet();
  const chain = new FakeChain();
  net.addServer(URL1, chain.handler());
  net.addServer(URL2, new FakeChain().handler(), { refuse: true });
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: ELECTRUM });
  const txid = fund(chain, W.addresses[0].address, 2n * COIN, chain.height - 20);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  assert.equal(backend.transparent.txs.get(txid).proof, 'unproven');
  assert.equal(backend.getState().balance.public.available, '0');
  await backend.close();
});

function taggedChain(spark) {
  const chain = new FakeChain();
  const a = fakeCoin();
  const b = fakeCoin();
  spark.own(a, { value: 2n * COIN });
  spark.own(b, { value: 3n * COIN });
  chain.addBlock(1, [fakeCoin(), a, b]);
  for (let i = 0; i < 200; i++) chain.tags.push({ tag: fakeTag(900000 + i), txid: bytesToHex(sha256d(Uint8Array.of(i % 256, i >> 8, 7))) });
  chain.tags.push({ tag: fakeTag(a.id), txid: 'ab'.repeat(32) });
  return { chain, a };
}

function twoNodes(handlers, spark, opts = {}) {
  const net = new FakeNet();
  const urls = handlers.map((_, i) => `wss://fake${i + 1}.example:50004`);
  const servers = handlers.map((h, i) => net.addServer(urls[i], h));
  const backend = createBackend({ network: 'main', servers: urls.map((url) => ({ url })), store: createMemoryStore(), spark, WebSocket: net.WebSocket, electrum: ELECTRUM, ...opts });
  return { backend, servers };
}

const tagAsks = (server) => server.calls.filter((c) => c.method === 'spark.getusedcoinstagstxhashes').map((c) => Number(c.params[0]));

test('a restore, the Campfire way: the second node is asked for the end of the spent-coins list only, never the whole list again; the counts agree', async () => {
  const spark = new FakeSpark();
  const { chain } = taggedChain(spark);
  const w = twoNodes([chain.handler(), chain.handler()], spark, CAMPFIRE_WAY);
  await w.backend.open({ mnemonic: W.mnemonic }); // a restore: the node in use sends every tag, from 0
  await w.backend.waitForSync();
  assert.deepEqual(tagAsks(w.servers[0]).slice(0, 1), [0], 'the node in use: the whole list, once');
  const second = tagAsks(w.servers[1]);
  assert.equal(second.length, 1);
  assert.equal(second[0], 201 - 30, 'the second node: only the last 30 (the overlap), not from 0');
  assert.equal(w.backend.tagCheck.state, 'agree');
  assert.equal(w.backend.progress.tagsAgreed.count, 201);
  assert.equal(w.backend.getState().balance.private.available, String(3n * COIN));
  await w.backend.close();
});

test('the Campfire way still catches a node that leaves spent coins out: the counts differ', async () => {
  const spark = new FakeSpark();
  const { chain, a } = taggedChain(spark);
  const ours = bytesToBase64(fakeTag(a.id));
  const real = chain.handler();
  const liar = (m, p, s) => {
    const r = real(m, p, s);
    return m === 'spark.getusedcoinstagstxhashes' ? { tagsandtxids: r.tagsandtxids.filter(([t]) => t !== ours) } : r;
  };
  const w = twoNodes([liar, chain.handler()], spark, CAMPFIRE_WAY);
  await w.backend.open({ mnemonic: W.mnemonic });
  await w.backend.waitForSync();
  assert.equal(w.backend.tagCheck.state, 'disagree');
  assert.deepEqual([w.backend.tagCheck.ours, w.backend.tagCheck.theirs], [200, 201]);
  assert.equal(w.backend.getState().serverCheck.about, 'spent');
  await w.backend.close();
});

test('the strict default still compares the whole list on a restore\'s first check', async () => {
  const spark = new FakeSpark();
  const { chain } = taggedChain(spark);
  const w = twoNodes([chain.handler(), chain.handler()], spark);
  await w.backend.open({ mnemonic: W.mnemonic });
  await w.backend.waitForSync();
  assert.deepEqual(tagAsks(w.servers[1]), [0]);
  assert.equal(w.backend.tagCheck.state, 'agree');
  await w.backend.close();
});

test('round-3 audit: Review says "paid before" for a payment let go of to that address (a private payment cannot conflict with it), for a few days', () => {
  const now = Date.now();
  const to = 'aExchangeAddress1';
  const letGo = { txid: 'a', direction: 'out', counterparty: to, dropped: true, letGo: true, time: Math.floor(now / 1000) - 3600, confirmations: 0 };
  const failed = { txid: 'b', direction: 'out', counterparty: to, dropped: true, time: Math.floor(now / 1000) - 3600, confirmations: 0 };
  assert.deepEqual(openPaymentsTo([letGo, failed], to, now).map((x) => x.txid), ['a'], 'let go of: said; did not go through: not');
  assert.deepEqual(openPaymentsTo([{ ...letGo, time: Math.floor((now - LET_GO_WARN_MS) / 1000) - 60 }], to, now), [], 'long forgotten');
  assert.deepEqual(openPaymentsTo([letGo], 'someoneElse', now), []);
});

test('round-7 audit: a let-go payment whose coin a payment of ours not in a block yet spends: public payments wait for that one', () => {
  const c = coinOf(5, COIN);
  const w = letGoWallet([], { [key(c)]: ['p1'] });
  // P3 (ours, not in a block) spends the let-go coin: it is gone from the coins, and P1 may still be mined instead.
  const p3 = 'cd'.repeat(32);
  w.pending = new Map([[p3, { hex: '' }]]);
  w.txs = new Map([[p3, { decoded: { vin: [{ txid: c.txid, vout: 0 }] }, height: null }]]);
  assert.deepEqual(w.heldLetGo(new Map()), ['p1']);
  assert.throws(() => w.conflictCoinsReady(new Map()), (e) => e.code === 'conflict-coin' && /no second Firo node has confirmed yet/.test(e.message) && /48 hours after you let the earlier one go/.test(e.message));
  // In a block on the node's word alone: still followed, still waited for (round-8 audit).
  w.txs.get(p3).height = 1000;
  assert.throws(() => w.conflictCoinsReady(new Map()), (e) => e.code === 'conflict-coin');
  // Settled (proven by two nodes: no longer followed): P1 can never be mined; nothing to wait for.
  w.pending.delete(p3);
  assert.doesNotThrow(() => w.conflictCoinsReady(new Map()));
});

test('round-7 audit: a public payment for a sell whose let-go payment is back on its way, or in a block, is refused', async () => {
  const net = new FakeNet();
  const chain = new FakeChain();
  net.addServer(URL1, chain.handler());
  net.addServer(URL2, chain.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, electrum: ELECTRUM, ...CAMPFIRE_WAY });
  const p1 = fund(chain, W.addresses[0].address, 3n * COIN, chain.height - 20);
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height - 100 });
  await backend.waitForSync();
  const to = [{ address: KEYS.vectors[2].addresses[0].address, amount: String(COIN / 10n) }];
  // p1 stands in for the let-go payment: in a block, not dropped.
  await assert.rejects(backend.quote({ from: 'public', to, conflictWith: p1 }), (e) => e.code === 'conflict-coin' && /went through after all/.test(e.message));
  // Dropped (let go of) with nothing kept for it: nothing would make the two conflict, refused (round-8 audit).
  backend.transparent.txs.get(p1).dropped = true;
  await assert.rejects(backend.quote({ from: 'public', to, conflictWith: p1 }), (e) => e.code === 'conflict-coin' && /cannot be made from the same coins/.test(e.message));
  // Its coins kept (every payment spends one): this payment may go.
  await backend.transparent.keepConflicts(p1, chain.txs.get(p1).hex);
  await assert.doesNotReject(backend.quote({ from: 'public', to, conflictWith: p1 }).catch((e) => { if (e.code === 'conflict-coin') throw e; }));
  delete backend.transparent.txs.get(p1).dropped;
  await backend.close();
});

test('round-8 audit: a let-go payment\'s fate for a payment that must conflict with it; held until the holding payment is settled; a let-go restarts its coins\' window', async () => {
  const c = coinOf(6, COIN);
  const p1 = 'a1'.repeat(32);
  const w = letGoWallet([], {});
  w.txs = new Map([[p1, { decoded: { vin: [{ txid: c.txid, vout: 0 }] }, dropped: true, height: null }]]);
  assert.equal(w.letGoConflict(p1), 'unknown', 'nothing kept for it: nothing would make the two conflict');
  w.conflicts = new Map([[key(c), { pays: [{ txid: p1, at: Date.now() }] }]]);
  assert.equal(w.letGoConflict(p1), 'kept');
  // Its coin spent by another payment of ours in a block, still followed (one node's word): held.
  const p3 = 'b3'.repeat(32);
  w.txs.set(p3, { decoded: { vin: [{ txid: c.txid, vout: 0 }] }, height: 1000 });
  w.pending = new Map([[p3, { hex: '' }]]);
  assert.equal(w.letGoConflict(p1), 'kept');
  assert.deepEqual(w.heldLetGo(new Map()), [p1]);
  // Settled (no longer followed): p1 can never be mined; nothing held (round-9 audit).
  w.pending.delete(p3);
  assert.equal(w.letGoConflict(p1), 'none');
  assert.deepEqual(w.heldLetGo(new Map()), []);
  w.pending.set(p3, { hex: '' });
  // p1 back on its way: no longer let go of; nothing held for it.
  w.txs.get(p1).dropped = false;
  assert.deepEqual(w.heldLetGo(new Map()), []);
  assert.equal(w.letGoConflict('ff'.repeat(32)), 'unknown');
});

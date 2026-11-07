// What a sync says about itself, and how it recovers (0.1.19, the balance-sync audit): a node too
// slow to answer, the private side that could not start, a wallet's first sync, a refresh of a new
// block, a node that lags behind the others, and payments only one node can vouch for.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBackend, syncErrorKind } from '../../src/lib/firo/backend.js';
import { createMemoryStore } from '../../src/lib/firo/store.js';
import { ElectrumError } from '../../src/lib/firo/electrum.js';
import { buildSignedTransaction } from '../../src/lib/firo/tx.js';
import { addressToScript } from '../../src/lib/firo/address.js';
import { NETWORKS } from '../../src/lib/firo/params.js';
import { hexToBytes, bytesToHex, sha256d } from '../../src/lib/firo/bytes.js';
import { assessSync } from '../../src/lib/sync.js';
import { FakeNet } from '../fixtures/firo_fake_ws.mjs';
import { FakeChain, fakeCoin, headerHex } from '../fixtures/firo_fake_chain.mjs';
import { FakeSpark } from '../fixtures/firo_fake_spark.mjs';

const MAIN = NETWORKS.main;
const KEYS = JSON.parse(readFileSync(new URL('../fixtures/firo_keys.json', import.meta.url), 'utf8'));
const W = KEYS.vectors[0];
const OTHER = KEYS.vectors[2].addresses[0];
const URL1 = 'wss://fake.example:50004';
const URL2 = 'wss://fake2.example:50004';
const COIN = 100000000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting');
    await sleep(10);
  }
};
const electrum = { pingIntervalMs: 0, timeoutMs: 400, backoffInitialMs: 10 };
const line = (b) => {
  const st = b.getState();
  return assessSync({ raw: st, everConnected: true, now: st.tip ? st.tip.time : Date.now() / 1000 });
};

function fund(chain, address, value, height = chain.height - 10) {
  const tx = buildSignedTransaction({
    inputs: [{ txid: bytesToHex(sha256d(Uint8Array.of(chain.txs.size, 7))), vout: 0, value: value + 2000n, script: addressToScript(OTHER.address, MAIN), sk: hexToBytes(OTHER.privkey) }],
    outputs: [{ script: addressToScript(address, MAIN), value }],
    locktime: height - 1,
  });
  return chain.addTx(tx.hex, height);
}

test('what stopped a sync is told apart: a slow node, a lost connection, a refusal, storage, the private part', () => {
  assert.equal(syncErrorKind(new ElectrumError('timeout', 'x')), 'slow');
  assert.equal(syncErrorKind(new ElectrumError('offline', 'x')), 'offline');
  assert.equal(syncErrorKind(new ElectrumError('closed', 'x')), 'offline');
  assert.equal(syncErrorKind(new ElectrumError('server', 'x')), 'server');
  assert.equal(syncErrorKind(new ElectrumError('bad_response', 'x')), 'server');
  assert.equal(syncErrorKind(Object.assign(new Error('quota'), { name: 'QuotaExceededError' })), 'storage');
  assert.equal(syncErrorKind(new Error('Storage write was aborted (is the disk full?).')), 'storage');
  assert.equal(syncErrorKind(new Error('spark.wasm: HTTP 404')), 'spark');
  assert.equal(syncErrorKind(new Error('WebAssembly is not defined')), 'spark');
  assert.equal(syncErrorKind(new Error('something else')), 'other');
});

test('audit F1: a node too slow to answer one request, on a connection that is up: said as slow, asked again, and a new block restarts the sync', async () => {
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  let hang = true;
  const base = chain.handler();
  const server = net.addServer(URL1, (m, p, s) => (hang && m === 'spark.getsparklatestcoinid' ? FakeNet.NO_ANSWER : base(m, p, s)));
  net.addServer(URL2, chain.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, sparkSetChecks: false, electrum });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const st = backend.getState();
  assert.equal(st.connected, true, 'the connection is up');
  assert.equal(st.sync.phase, 'error');
  assert.equal(st.sync.kind, 'slow');
  assert.ok(backend._retry.timer, 'asked again soon (0.1.18: never, until the connection dropped)');
  const v = line(backend);
  assert.equal(v.state, 'slow');
  assert.match(v.detail, /^fake\.example did not answer in time\./);
  assert.doesNotMatch(v.detail, /internet/);
  // The node answers again; a new block on the same connection starts the sync at once.
  hang = false;
  chain.height++;
  server.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
  await until(() => backend.getState().sync.phase === 'done');
  assert.equal(backend.getState().server, URL1, 'on the same node: it was slow, not gone');
  await backend.close();
});

test('audit F2: a browser where the private part could not start: said with the reason, never "Synced"; without a reason, nothing is claimed', async () => {
  const chain = new FakeChain();
  const net = new FakeNet();
  net.addServer(URL1, chain.handler());
  net.addServer(URL2, chain.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: null, sparkOff: 'WebAssembly is not defined', WebSocket: net.WebSocket, electrum });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const st = backend.getState();
  assert.equal(st.sync.phase, 'done');
  assert.equal(st.sparkOff, 'WebAssembly is not defined');
  assert.equal(st.firstSync, undefined, 'no private first sync to wait for');
  const v = line(backend);
  assert.equal(v.state, 'synced');
  assert.equal(v.sparkOff, true);
  assert.equal(v.title, 'Private balance not available here');
  assert.equal(v.canSend, true, 'public FIRO can still be sent; the engine refuses what needs the private part');
  assert.match(v.detail, /\(WebAssembly is not defined\)/);
  await backend.close();
  const plain = createBackend({ network: 'main', servers: [{ url: URL1 }], store: createMemoryStore(), spark: null, WebSocket: net.WebSocket, electrum });
  await plain.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await plain.waitForSync();
  assert.equal(plain.getState().sparkOff, undefined);
  await plain.close();
});

test('audit F3 and F10: the first private sync is flagged until it is done; afterwards a new block is a refresh that stays "Synced"; a new node is a sync again', async () => {
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  const server = net.addServer(URL1, chain.handler());
  const server2 = net.addServer(URL2, chain.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, sparkSetChecks: false, electrum });
  const seen = [];
  backend.subscribe((s) => seen.push({ phase: s.sync.phase, refresh: Boolean(s.sync.refresh), first: Boolean(s.firstSync) }));
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  assert.ok(seen.some((x) => x.phase === 'spark-sets' && x.first), 'flagged during the first private sync');
  const firstDone = seen.findIndex((x) => x.phase === 'done');
  assert.ok(firstDone > 0 && !seen.slice(0, firstDone).some((x) => x.refresh), 'the first sync is no refresh');
  assert.equal(backend.getState().firstSync, undefined, 'not once it is done');
  // One block more: every phase of that sync says refresh, and the line stays "Synced".
  seen.length = 0;
  const lines = [];
  const off = backend.subscribe((s) => lines.push(assessSync({ raw: s, everConnected: true, now: s.tip.time }).state));
  chain.height++;
  server.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
  await sleep(20);
  await backend.waitForSync();
  off();
  const during = seen.filter((x) => x.phase !== 'done');
  assert.ok(during.length > 0, 'a sync ran');
  assert.ok(during.every((x) => x.refresh), 'each of its phases is a refresh');
  assert.ok(lines.every((x) => x === 'synced' || x === 'refreshing'), `"Synced" or "Reading the newest block" throughout, never catching up: ${[...new Set(lines)]}`);
  assert.ok(lines.includes('refreshing'));
  // Four blocks at once (a phone back from sleep): a sync again, said as such.
  seen.length = 0;
  chain.height += 4;
  server.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
  await sleep(20);
  await backend.waitForSync();
  assert.ok(seen.some((x) => x.phase === 'transparent' && !x.refresh), 'more than 3 blocks: not a refresh');
  // Another node: its first sync is no refresh either.
  seen.length = 0;
  await backend.setServers([URL2, URL1]);
  await until(() => backend.getState().server === URL2 && backend.getState().sync.phase === 'done');
  assert.ok(seen.some((x) => x.phase === 'transparent' && !x.refresh), 'on another node: a sync');
  assert.ok(server2.calls.length > 0);
  await backend.close();
});

test('audit F5: a node more than 3 blocks behind another of the list is left for that one, once a third agrees; one that is level is kept', async () => {
  const chain = new FakeChain();
  const ahead = new FakeChain();
  ahead.height = chain.height + 10; // the same blocks (headerHex(height)), ten more
  const URL3 = 'wss://fake3.example:50004';
  const net = new FakeNet();
  net.addServer(URL1, chain.handler());
  const s2 = net.addServer(URL2, ahead.handler());
  const s3 = net.addServer(URL3, ahead.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }, { url: URL3 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, sparkSetChecks: false, electrum });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  await until(() => [URL2, URL3].includes(backend.getState().server) && backend.getState().sync.phase === 'done');
  assert.equal(backend.getState().tip.height, ahead.height, 'reads the chain as far as it goes');
  assert.ok(s2.calls.length + s3.calls.length > 0);
  assert.ok(backend.servers.includes(URL1) && backend.servers.indexOf(URL1) > backend.servers.indexOf(backend.getState().server), 'the lagging one stays in the list, behind');
  await backend.close();

  // Round-3 audit of 0.1.20: the one node ahead alone, no other to back it: not moved to on its own
  // word (a node could pull every wallet onto itself so); said as a disagreement, sending paused.
  const net1 = new FakeNet();
  net1.addServer(URL1, chain.handler());
  net1.addServer(URL2, ahead.handler());
  const b1 = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net1.WebSocket, sparkSetChecks: false, electrum });
  await b1.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await b1.waitForSync();
  await sleep(50);
  assert.equal(b1.getState().server, URL1);
  assert.equal(b1.getState().serverCheck.state, 'disagree');
  await b1.close();

  // Level (or 3 blocks apart): kept.
  const level = new FakeChain();
  level.height = chain.height + 2;
  const net2 = new FakeNet();
  net2.addServer(URL1, chain.handler());
  net2.addServer(URL2, level.handler());
  const b2 = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net2.WebSocket, sparkSetChecks: false, electrum });
  await b2.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await b2.waitForSync();
  await sleep(50);
  assert.equal(b2.getState().server, URL1);
  await b2.close();
});

test('audit F4: with no second node to ask, a public payment in a block is counted apart (unproven), not as "arriving"', async () => {
  const chain = new FakeChain();
  const net = new FakeNet();
  net.addServer(URL1, chain.handler());
  net.addServer(URL2, chain.handler(), { refuse: true });
  const txid = fund(chain, W.addresses[0].address, 2n * COIN);
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, sparkSetChecks: false, electrum });
  await backend.open({ mnemonic: W.mnemonic, birthdayHeight: chain.height });
  await backend.waitForSync();
  const pub = backend.getState().balance.public;
  assert.equal(backend.transparent.txs.get(txid).proof, 'unproven');
  assert.equal(pub.available, '0');
  assert.equal(pub.pending, String(2n * COIN));
  assert.equal(pub.unproven, String(2n * COIN), 'all of it waits for a second node, none of it for a block');
  await backend.close();
});

test('a line too slow for the spent-coins list (the node drops it before the answer arrives): said as such, not asked again for a while, asked at once on another node', async () => {
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin(), fakeCoin()]);
  const net = new FakeNet();
  const base = chain.handler();
  let tagCalls = 0;
  let slowLine = true;
  const server = net.addServer(URL1, (m, p, s) => {
    if (m === 'spark.getusedcoinstagstxhashes' && slowLine) {
      tagCalls++;
      setTimeout(() => s.close(), 120); // as Firo's node does about 50 s into a big answer on a slow line
      return FakeNet.NO_ANSWER;
    }
    return base(m, p, s);
  });
  let tagCalls2 = 0;
  const base2 = chain.handler();
  net.addServer(URL2, (m, p, s) => ((m === 'spark.getusedcoinstagstxhashes' && tagCalls2++), base2(m, p, s)));
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, sparkSetChecks: false, tagsTooSlowMs: 80, electrum: { ...electrum, timeoutMs: 5000 } });
  await backend.open({ mnemonic: W.mnemonic });
  await until(() => backend.getState().sync.kind === 'slow-link');
  const v = line(backend);
  assert.equal(v.state, 'slow');
  assert.equal(v.slowLink, true);
  assert.equal(v.title, 'Connection too slow for the private sync');
  assert.match(v.detail, /Firo's nodes stop sending the list of spent private coins/);
  // It reconnects (to the next node, the client's own failover) and syncs again: the list is not asked for again.
  await sleep(400);
  await backend.waitForSync();
  assert.equal(tagCalls, 1, 'one try per wait');
  assert.equal(tagCalls2, 0, 'not on the node it failed over to either');
  assert.equal(backend.getState().sync.kind, 'slow-link', 'still said');
  // Another node chosen: asked at once, and on a line that carries it, the sync completes.
  slowLine = false;
  await backend.setServers([URL1, URL2]);
  await until(() => backend.getState().sync.phase === 'done');
  assert.equal(backend._tagsTooSlow, null);
  void server;
  await backend.close();
});

test('release audit A0119-1: a Rescan pressed while a sync is still running is never read as a refresh ("Synced" with public 0)', async () => {
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin()]);
  fund(chain, W.addresses[0].address, 5n * COIN, chain.height - 10);
  const net = new FakeNet();
  let holdProof = false;
  let holdList = false;
  let headerCalls = 0;
  const base = chain.handler();
  const server = net.addServer(URL1, (m, p, s) => {
    if (holdProof && m === 'blockchain.block.header') {
      headerCalls++;
      return FakeNet.NO_ANSWER;
    }
    if (holdList && m === 'blockchain.scripthash.listunspent') return FakeNet.NO_ANSWER;
    return base(m, p, s);
  });
  net.addServer(URL2, chain.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, sparkSetChecks: false, electrum: { pingIntervalMs: 0, timeoutMs: 1500, backoffInitialMs: 10 } });
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  // A payment arrives; its proof takes a while, so that sync is still running when Rescan is pressed.
  holdProof = true;
  chain.height++;
  fund(chain, W.addresses[0].address, COIN, chain.height);
  server.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
  await until(() => headerCalls > 0);
  await backend.rescan();
  holdList = true; // the Rescan's public re-read takes a while
  await sleep(1800); // the older sync's proof times out and it finishes meanwhile
  assert.equal(backend._lastFull, null, 'the sync that began before the Rescan does not count as a full one');
  await until(() => backend.getState().sync.phase === 'transparent');
  const st = backend.getState();
  const v = assessSync({ raw: st, everConnected: true, now: st.tip.time });
  assert.equal(v.state, 'syncing', `the Rescan reads as a sync: ${v.state}`);
  assert.equal(v.canSend, false);
  holdList = false;
  holdProof = false;
  await backend.close();
});

test('release audit A0119-4: a line that dies while a refresh asks for the few new spent tags is found by the pings and left', async () => {
  const chain = new FakeChain();
  chain.addBlock(1, [fakeCoin()]);
  const net = new FakeNet();
  let dead = false;
  const base = chain.handler();
  const server = net.addServer(URL1, (m, p, s) => {
    if (m === 'spark.getusedcoinstagstxhashes' && dead === 'armed') dead = true;
    if (dead === true) return FakeNet.NO_ANSWER;
    return base(m, p, s);
  });
  net.addServer(URL2, chain.handler());
  const backend = createBackend({ network: 'main', servers: [{ url: URL1 }, { url: URL2 }], store: createMemoryStore(), spark: new FakeSpark(), WebSocket: net.WebSocket, sparkSetChecks: false, electrum: { pingIntervalMs: 200, timeoutMs: 400, backoffInitialMs: 10 } });
  await backend.open({ mnemonic: W.mnemonic });
  await backend.waitForSync();
  dead = 'armed';
  chain.height++;
  server.notify('blockchain.headers.subscribe', [{ height: chain.height, hex: headerHex(chain.height) }]);
  await until(() => backend.getState().server === URL2 && backend.getState().sync.phase === 'done', 5000);
  await backend.close();
});

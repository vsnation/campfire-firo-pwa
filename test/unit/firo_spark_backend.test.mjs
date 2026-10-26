// The wallet engine (lib/firo/backend.js) with the real Spark library (lib/firo/spark/, sparkmobile
// as WebAssembly) through lib/firo/spark_adapter.js.
//
//   Offline: recovery words → Campfire's Spark key → the same full view key and Spark addresses
//   Campfire's own native library gives (test/fixtures/firo_keys.json); a private payment built by
//   the real library is written down with the coins it spends (release re-audit R1-1).
//   Live (skipped with FIRO_OFFLINE=1): a brand-new mainnet wallet opens over wss, syncs the
//   current Spark group with the real library, and shows 0 FIRO on both sides.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { createSparkClient } from '../../src/lib/firo/spark/client.js';
import { adaptSparkClient } from '../../src/lib/firo/spark_adapter.js';
import { createBackend } from '../../src/lib/firo/backend.js';
import { exchangeAddress } from '../../src/lib/firo/address.js';
import { FiroKeys, generateMnemonic } from '../../src/lib/firo/keys.js';
import { network as getNetwork, sparkSpendTxVersion } from '../../src/lib/firo/params.js';
import { ElectrumClient } from '../../src/lib/firo/electrum.js';
import { createMemoryStore } from '../../src/lib/firo/store.js';
import { bytesToHex, hexToBytes, bytesToBase64, hashToHex, concatBytes, compactSize, sha256 } from '../../src/lib/firo/bytes.js';

const K = JSON.parse(await readFile(new URL('../fixtures/firo_keys.json', import.meta.url), 'utf8'));
const wasmBinary = await readFile(new URL('../../src/vendor/spark/spark.wasm', import.meta.url));
const workerUrl = new URL('../../src/lib/firo/spark/spark_worker.js', import.meta.url);

// A Web Worker look-alike over worker_threads (as firo_spark_client.test.mjs).
const BOOT = `
const { parentPort } = require('node:worker_threads');
const queue = [];
globalThis.self = { postMessage: (m, t) => parentPort.postMessage(m, t), onmessage: null };
parentPort.on('message', (data) => (self.onmessage ? self.onmessage({ data }) : queue.push(data)));
import(${JSON.stringify(workerUrl.href)}).then(() => { for (const d of queue.splice(0)) self.onmessage({ data: d }); });
`;
function nodeWorker(name) {
  const w = new Worker(BOOT, { eval: true, name });
  const h = { onmessage: null, onerror: null, postMessage: (m, t) => w.postMessage(m, t), terminate: () => w.terminate() };
  w.on('message', (data) => h.onmessage && h.onmessage({ data }));
  w.on('error', (e) => h.onerror && h.onerror({ message: e.message }));
  return h;
}

const spark = adaptSparkClient(createSparkClient({ wasmBinary, createWorker: nodeWorker, identifyWorkers: 2 }));
after(() => spark.close());

test('recovery words → the full view key and Spark addresses Campfire\'s own library gives', async () => {
  const withSpark = K.vectors.filter((v) => v.spark && v.network === 'main');
  assert.ok(withSpark.length >= 1);
  for (const v of withSpark) {
    const keys = await FiroKeys.fromMnemonic(v.mnemonic, v.passphrase, getNetwork('main'));
    const keyData = keys.sparkKeyMaterial();
    assert.equal(bytesToHex(keyData), v.spark.keyMaterial);
    assert.equal(bytesToHex(await spark.getFullViewKey({ keyData, index: 1 })), v.spark.fullViewKey);
    for (const [d, addr] of Object.entries(v.spark.addresses)) {
      assert.equal(await spark.getAddress({ keyData, index: 1, diversifier: Number(d), isTestNet: false }), addr, `diversifier ${d}`);
      assert.equal(await spark.getAddressFromFullViewKey({ fullViewKey: hexToBytes(v.spark.fullViewKey), index: 1, diversifier: Number(d), isTestNet: false }), addr);
      assert.equal(await spark.isValidSparkAddress({ address: addr, isTestNet: false }), true);
    }
  }
});

test('identifyCoins keeps one answer per coin, in order, null where the coin is not ours', async () => {
  const v = K.vectors.find((x) => x.spark && x.network === 'main');
  const keyData = (await FiroKeys.fromMnemonic(v.mnemonic, v.passphrase, getNetwork('main'))).sparkKeyMaterial();
  const junk = [{ coin: new Uint8Array(244), context: new Uint8Array(0) }, { coin: new Uint8Array(244).fill(7), context: new Uint8Array(0) }];
  const res = await spark.identifyCoins({ keyData, index: 1, isTestNet: false, coins: junk });
  assert.deepEqual(res, [null, null]);
});

// Release re-audit R1-1: _recordPayment marked the coins a private payment spends by comparing the
// library's usedCoins with the wallet's coin bytes. The real library hands its used coin back
// serialized anew (a 310-byte coin comes back as 244 bytes; mainnet coins also carry firod's tx hash
// and context after the coin), so nothing matched: the payment log said it spent no coin, and no coin
// was pending-spent before the broadcast. The golden spend vectors (throwaway keys), both shapes.
const V = JSON.parse(await readFile(new URL('../fixtures/firo_spark_vectors.json', import.meta.url), 'utf8'));

test('audit R1-1: a private payment built by the real library is written down with the coins it spends, found by linking tag', { timeout: 120000 }, async () => {
  const s = V.spends.find((x) => x.rngLabel === 'spend-v2-one-input');
  const k = V.keys.find((x) => x.name === s.key);
  const keyData = hexToBytes(k.privateKey);
  const MAIN = getNetwork('main');
  const OTHER = K.vectors[2].addresses[0].address;
  const suffix = (c, i) => concatBytes(sha256(Uint8Array.of(i)), compactSize(c.context.length), c.context);
  for (const shape of ['body', 'mainnet']) {
    const backend = createBackend({ network: 'main', store: createMemoryStore(), spark, servers: [{ url: 'wss://unused.example:50004' }] });
    backend._sparkKey = keyData;
    backend.progress = { groups: {}, tagsUpTo: 0, firstGroup: 1 };
    backend.tip = { height: MAIN.sparkChaumV2StartBlock + 1000, time: null };
    // The wallet's coins, as the engine holds them: bytes as the server sent them (mainnet: with the suffix).
    const vectorCoins = s.coins.map((c, i) => {
      const body = hexToBytes(c.coin);
      const context = hexToBytes(c.context);
      return { body, context, coin: shape === 'mainnet' ? concatBytes(body, suffix({ context }, i)) : body, groupId: c.groupId, height: c.height, index: i };
    });
    const found = await spark.identifyCoins({ keyData, index: 1, isTestNet: false, coins: vectorCoins.map((c) => ({ coin: c.coin, context: c.context })) });
    assert.ok(found.every(Boolean), `${shape}: both vector coins are the key's own`);
    // Received and proven (P4: a coin no second node has confirmed is not spent).
    vectorCoins.forEach((c, i) => backend.ownCoins.set(found[i].lTagHash, { lTagHash: found[i].lTagHash, proof: 'two-servers', groupId: c.groupId, index: c.index, txid: '11'.repeat(32), value: found[i].value, memo: '', diversifier: found[i].diversifier, isChange: false, coin: c.coin, context: c.context, height: c.height, heightApprox: false, time: 1, mempool: false }));
    // The checked set (D-09 is not under test here): the vector's set, own coins in the same shape.
    const ownBodies = new Map(vectorCoins.map((c) => [bytesToHex(c.body), c.coin]));
    const set = s.anonymitySets[0];
    const raw = hexToBytes(s.blockHashes[0].blockHash);
    backend._checkedSets = async (groups) =>
      groups.map((g) => ({
        groupId: g,
        setHash: bytesToBase64(hexToBytes(set.setHash)),
        blockHash: bytesToBase64(raw),
        blockHashHex: hashToHex(raw),
        // Stored oldest first; _buildSparkSpend hands the library the server's order (newest first).
        coins: set.coins.map((x) => ({ coin: ownBodies.get(x) ?? hexToBytes(x), txHash: new Uint8Array(32) })).reverse(),
      }));
    const coins = [...backend.ownCoins.values()];
    const own = coins.map((c) => ({ coin: c.coin, context: c.context, groupId: c.groupId, height: c.height }));
    const v = sparkSpendTxVersion(MAIN, backend.tip.height + 1);
    const built = await backend._buildSparkSpend({ recips: [{ kind: 'transparent', address: OTHER, amount: 20000000n }], tip: backend.tip.height, v, own, coins });
    assert.equal(built.usedCoins.length, 1, `${shape}: the library spends one coin`);
    assert.equal(
      coins.some((c) => bytesToHex(c.coin) === bytesToHex(built.usedCoins[0].coin)),
      false,
      `${shape}: the used coin comes back serialized anew, not as the bytes the wallet holds (why bytes never matched)`,
    );
    await backend._recordPayment(built, {});
    const logged = backend.sends.get(built.txid);
    assert.equal(logged.coins.length, built.usedCoins.length, `${shape}: the payment log lists the coin it spends`);
    const big = coins.find((c) => c.value === 100000000n);
    assert.deepEqual(logged.coins, [big.lTagHash], `${shape}: the 1 FIRO coin, the one the library picked`);
    assert.deepEqual(
      coins.map((c) => [c.value, c.pendingSpentTxid ?? null]),
      coins.map((c) => [c.value, c === big ? built.txid : null]),
      `${shape}: that coin is pending-spent before anything is broadcast; the other stays free`,
    );
    assert.equal(backend.getState().balance.private.available, '12345', `${shape}: the balance drops at once`);
    assert.deepEqual((await backend.store.get('s/sends'))[built.txid].coins, [big.lTagHash], `${shape}: and so it is on disk`);
  }
});

// My addresses (owner, 2026-10-26): whoseAddress reads a Spark address's diversifier with the view key and
// makes the address again, so any of the wallet's is found, also one handed out by another wallet of the
// same words; a full wallet and a view-only one agree; another wallet's address is never taken.
test('whoseAddress finds any Spark address of the wallet by its diversifier, never another wallet\'s; myAddresses lists them', async () => {
  const [v, w] = K.vectors.filter((x) => x.spark && x.network === 'main').concat(K.vectors.filter((x) => x.network === 'main' && !x.spark)).slice(0, 2);
  const keyData = (await FiroKeys.fromMnemonic(v.mnemonic, v.passphrase, getNetwork('main'))).sparkKeyMaterial();
  const otherKey = (await FiroKeys.fromMnemonic(w.mnemonic, w.passphrase, getNetwork('main'))).sparkKeyMaterial();
  const full = createBackend({ network: 'main', store: createMemoryStore(), spark, servers: [{ url: 'wss://unused.example:50004' }] });
  full._sparkKey = keyData;
  full.sparkAddr = { diversifier: 3 };
  const viewOnly = createBackend({ network: 'main', store: createMemoryStore(), spark, servers: [{ url: 'wss://unused.example:50004' }] });
  viewOnly._fvk = await spark.getFullViewKey({ keyData, index: 1 });
  viewOnly.sparkAddr = { diversifier: 1 };
  const addr = (k, d) => spark.getAddress({ keyData: k, index: 1, diversifier: d, isTestNet: false });
  for (const b of [full, viewOnly]) {
    for (const d of [1, 2, 3, 40, 5000, 123456789]) assert.deepEqual(await b.whoseAddress(await addr(keyData, d)), { kind: 'spark', mine: true, diversifier: d }, `d=${d}`);
    assert.deepEqual(await b.whoseAddress((await addr(keyData, 7)).toUpperCase()), { kind: 'spark', mine: true, diversifier: 7 }, 'typed in capitals');
    assert.deepEqual(await b.whoseAddress(await addr(keyData, 9999)), { kind: 'spark', mine: true, diversifier: 9999, change: true });
    for (const d of [1, 2, 3, 40]) assert.deepEqual(await b.whoseAddress(await addr(otherKey, d)), { kind: 'spark', mine: false }, `another wallet's d=${d}`);
    assert.deepEqual(await b.whoseAddress('@satoshi'), { kind: 'spark-name', mine: false });
    assert.deepEqual(await b.whoseAddress('not an address!'), { kind: 'invalid', mine: false });
  }
  // Handed out here: 1 to 3; a payment that arrived at 40 (handed out elsewhere) lists 40 too, with what it holds.
  full.ownCoins.set('aa', { lTagHash: 'aa', txid: '11'.repeat(32), value: 70000000n, diversifier: 40, isChange: false, mempool: false });
  full.ownCoins.set('bb', { lTagHash: 'bb', txid: '22'.repeat(32), value: 5000n, diversifier: 9999, isChange: true, mempool: false });
  full.ownCoins.set('cc', { lTagHash: 'cc', txid: '33'.repeat(32), value: 30000000n, diversifier: 2, isChange: false, mempool: false, spentTxid: '44'.repeat(32) });
  const book = await full.myAddresses();
  assert.deepEqual(book.spark.map((a) => [a.diversifier, a.current, a.payments, a.holds]), [[1, false, 0, '0'], [2, false, 1, '0'], [3, true, 0, '0'], [40, false, 1, '70000000']]);
  assert.equal(book.spark[3].address, await addr(keyData, 40));
  assert.deepEqual(book.transparent, [], 'no public side opened in this test');
});

// Audit of 0.1.15: L1 the view key derived for whoseAddress never outlives a Lock; L2 nothing is said
// when the wallet cannot tell; L3 a coin being spent is not counted as held.
test('whoseAddress: a Lock while the view key is made wipes it; no Spark or public side, or an EX address: cannot tell; held leaves out coins being spent', async () => {
  const v = K.vectors.find((x) => x.spark && x.network === 'main');
  const keyData = (await FiroKeys.fromMnemonic(v.mnemonic, v.passphrase, getNetwork('main'))).sparkKeyMaterial();
  const b = createBackend({ network: 'main', store: createMemoryStore(), spark, servers: [{ url: 'wss://unused.example:50004' }] });
  b._sparkKey = keyData;
  const p = b._viewKey();
  b._sparkKey = null; // the Lock (close -> _reset) while the library works
  await assert.rejects(p, (e) => e.code === 'not-open');
  assert.equal(b._ownFvk, null, 'nothing kept in the locked engine');
  // No Spark side: a Spark address cannot be checked. No public side: nor a public one. EX: never followed.
  const none = createBackend({ network: 'main', store: createMemoryStore(), servers: [{ url: 'wss://unused.example:50004' }] });
  const someSpark = await spark.getAddress({ keyData, index: 1, diversifier: 1, isTestNet: false });
  assert.deepEqual(await none.whoseAddress(someSpark), { kind: 'spark', mine: false, unknown: true });
  assert.deepEqual(await none.whoseAddress(K.vectors[0].addresses[0].address), { kind: 'transparent', mine: false, unknown: true });
  const ex = exchangeAddress(new Uint8Array(20).fill(7), getNetwork('main'));
  assert.deepEqual(await none.whoseAddress(ex), { kind: 'exchange', mine: false, unknown: true });
  b._sparkKey = keyData;
  b.sparkAddr = { diversifier: 1 };
  b.ownCoins.set('aa', { lTagHash: 'aa', txid: '11'.repeat(32), value: 70000000n, diversifier: 1, isChange: false, mempool: false });
  b.ownCoins.set('bb', { lTagHash: 'bb', txid: '22'.repeat(32), value: 30000000n, diversifier: 1, isChange: false, mempool: false, pendingSpentTxid: '33'.repeat(32) });
  assert.deepEqual((await b.myAddresses()).spark.map((a) => [a.diversifier, a.payments, a.holds]), [[1, 2, '70000000']], 'as the balance: the coin being spent is not held');
});

test('live: a new mainnet wallet syncs the current Spark group with the real library',{ skip: process.env.FIRO_OFFLINE === '1', timeout: 300000 }, async () => {
  const backend = createBackend({ network: 'main', store: createMemoryStore(), spark, WebSocket: globalThis.WebSocket });
  const mnemonic = generateMnemonic(24);
  // A new wallet: its birthday is the current tip, so only the current group and new tags are fetched.
  const probe = new ElectrumClient({ servers: [...getNetwork('main').servers], WebSocket: globalThis.WebSocket });
  const tip = await probe.subscribeHeaders();
  probe.close();
  const t0 = Date.now();
  await backend.open({ mnemonic, birthdayHeight: tip.height });
  const done = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sync did not finish: ${JSON.stringify(backend.getState().sync)}`)), 280000);
    const check = (s) => {
      if (s.sync.phase === 'done') { clearTimeout(timer); resolve(s); }
      if (s.sync.phase === 'error') { clearTimeout(timer); reject(new Error(s.sync.error)); }
    };
    backend.subscribe(check);
    check(backend.getState());
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`# synced in ${secs} s at height ${done.tip?.height}`);
  assert.match(done.receive.spark, /^sm1[0-9a-z]{100,}$/);
  assert.match(done.receive.transparent, /^a[1-9A-HJ-NP-Za-km-z]{33}$/);
  assert.deepEqual(done.balance, { private: { available: '0', pending: '0' }, public: { available: '0', pending: '0' } });
  const keyData = (await FiroKeys.fromMnemonic(mnemonic, '', getNetwork('main'))).sparkKeyMaterial();
  // Campfire's first receive address is diversifier 1 (spark_interface.dart generateNextSparkAddress).
  const expected = await spark.getAddress({ keyData, index: 1, diversifier: 1, isTestNet: false });
  assert.equal(done.receive.spark, expected, 'the receive address is diversifier 1 of the wallet\'s own key');
  await backend.close();
});

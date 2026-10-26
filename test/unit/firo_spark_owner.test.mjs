// Which of this wallet's Spark addresses an address is (lib/firo/spark_owner.js): the diversifier
// read back with the view key, for every diversifier the library makes addresses for, on both
// networks; another wallet's address and a damaged one give nothing that passes the check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import createSparkModule from '../../src/vendor/spark/spark.js';
import { loadSparkCore } from '../../src/lib/firo/spark/core.js';
import { hexToBytes } from '../../src/lib/firo/spark/codec.js';
import { claimedDiversifier } from '../../src/lib/firo/spark_owner.js';
import { network as getNetwork } from '../../src/lib/firo/params.js';

const V = JSON.parse(await readFile(new URL('../fixtures/firo_spark_vectors.json', import.meta.url), 'utf8'));
const core = await loadSparkCore({ createModule: createSparkModule, wasmBinary: await readFile(new URL('../../src/vendor/spark/spark.wasm', import.meta.url)) });
const keys = V.keys.slice(0, 2).map((k) => hexToBytes(k.privateKey ?? k.key ?? k.keyData));
const fvkOf = (k) => hexToBytes(core.getFullViewKey({ privateKey: k, index: 1 }));
const DIVERSIFIERS = [0, 1, 2, 3, 17, 255, 256, 9999, 65536, 1234567, 2 ** 32 + 5, Number.MAX_SAFE_INTEGER];

for (const [name, isTestNet] of [['mainnet', false], ['testnet', true]]) {
  const net = getNetwork(isTestNet ? 'test' : 'main');
  test(`${name}: every address of the wallet gives its own diversifier`, async () => {
    for (const k of keys) {
      const fvk = fvkOf(k);
      for (const d of DIVERSIFIERS) {
        const a = core.getAddress({ privateKey: k, index: 1, diversifier: d, isTestNet });
        assert.equal(await claimedDiversifier(a, fvk, net), d, `d=${d}`);
        assert.equal(await claimedDiversifier(a.toUpperCase(), fvk, net), d, 'upper case as well');
      }
    }
  });
}

test("another wallet's address, the other network's, and a damaged one never pass the check", async () => {
  const net = getNetwork('main');
  const [mine, other] = keys.map(fvkOf);
  let passed = 0;
  for (const d of [1, 2, 3, 9999, 70000]) {
    const theirs = core.getAddress({ privateKey: keys[1], index: 1, diversifier: d, isTestNet: false });
    const c = await claimedDiversifier(theirs, mine, net);
    // Whatever it decrypts to (usually nothing: the padding fails), the address for it is not theirs.
    if (c !== null && core.getAddressFromFullViewKey({ fullViewKey: mine, diversifier: c, isTestNet: false }) === theirs) passed++;
    assert.equal(await claimedDiversifier(theirs, other, net), d, 'their own key reads it');
    const test = core.getAddress({ privateKey: keys[0], index: 1, diversifier: d, isTestNet: true });
    assert.equal(await claimedDiversifier(test, mine, net), null, 'a testnet address on mainnet');
  }
  assert.equal(passed, 0);
  for (const bad of ['', 'sm1qqq', 'aGyqaN1jN5tWuXEWM6chbJJFqp9YHtHcGh', null, 42]) assert.equal(await claimedDiversifier(bad, mine, net), null);
  const a = core.getAddress({ privateKey: keys[0], index: 1, diversifier: 4, isTestNet: false });
  const flipped = a.slice(0, 20) + (a[20] === 'q' ? 'p' : 'q') + a.slice(21);
  assert.equal(await claimedDiversifier(flipped, mine, net), null, 'a typo breaks the checksum');
});

test("the native build's addresses (test vectors) give their diversifiers under their full view keys", async () => {
  let n = 0;
  for (const k of V.keys) {
    for (const a of k.addresses) {
      assert.equal(await claimedDiversifier(a.main, hexToBytes(k.fullViewKey), getNetwork('main')), a.diversifier, `${k.name} d=${a.diversifier}`);
      assert.equal(await claimedDiversifier(a.test, hexToBytes(k.fullViewKey), getNetwork('test')), a.diversifier);
      n++;
    }
  }
  assert.ok(n >= 25);
});

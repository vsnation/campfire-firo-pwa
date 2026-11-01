// A wallet's balance computed the way Campfire does it (spark_interface.dart refreshSparkData;
// public: listunspent per address), sharing no logic with the PWA engine: every coin of every set
// 1..latest identified with the full view key, a coin counted unless its linking tag hash is among
// the used tags. Public: every receive/change address up to 40 past the last one with any history.
// Cross-check of the engine (2026-11-01: on the test wallet both gave private 1.21960089, public
// 0.77997341). Nothing is sent.
//   node test/live/campfire_way.mjs env:FIROTEST_SEED       (words from test_wallets.env, never printed)
//   node test/live/campfire_way.mjs fvk:<hex> [xpub:<xpub>]  (a view-only key)
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
const R = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const [who, who2] = process.argv.slice(2);
const im = (p) => import(`${R}/src/${p}`);
const { ElectrumClient } = await im('lib/firo/electrum.js');
const { FiroKeys } = await im('lib/firo/keys.js');
const { network } = await im('lib/firo/params.js');
const { lTagHash } = await im('lib/firo/tx.js');
const { base64ToBytes, bytesToHex, hexToBytes } = await im('lib/firo/bytes.js');
const { default: createSparkModule } = await im('vendor/spark/spark.js');
const { loadSparkCore } = await im('lib/firo/spark/core.js');
const core = await loadSparkCore({ createModule: createSparkModule, wasmBinary: await readFile(`${R}/src/vendor/spark/spark.wasm`) });
const net = network('main');
let fvk, keys = null;
if (who.startsWith('env:')) {
  const env = await readFile(`${homedir()}/.config/campfire-firo/test_wallets.env`, 'utf8');
  const words = new RegExp(`^${who.slice(4)}="([a-z ]+)"`, 'm').exec(env)?.[1];
  if (!words) throw new Error('no words');
  keys = await FiroKeys.fromMnemonic(words, '', net);
  fvk = hexToBytes(core.getFullViewKey({ privateKey: keys.sparkKeyMaterial(), index: 1 }));
} else {
  fvk = hexToBytes(who.slice(4));
  if (who2?.startsWith('xpub:')) keys = FiroKeys.fromXpub(who2.slice(5), net);
}
const fmt = (v) => `${v / 100000000n}.${String(v % 100000000n).padStart(8, '0')}`;
const c = new ElectrumClient({ servers: [...net.servers], WebSocket: globalThis.WebSocket });
await c.connect();
const tip = (await c.subscribeHeaders()).height;
const latest = await c.sparkLatestCoinId();
const mine = new Map(); // lTagHash -> {value, group, diversifier, memo}
let scanned = 0;
for (let g = 1; g <= latest; g++) {
  const meta = await c.sparkSetMeta(g);
  for (let start = 0; start < meta.size; start += 5000) {
    const part = await c.sparkSetSector(g, meta.blockHash, start, Math.min(meta.size, start + 5000));
    const coins = part.map(([coin, , context]) => ({ coin: base64ToBytes(coin), context: base64ToBytes(context) }));
    const { found } = core.identifyCoins({ fullViewKey: fvk, coins });
    for (const f of found) if (!mine.has(f.lTagHash)) mine.set(f.lTagHash, { value: BigInt(f.value), group: g, diversifier: Number(f.diversifier), memo: f.memo, txid: bytesToHex(base64ToBytes(part[f.index][1]).reverse()) });
    scanned += coins.length;
  }
}
const used = new Set((await c.sparkUsedTags(0)).map(([tag]) => lTagHash(base64ToBytes(tag))));
let priv = 0n;
const rows = [];
for (const [h, m] of mine) {
  const spent = used.has(h);
  if (!spent) priv += m.value;
  rows.push(`  ${spent ? 'spent ' : 'UNSPENT'} ${fmt(m.value).padStart(14)} set ${m.group} address ${m.diversifier} tx ${m.txid.slice(0, 12)}…`);
}
let pub = 0n, pubCoins = 0;
if (keys) {
  for (const chain of [0, 1]) {
    let lastUsed = -1;
    for (let i = 0; i <= lastUsed + 40; i++) {
      const e = keys.address(chain, i);
      const [hist, utxo] = await Promise.all([c.getHistory(e.scripthash), c.listUnspent(e.scripthash)]);
      if (hist.length) lastUsed = i;
      for (const u of utxo) { pub += BigInt(u.value); pubCoins++; }
    }
  }
}
console.log(`block ${tip}; ${latest} sets, ${scanned} coins read, ${used.size} used tags`);
console.log(`Campfire way: private ${fmt(priv)} (${mine.size} coins found, ${rows.filter((r) => r.includes('UNSPENT')).length} unspent), public ${keys ? fmt(pub) + ` (${pubCoins} coins)` : 'n/a'}`);
for (const r of rows) console.log(r);
c.close();
process.exit(0);

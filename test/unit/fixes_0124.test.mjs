// 0.1.24: what the outside security audit of 2026-11-18 left for later, fixed.
//   #3  an own node's approval is sealed under the wallet's secret (lib/trust.js): stored
//       preferences alone cannot make a wallet send its addresses to a node;
//   (0.1.22 open item) another wallet's choice of Firo's public nodes no longer moves a wallet off
//       the own node its password approved.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approve, checkTrust, setApproved, approvedFor } from '../../src/lib/trust.js';
import { saveRecord, loadPrefs, savePrefs, listWallets } from '../../src/lib/wallets.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..', 'src');
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const NODE = 'mine.example:50004';
const EVIL = 'node.attacker.test:50004';

function memKv(init = {}) {
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const m = new Map(Object.entries(init).map(([k, v]) => [k, clone(v)]));
  return {
    m,
    get: async (k) => clone(m.get(k)),
    set: async (k, v) => void m.set(k, clone(v)),
    del: async (k) => void m.delete(k),
    keys: async (p) => [...m.keys()].filter((k) => k.startsWith(p)).sort(),
    batch: async (ops) => {
      for (const [op, k, v] of ops) if (op === 'del') m.delete(k);
      else m.set(k, clone(v));
    },
    update: async (k, fn) => {
      const v = fn(clone(m.get(k)));
      m.set(k, clone(v));
      return v;
    },
  };
}
const rec = (id, slot0) => ({ id, slot0, name: id.slice(0, 1), createdAt: 1, envelopes: { password: { v: 1 } } });

async function twoWallets() {
  const kv = memKv({ prefs: {} });
  await saveRecord(rec(A, true), kv);
  await saveRecord(rec(B, false), kv);
  const list = await listWallets(kv);
  return { kv, a: list.find((r) => r.id === A), b: list.find((r) => r.id === B) };
}

test('#3: an approval made under a wallet\'s secret checks out only for that secret, wallet and address', async () => {
  const sealed = await approve('secret-a', A, {}, 'firo', NODE);
  assert.equal(sealed.firo, NODE);
  assert.match(sealed.mac.firo, /^[0-9a-f]{64}$/);
  assert.deepEqual(await checkTrust('secret-a', A, sealed), { firo: NODE, ethereum: null, bsc: null, unsealed: [] });
  assert.equal((await checkTrust('secret-b', A, sealed)).firo, null, 'another secret');
  assert.equal((await checkTrust('secret-a', B, sealed)).firo, null, 'another wallet');
  assert.equal((await checkTrust('secret-a', A, { ...sealed, firo: EVIL })).firo, null, 'the address changed in storage');
  assert.equal((await checkTrust('secret-a', A, { ...sealed, ethereum: 'https://rpc.attacker.test', mac: { ...sealed.mac, ethereum: sealed.mac.firo } })).ethereum, null, 'a seal moved to another kind');
  assert.equal((await checkTrust(null, A, sealed)).firo, null, 'nothing is approved while locked');
  // Dropped: no address, no seal; the others kept.
  const both = await approve('secret-a', A, sealed, 'bsc', 'https://bsc.mine.example');
  const dropped = await approve('secret-a', A, both, 'firo', null);
  assert.deepEqual(await checkTrust('secret-a', A, dropped), { firo: null, ethereum: null, bsc: 'https://bsc.mine.example', unsealed: [] });
});

test('#3: preferences written in storage (node and a forged approval) never make a wallet use that node; one saved unsealed is asked about first', async () => {
  const { kv, a } = await twoWallets();
  // Someone with this browser's data sets the node and an approval of their own.
  await kv.set('prefs', { server: EVIL, trusted: { firo: EVIL, mac: { firo: 'ab'.repeat(32) } } });
  setApproved(null);
  assert.equal((await loadPrefs(a, kv)).server, 'firo', 'locked: no own node at all');
  const checked = await checkTrust('secret-a', A, (await loadPrefs(a, kv)).trusted);
  assert.equal(checked.firo, null);
  assert.deepEqual(checked.unsealed, [], 'a seal that does not match is not offered either');
  setApproved(A, checked);
  const p = await loadPrefs(a, kv);
  assert.equal(p.server, 'firo', "Firo's public nodes");
  assert.equal(p.untrustedServer, EVIL, 'and the nodes screen says what was set');
  // Without a seal (as before 0.1.24): not used; the unlock asks before anything connects.
  await kv.set('prefs', { server: EVIL, trusted: { firo: EVIL } });
  const unsealed = await checkTrust('secret-a', A, (await loadPrefs(a, kv)).trusted);
  assert.deepEqual(unsealed.unsealed, ['firo']);
  setApproved(A, unsealed);
  assert.equal((await loadPrefs(a, kv)).server, 'firo');
  const app = readFileSync(join(SRC, 'app.js'), 'utf8');
  assert.match(app, /const ask = await this\.checkApprovals\(\);[\s\S]*?this\.go\('ownNodeConfirm', ask[\s\S]*?return false;\s*\}[\s\S]*?await startOpenWallet\(this\)/, 'asked before the engine starts');
  // Asked only about one this device uses now; a leftover one is dropped (release audit of 0.1.24).
  assert.match(app, /const kinds = notChecked\.filter\(inUse\);/);
  assert.match(app, /const leftOver = failed \? \[\] : notChecked\.filter\(\(k\) => !inUse\(k\)\);/, 'nothing dropped when the check could not run');
  assert.match(app, /\n    this\.prefs = await loadPrefs\(this\.record\);\n    const kinds/, 'prefs reloaded whether or not the save went through');
  setApproved(null);
});

test('0.1.22 open item: another wallet choosing Firo\'s public nodes does not move a wallet off the own node its password approved', async () => {
  const { kv, a, b } = await twoWallets();
  // A approves its own node.
  setApproved(A, await checkTrust('secret-a', A, await approve('secret-a', A, {}, 'firo', NODE)));
  await savePrefs(a, { server: NODE, trusted: await approve('secret-a', A, {}, 'firo', NODE) }, kv);
  setApproved(null);
  // B, open with its own password, goes back to Firo's public nodes: the device's choice.
  setApproved(B, await checkTrust('secret-b', B, (await loadPrefs(b, kv)).trusted));
  await savePrefs(b, { server: 'firo' }, kv);
  assert.equal((await loadPrefs(b, kv)).server, 'firo');
  setApproved(null);
  // A opens again: its own node, not Firo's public ones.
  setApproved(A, await checkTrust('secret-a', A, (await loadPrefs(a, kv)).trusted));
  assert.equal((await loadPrefs(a, kv)).server, NODE);
  assert.equal(approvedFor(a).firo, NODE);
  assert.equal(approvedFor(b).firo, undefined, 'only the open wallet');
  setApproved(null);
  // The device is set back to it after the unlock (lib/servers.js applyOwnEndpoints), with a reopen when this page's policy lacks it.
  const servers = readFileSync(join(SRC, 'lib', 'servers.js'), 'utf8');
  assert.match(servers, /export async function applyOwnEndpoints\(app\)/);
  assert.match(readFileSync(join(SRC, 'app.js'), 'utf8'), /if \(BUILT && \(await applyOwnEndpoints\(this\)\)\) return 'reopen';/);
});

test('#3: leaving the own node from the wallet that approved it drops its approval, so it is not set again at the next unlock', () => {
  const servers = readFileSync(join(SRC, 'lib', 'servers.js'), 'utf8');
  for (const fn of ['useFiroServers', 'usePublicNode', 'useListedEvmServer']) {
    const body = new RegExp(`export async function ${fn}\\([\\s\\S]*?\\n}`).exec(servers)[0];
    assert.match(body, /approveHere\(app, (?:'firo'|chain), null\)/, fn);
  }
  for (const fn of ['useOwnServer', 'useOwnEvmServer']) {
    const body = new RegExp(`export async function ${fn}\\([\\s\\S]*?\\n}`).exec(servers)[0];
    assert.match(body, /trusted: await approveHere\(app, (?:'firo'|chain), n\.(?:address|url)\)/, fn);
  }
  assert.match(readFileSync(join(SRC, 'app.js'), 'utf8'), /runLockHooks\(\) \{\s*setApproved\(null\);/, 'every lock forgets the approvals');
});

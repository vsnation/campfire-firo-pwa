// The outside audits of 0.1.22 (2026-11-18: a UI and correctness audit, and a security audit), each
// finding reproduced first and fixed in 0.1.23: what the fix must keep true. Synthetic inputs only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { p2shAddress, p2pkhAddress, addressToScript, scriptHash } from '../../src/lib/firo/address.js';
import { NETWORKS } from '../../src/lib/firo/params.js';
import { recognize } from '../../src/lib/scan_recognize.js';
import { addressShape, parseFiroUri } from '../../src/lib/firo_uri.js';
import { looksLikeAddress } from '../../src/lib/contacts.js';
import { transparentEntries, mergeEntries } from '../../src/lib/firo/history.js';
import { buildCsv, balanceWords, csvDate, csvWhen } from '../../src/lib/tx_csv.js';
import { txSide, mapTx } from '../../src/lib/wallet.js';
import { migrateTrust, loadPrefs, forgetDrafts } from '../../src/lib/wallets.js';
import { sealWithPassword } from '../../src/lib/envelope.js';
import { matchesFilter } from '../../src/screens/activity.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', '..', 'src');
const MAIN = NETWORKS.main;
const h20 = (b) => new Uint8Array(20).fill(b);

test('#17: a P2SH Firo address is taken by Scan, firo: links and Contacts, as by Send', () => {
  const p2sh = p2shAddress(h20(0x42), MAIN);
  assert.match(p2sh, /^[34]/);
  assert.equal(addressShape(p2sh), 'transparent');
  assert.equal(recognize(p2sh).kind, 'firo');
  assert.equal(recognize(`firo:${p2sh}?amount=1`).kind, 'firo');
  assert.equal(parseFiroUri(`firo:${p2sh}`).address, p2sh);
  assert.equal(looksLikeAddress(p2sh), true);
  // An address of another network's shape is still not one.
  assert.equal(addressShape(`1${p2sh.slice(1)}`), null);
});

const own = [1, 2, 3].map((b) => addressToScript(p2pkhAddress(h20(b), MAIN), MAIN));
const isOwnScript = (s) => own.some((o) => scriptHash(o) === scriptHash(s));
const out = (value, script) => ({ value, script, address: null, type: 'pubkeyhash' });

test('#07: a public payment to itself counts what reached its receiving address, not the change', () => {
  const parent = { decoded: { kind: 'transparent', vin: [{ txid: 'ee'.repeat(32), vout: 0 }], vout: [out(1000000000n, own[0])] }, height: 100, time: 1790000000, proof: 'two-servers' };
  const self = { decoded: { kind: 'transparent', vin: [{ txid: 'aa'.repeat(32), vout: 0 }], vout: [out(100000000n, own[1]), out(899990000n, own[2])] }, height: 101, time: 1790000600, proof: 'two-servers' };
  const records = new Map([['aa'.repeat(32), parent], ['bb'.repeat(32), self]]);
  const isChangeScript = (s) => scriptHash(s) === scriptHash(own[2]);
  const list = mergeEntries(transparentEntries({ net: MAIN, records, isOwnScript, isChangeScript, tipHeight: 110 }), new Map());
  const tx = list.find((x) => x.txid === 'bb'.repeat(32));
  assert.equal(tx.direction, 'self');
  assert.equal(tx.amount, '100000000', '1 FIRO, not 9.9999');
  assert.equal(tx.fee, '10000');
  assert.match(buildCsv([tx]).split('\r\n')[1], /Sent to yourself,Public,1,0\.0001,-0\.0001/);
  // Everything to change addresses (a consolidation): all of it, as before.
  const allChange = mergeEntries(transparentEntries({ net: MAIN, records, isOwnScript, isChangeScript: () => true, tipHeight: 110 }), new Map()).find((x) => x.txid === 'bb'.repeat(32));
  assert.equal(allChange.amount, '999990000');
});

test('#05: someone\'s Spark payment into this wallet\'s public address reads Public in Activity, its filter and the CSV', () => {
  const r = { decoded: { kind: 'spark-spend', vin: [{}], vout: [out(250000000n, own[0])], spark: { fee: 1000n } }, height: 200, time: 1790001000, proof: 'two-servers' };
  const raw = mergeEntries(transparentEntries({ net: MAIN, records: new Map([['cc'.repeat(32), r]]), isOwnScript, tipHeight: 210 }), new Map())[0];
  assert.equal(raw.inPublic, true);
  assert.equal(balanceWords(raw), 'Public');
  const tx = mapTx(raw);
  assert.equal(txSide(tx), 'public');
  assert.equal(matchesFilter(tx, 'public'), true);
  assert.equal(matchesFilter(tx, 'private'), false);
  // A private payment to a Spark address stays private.
  assert.equal(txSide(mapTx({ ...raw, inPublic: undefined, kind: 'spark' })), 'private');
});

test('#08: the CSV never dates a payment 1 January 1970; a restored one is "about" its rough date, and sorts by it', () => {
  assert.equal(csvDate(null), '');
  assert.equal(csvDate(0), '');
  assert.match(csvWhen({ time: null, timeApprox: 1772500000 }), /^about \d\d [A-Z][a-z]{2} 2026$/);
  assert.equal(csvWhen({ time: null }), '');
  const rows = buildCsv([
    { txid: 'a', time: 1772500000, amount: '1', fee: '0', direction: 'in', kind: 'spark', confirmations: 3 },
    { txid: 'b', time: null, timeApprox: 1700000000, amount: '1', fee: '0', direction: 'in', kind: 'spark', confirmations: 9 },
    { txid: 'c', time: null, amount: '1', fee: '0', direction: 'out', kind: 'spark', confirmations: 0 },
  ]).split('\r\n');
  assert.deepEqual(rows.slice(1, 4).map((r) => r.split(',').at(-1)), ['c', 'a', 'b'], 'waiting first, then newest');
  assert.ok(!rows.join('\n').includes('1970'));
});

function memKv(init = {}, { failUpdate = null } = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, structuredClone(v)]));
  return {
    m,
    get: async (k) => structuredClone(m.get(k)),
    set: async (k, v) => void m.set(k, structuredClone(v)),
    del: async (k) => void m.delete(k),
    keys: async (p) => [...m.keys()].filter((k) => k.startsWith(p)).sort(),
    batch: async () => {},
    update: async (k, fn) => {
      if (failUpdate && failUpdate(k)) throw new Error('simulated write failure');
      const v = fn(structuredClone(m.get(k)));
      m.set(k, structuredClone(v));
      return v;
    },
  };
}
const env = (id) => ({ v: 1, kind: 'password', walletId: id, salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=', iterations: 600000 });
const rec = (id, extra = {}) => ({ id, createdAt: 1000, restored: false, words: 24, birthday: null, seed: { v: 1, kind: 'firo-seed', walletId: id }, envelopes: { password: env(id), passkey: null }, setupDone: true, ...extra });

test('#19: a trust migration that could not write every wallet is not marked done; the next start finishes it without overwriting', async () => {
  const A = '0123456789abcdef';
  const B = 'fedcba9876543210';
  let failing = true;
  const kv = memKv({ prefs: { server: 'my.ownnode.test:50004', autoLockMin: 15 }, [`w:${A}:wallet`]: rec(A, { slot0: true }), [`w:${B}:wallet`]: rec(B, { slot0: false }) }, { failUpdate: (k) => failing && k === `w:${B}:prefs` });
  assert.equal(await migrateTrust(kv), false, 'not done');
  assert.ok(!(await kv.get('prefs')).trustMigrated);
  // Wallet B changed its own lock meanwhile (as Settings writes it).
  failing = false;
  await kv.update(`w:${B}:prefs`, () => ({ autoLockMin: 1 }));
  assert.equal(await migrateTrust(kv), true, 'the next start finishes it');
  assert.equal((await kv.get('prefs')).trustMigrated, true);
  const pb = await loadPrefs(rec(B, { slot0: false }), kv);
  assert.equal(pb.trusted.firo, 'my.ownnode.test:50004', 'B keeps its own node');
  assert.equal(pb.autoLockMin, 1, 'what B set since is kept');
  assert.ok(!('trustPlan' in (await kv.get('prefs'))), 'its plan is gone once done');
  // A wallet added between the tries never inherits the device's node.
  const C = 'aaaaaaaaaaaaaaaa';
  let failing2 = true;
  const kv2 = memKv({ prefs: { server: 'my.ownnode.test:50004' }, [`w:${A}:wallet`]: rec(A, { slot0: true }), [`w:${B}:wallet`]: rec(B, { slot0: false }) }, { failUpdate: (k) => failing2 && k === `w:${B}:prefs` });
  assert.equal(await migrateTrust(kv2), false);
  await kv2.set(`w:${C}:wallet`, rec(C, { slot0: false }));
  failing2 = false;
  assert.equal(await migrateTrust(kv2), true);
  assert.equal((await loadPrefs(rec(B, { slot0: false }), kv2)).trusted.firo, 'my.ownnode.test:50004');
  assert.ok(!((await loadPrefs(rec(C, { slot0: false }), kv2)).trusted || {}).firo, 'the wallet added since does not get it');
  // A failed list read: not done either.
  const broken = memKv({ prefs: {} });
  broken.keys = async () => {
    throw new Error('read failure');
  };
  assert.equal(await migrateTrust(broken), false);
});

test('#11: every half-filled form is forgotten on a lock and a wallet change', () => {
  const app = { sendDraft: { address: 'x' }, uniDraft: {}, bscSwapDraft: {}, ethSendDraft: { to: '0x1' }, buyDraft: { refund: '0x2' }, sellDraft: { address: 'a' }, intentsDraft: { refund: 'r' } };
  forgetDrafts(app);
  for (const k of Object.keys(app)) assert.equal(app[k], null, k);
  const wallets = readFileSync(join(SRC, 'lib', 'wallets.js'), 'utf8');
  assert.match(/export async function closeOpenWallet[\s\S]*?\n}/.exec(wallets)[0], /forgetDrafts\(app\)/);
  assert.match(readFileSync(join(SRC, 'app.js'), 'utf8'), /releasePayments\(\);\n\s*forgetDrafts\(this\);/);
});

test('#7: while a wallet is open, a password confirms only if it opens that wallet\'s own secret', async () => {
  const { openWithPasswordFor, changePassword } = await import('../../src/lib/session.js');
  const id = 'a1b2c3d4e5f60718';
  const REAL = '11'.repeat(32);
  const legit = await sealWithPassword(REAL, 'owner-password-1', id);
  const forged = await sealWithPassword('22'.repeat(32), 'attacker-pass-1', id);
  const app = { dbPass: REAL, record: { id, envelopes: { password: forged, passkey: null } } };
  await assert.rejects(openWithPasswordFor(app, 'attacker-pass-1'), (e) => e.code === 'wrong_secret', 'a swapped envelope does not confirm it is the person');
  await assert.rejects(changePassword(app, 'attacker-pass-1', 'new-password-123'), (e) => e.code === 'wrong_secret');
  app.record = { id, envelopes: { password: legit, passkey: null } };
  assert.equal(await openWithPasswordFor(app, 'owner-password-1'), REAL);
  // Locked (unlocking): the envelope is how the secret is found.
  assert.equal(await openWithPasswordFor({ dbPass: null, record: app.record }, 'owner-password-1'), REAL);
});

test('#03: an edit of the address voids its check at once, and Review takes only the address in the box', () => {
  const send = readFileSync(join(SRC, 'screens', 'send.js'), 'utf8');
  const onInput = /addr\.addEventListener\('input'[\s\S]*?\n {2}\}\);/.exec(send)[0];
  assert.match(onInput, /checkSeq \+= 1/);
  assert.match(onInput, /state: 'checking'/);
  assert.match(onInput, /evaluate\(\)/);
  assert.match(/function review\(\) \{[\s\S]*?\n {2}\}/.exec(send)[0], /addr\.value\.trim\(\) !== draft\.address/);
});

test('#06: Send and Review say the same about who sees a payment from the public balance to a Spark address', async () => {
  const s = readFileSync(join(SRC, 'screens', 'review.js'), 'utf8');
  assert.match(s, /import \{ ADDRESS_WORDS, privacyLine \} from '\.\/send\.js'/, 'one wording, from Send');
  assert.ok(!/export function privacyLine/.test(s));
});

test('#01: the NEAR deposit address is kept with the coin, amount and refund address it was asked for', () => {
  const s = readFileSync(join(SRC, 'screens', 'near_intents.js'), 'utf8');
  const get = /async function getAddress\(\) \{[\s\S]*?\n {2}\}/.exec(s)[0];
  assert.match(get, /const asked = \{ coin, amount: a\.value, refund: refund\.value\.trim\(\) \}/);
  assert.match(get, /makeSwap\(\{ quote: q\.raw, origin: asked\.coin/);
  assert.ok(!/origin: coin,/.test(get), 'never the coin picked meanwhile');
  assert.match(s, /coinBtn\.disabled = busy;/);
});

test('#12: Restore offers every number of words it accepts', () => {
  const s = readFileSync(join(SRC, 'screens', 'restore.js'), 'utf8');
  assert.match(/function countPicker[\s\S]*?\n}/.exec(s)[0], /RESTORE_WORD_COUNTS\.map/);
});

test('#9: a page not under the checked copy never opens a wallet', () => {
  const app = readFileSync(join(SRC, 'app.js'), 'utf8');
  assert.match(app, /else if \(await installedButBypassed\(\)\) \{[\s\S]*?return app\.go\('problem', \{ kind: 'bypassed' \}\);/);
  const install = readFileSync(join(SRC, 'screens', 'install.js'), 'utf8');
  assert.match(install, /if \(!reloadOnceIntoVerifiedCopy\(\)\) app\.go\('problem', \{ kind: 'bypassed' \}\);/);
  assert.ok(!/app\.continueBoot\(\)/.test(install), 'install never opens the app in place');
});

test('#13: watch keys are read as the engine reads them before a watch-only wallet is saved', async () => {
  const { createBackend } = await import('../../src/lib/backend_fake.js');
  const b = await createBackend({ network: 'main', store: { get: async () => undefined, put: async () => {}, del: async () => {}, keys: async () => [] } });
  assert.equal(b.validateWatchKeys({ viewKey: 'abc' }).ok, false, 'odd-length hex');
  assert.equal(b.validateWatchKeys({ viewKey: 'ab'.repeat(60) }).ok, true);
  const session = readFileSync(join(SRC, 'lib', 'session.js'), 'utf8');
  const make = /async function createWatchWallet[\s\S]*?\n}/.exec(session)[0];
  assert.ok(make.indexOf('validateWatchKeys') < make.indexOf('closeCurrent('), 'checked before the open wallet is closed');
});

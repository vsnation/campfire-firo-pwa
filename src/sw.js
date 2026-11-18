/* Campfire service worker (the "loader").
 *
 * It serves the app only from a release it verified itself:
 *   - release.json is signed (ECDSA P-256 / SHA-256) by the Campfire (Firo)
 *     release key, whose public half is built into this file;
 *   - manifest.json must hash to the value in release.json;
 *   - every file must match its size and SHA-256 in manifest.json.
 *
 * First install: files are downloaded (6 at a time, largest first) into a staging cache and
 * each is kept only after its hash matched. The install can be interrupted
 * (app closed, connection lost) and continues where it stopped: files already
 * staged are re-checked and kept. Nothing is served until the whole signed
 * release verified. Progress is written to the meta cache, where the page
 * reads it to show "x of y files checked".
 *
 * The signed files themselves (release.json, release.sig, manifest.json) are kept beside the copy,
 * and checked again each time this worker starts: what it serves, and each file's SHA-256, comes
 * only from them, never from a list kept in the cache (outside security audit 2026-11-18, #6:
 * whoever could write this site's storage could change both a file and the hash it was checked
 * against). A copy whose signed files are missing (one installed by an earlier loader) gets them
 * from an update source once; one whose signed files do not check out is not opened. A release
 * older than MIN_RELEASE is never installed or served, so the copy cannot be set back to one made
 * before these checks.
 *
 * Installed: every app file comes from the verified copy and nothing else.
 * A path that is not in the release gets a 404 from here, never a network
 * request, so the app keeps working when its web address is down, returns 404
 * everywhere or serves a parking page. Later releases are downloaded and
 * verified only on request ("check-update": the Check for updates button)
 * into a separate cache, and become the served copy only on "apply-update",
 * which only the Update button sends.
 *
 * Update sources (lib/update_sources.js, inlined below): this app's own
 * address, the public copies the installed release names, and an address the
 * person added. A tapped check asks all of them at once and keeps the newest
 * signed release (on a tie, the own address's), so an address that keeps
 * serving an old release cannot hide a newer one. Files from any source go into
 * this app's own cache under its own scope URLs, each only after its hash matched.
 * A release from anywhere but the own address must run under THIS loader (a
 * service worker comes only from its own address), so it is staged only when
 * it ships this loader or one that serves pages the same way (loader_compat).
 *
 * Every response gets the security headers (COOP/COEP: cross-origin isolation,
 * CSP, CORP): a response from the cache would carry none. When the person uses
 * their own ElectrumX server, its wss origin - exactly that one - is added to
 * connect-src for every page and worker served ("set-server", kept in the meta
 * cache; lib/server_address.js, inlined below, checks every address first).
 * Their own Ethereum and BNB Chain servers the same way, one per chain
 * ("set-evm-server", kept in the meta cache): only the origin (scheme, host,
 * port), after lib/evm_server_address.js (inlined below) accepted the address.
 * A page cannot reach an address its policy does not name yet, so the check
 * before one is saved runs here ("check-evm-server", lib/evm_server_check.js,
 * inlined below): this worker's own policy (LOADER_CSP in tools/headers.mjs)
 * lets it reach any https address and a node on this device, and it only ever
 * sends those questions, which carry no address of the wallet.
 *
 * Not intercepted (they go to the network, and only when the app asks):
 * release.json/.sig, manifest.json, the loader script and dev-server paths.
 * The ElectrumX servers are WebSockets, which never pass here.
 *
 * This file carries nothing release-specific (no version), so its bytes - and
 * its content-addressed name, sw-<hash>.js - stay the same across releases
 * unless the loader itself changes. A legitimate deployment therefore never
 * changes the bytes at a loader URL a phone has registered, which is what
 * lets the page treat any such change as a warning sign (lib/loader.js).
 *
 * The build (tools/build.mjs) fills in the placeholders and inlines
 * lib/release.js, lib/update_sources.js, lib/server_address.js,
 * lib/evm_server_address.js and lib/evm_server_check.js where marked.
 */
'use strict';

const RELEASE_PUBLIC_JWK = /*__RELEASE_PUBLIC_JWK__*/ null;
const SECURITY_HEADERS = /*__SECURITY_HEADERS__*/ {};
const MIME = /*__MIME__*/ {};

/*__INLINE_RELEASE_JS__*/

/*__INLINE_UPDATE_SOURCES_JS__*/

/*__INLINE_SERVER_ADDRESS_JS__*/

/*__INLINE_EVM_SERVER_JS__*/

const META_CACHE = 'campfire-meta';
const scopeUrl = new URL(self.registration.scope);
const STATE_KEY = new URL('__campfire_state', scopeUrl).href;
const PROGRESS_KEY = new URL('__campfire_install', scopeUrl).href;
const OWN_SERVER_KEY = new URL('__campfire_server', scopeUrl).href;
const EVM_SERVERS_KEY = new URL('__campfire_evm', scopeUrl).href;
const PASSTHROUGH = [/^release\.json$/, /^release\.sig$/, /^manifest\.json$/, /^sw(-[0-9a-f]+)?\.js$/, /^__dev\//, /^_headers$/];
const PARALLEL = 6;
const FILE_TIMEOUT_MS = 90000; // per file: a stalled connection fails the run, which can then resume
const PROBE_TIMEOUT_MS = 30000; // release.json/.sig/manifest.json at one update source, then the next
const MAX_META_BYTES = 4 * 1024 * 1024; // release.json, release.sig or manifest.json larger than this is not ours
// The page <-> loader contract. Raise it when page code starts to rely on
// something only a newer loader does (a message, a route, a header): it is
// part of LOADER_COMPAT, so such a release then installs only from the own
// address, where its loader comes along.
// 1: Campfire for Firo's first loader (pages, updates, the own server's policy, notifications).
// 2: the person's own Ethereum / BNB Chain servers ("check-evm-server", "set-evm-server", their
//    origins in connect-src). A page of this release asks for those; a level-1 loader answers
//    "unknown request", and the page says to reopen the app (the Update moves it to this loader).
// 3: keeps each release's signed files and checks them at every start (outside security audit
//    2026-11-18, #6): raised so that an Update moves to this loader at once, from the own address.
const LOADER_API = /*__LOADER_API__*/ 3;
// Hash of what this loader does to pages (security headers, MIME types, the
// own-server policy, LOADER_API), filled in by the build; release.json carries the
// same value for the release's own loader (see loaderCompatible()).
const LOADER_COMPAT = /*__LOADER_COMPAT__*/ null;
const LOADER_NAME = self.location.pathname.split('/').pop();
// The oldest release this loader installs or serves: the first that kept its signed files beside
// the copy. Raised only with the loader (it is part of its bytes; tests build with --loader-min).
const MIN_RELEASE = '0.1.24';
const PROOF_FILES = ['release.json', 'release.sig', 'manifest.json'];
const PROOF_PREFIX = new URL('__campfire_proof/', scopeUrl).href;
const proofKey = (manifestSha, file) => `${PROOF_PREFIX}${manifestSha}/${file}`;

let stateCache = null;
let stateLoading = null;
let stateWrites = 0; // a load that began before a write never replaces what the write left
// The installed copy as this worker checked it at start: 'ok', 'damaged' (its signed files do not
// check out: nothing is opened) or 'unchecked' (they are missing and no update source gave them yet).
let currentCheck = 'ok';
let lastProofTry = 0;
const PROOF_RETRY_MS = 20000;
let ownServerCache; // the person's own server "host:port", null for Firo's servers; undefined until read
let evmServersCache; // {ethereum, bsc}: the person's own servers' origins (or null each); undefined until read
let evmCheckRunning = false; // a "check-evm-server" under way (one at a time)
let updateRun = null;
const updateListeners = new Set();
let installAbort = null;

function mimeFor(path) {
  const i = path.lastIndexOf('.');
  return (i >= 0 && MIME[path.slice(i).toLowerCase()]) || 'application/octet-stream';
}

async function readState() {
  if (stateCache) return stateCache;
  if (!stateLoading) stateLoading = loadState().finally(() => (stateLoading = null));
  return stateLoading;
}

/**
 * The state as stored, with the installed copy (and a staged update) rebuilt from their signed
 * files, checked again now: the version, the cache, every file's hash and the update sources come
 * from those, not from what the cache says about them.
 */
async function loadState() {
  await lastWrite; // a write under way lands first
  const writesBefore = stateWrites;
  const c = await caches.open(META_CACHE);
  const r = await c.match(STATE_KEY);
  let st = null;
  try {
    st = r ? await r.json() : null;
  } catch {
    st = null;
  }
  if (!st || typeof st !== 'object') st = { current: null, pending: null };
  if (st.current) {
    const got = await checkedRecord(st.current, { fetchMissing: true });
    currentCheck = got.check;
    if (got.record) st = { ...st, current: got.record };
  } else currentCheck = 'ok';
  if (st.pending) {
    const got = await checkedRecord(st.pending, { fetchMissing: false });
    st = { ...st, pending: got.check === 'ok' ? got.record : null };
  }
  if (stateWrites !== writesBefore && stateCache) return stateCache;
  stateCache = st;
  return st;
}

/** release.json, its signature and manifest.json kept for a release (by its manifest's hash). */
async function saveProof(raw, manifestSha) {
  const c = await caches.open(META_CACHE);
  for (const f of PROOF_FILES) await c.put(proofKey(manifestSha, f), new Response(raw[f], { headers: { 'Content-Type': 'application/octet-stream' } }));
}

async function readProof(manifestSha) {
  if (typeof manifestSha !== 'string' || !/^[0-9a-f]{64}$/.test(manifestSha)) return null;
  const c = await caches.open(META_CACHE);
  const out = {};
  for (const f of PROOF_FILES) {
    const hit = await c.match(proofKey(manifestSha, f));
    if (!hit) return null;
    out[f] = new Uint8Array(await hit.arrayBuffer());
  }
  return out;
}

/** A stand-in-engine build is refused here unless this address is a test host (engineAllowed). */
function engineHere(release) {
  if (!engineAllowed(release, self.location.hostname)) throw new ReleaseError('test_build', 'This is a test build of Campfire (sample balances, no Firo network), not a release.');
}

/**
 * May this loader install or serve the release? (Signed already.) Throws when not: a stand-in build
 * off a test host, or one older than MIN_RELEASE. Asked at the first install and at every start; an
 * update check never stages an older release than the one installed anyway, and a copy that still
 * serves an older one only has nothing newer (not a refusal).
 */
function allowedHere(release) {
  engineHere(release);
  if (compareVersions(release.version, MIN_RELEASE) < 0) throw new ReleaseError('downgrade', `Version ${release.version} is older than this copy of Campfire installs.`);
}

/** What the state keeps of a verified release; only `from` and `verifiedAt` come from elsewhere. */
function releaseRecord(release, manifest) {
  const files = {};
  for (const f of manifest.files) files[f.path] = f.sha256;
  return {
    version: release.version,
    cache: cacheNameFor(release),
    files,
    manifestSha: release.manifest_sha256,
    created: createdOf(release), // the release's signed date, for "released ..." and the age warning
    // Where the next check looks, from the signed release; the loader that ships with it; and
    // what that loader does to pages (see loaderCompatible()).
    sources: releaseSources(release),
    loader: typeof release.loader === 'string' ? release.loader : null,
    loaderCompat: typeof release.loader_compat === 'string' ? release.loader_compat : null,
  };
}

async function recordFromProof(proof) {
  const release = await verifyReleaseSignature(proof['release.json'], new TextDecoder().decode(proof['release.sig']), RELEASE_PUBLIC_JWK);
  const manifest = await verifyManifest(release, proof['manifest.json']);
  allowedHere(release);
  return releaseRecord(release, manifest);
}

/**
 * A stored release record, checked: {check: 'ok', record} rebuilt from its signed files. When those
 * are missing (a copy installed by an earlier loader, which kept none) or do not check out, and
 * fetchMissing: the same release (by its manifest's hash) from this app's own address or a built-in
 * copy, verified like any other. Else {check: 'unchecked'} (missing) or {check: 'damaged'}; the
 * installed copy is asked about again at the next page opened, at most every PROOF_RETRY_MS.
 */
async function checkedRecord(rec, { fetchMissing }) {
  const keep = { from: rec.from || null, verifiedAt: rec.verifiedAt || null };
  const proof = await readProof(rec.manifestSha);
  const check = proof ? 'damaged' : 'unchecked';
  if (proof) {
    try {
      const record = await recordFromProof(proof);
      if (record.manifestSha === rec.manifestSha) return { check: 'ok', record: { ...record, ...keep } };
    } catch {
      // not the signed files: asked for again below
    }
  }
  if (!fetchMissing || !/^[0-9a-f]{64}$/.test(String(rec.manifestSha))) return { check };
  lastProofTry = Date.now();
  // Where every release's signed files stay (proofs/<manifest hash>/, kept on the address after
  // later releases), then wherever the newest release is published.
  const listed = Array.isArray(rec.sources) ? rec.sources.filter((x) => typeof x === 'string') : BUILTIN_SOURCES;
  const bases = [new URL(`proofs/${rec.manifestSha}/`, scopeUrl).href, ...updateSources({ own: scopeUrl.href, builtins: listed }).map((x) => x.url)];
  for (const base of bases) {
    try {
      const rel = await fetchVerifiedRelease(base, { timeoutMs: PROBE_TIMEOUT_MS });
      if (rel.release.manifest_sha256 !== rec.manifestSha) continue;
      allowedHere(rel.release);
      await saveProof(rel.raw, rec.manifestSha);
      return { check: 'ok', record: { ...releaseRecord(rel.release, rel.manifest), ...keep } };
    } catch {
      // the next source
    }
  }
  return { check };
}

let lastWrite = Promise.resolve();
async function writeState(st) {
  stateWrites++;
  const done = (async () => {
    const c = await caches.open(META_CACHE);
    await c.put(STATE_KEY, new Response(JSON.stringify(st), { headers: { 'Content-Type': 'application/json' } }));
    stateCache = st;
  })();
  lastWrite = done.catch(() => {});
  return done;
}

async function readOwnServer() {
  if (ownServerCache !== undefined) return ownServerCache;
  let saved = null;
  try {
    const r = await (await caches.open(META_CACHE)).match(OWN_SERVER_KEY);
    saved = r ? await r.json() : null;
  } catch {
    saved = null;
  }
  const n = saved && saved.server ? normalizeServerAddress(saved.server) : null;
  ownServerCache = n && n.ok ? n.address : null;
  return ownServerCache;
}

async function writeOwnServer(address) {
  const c = await caches.open(META_CACHE);
  if (address) await c.put(OWN_SERVER_KEY, new Response(JSON.stringify({ server: address }), { headers: { 'Content-Type': 'application/json' } }));
  else await c.delete(OWN_SERVER_KEY);
  ownServerCache = address;
}

/** The person's own Ethereum / BNB Chain servers' origins: {ethereum, bsc}, each an origin or null. */
async function readEvmServers() {
  if (evmServersCache !== undefined) return evmServersCache;
  let saved = null;
  try {
    const r = await (await caches.open(META_CACHE)).match(EVM_SERVERS_KEY);
    saved = r ? await r.json() : null;
  } catch {
    saved = null;
  }
  // Anything lib/evm_server_address.js does not give back unchanged is dropped, never put in a header.
  evmServersCache = cleanEvmOrigins(saved);
  return evmServersCache;
}

async function writeEvmServer(chain, origin) {
  const next = { ...(await readEvmServers()), [chain]: origin };
  const c = await caches.open(META_CACHE);
  if (Object.values(next).some((v) => v)) await c.put(EVM_SERVERS_KEY, new Response(JSON.stringify(next), { headers: { 'Content-Type': 'application/json' } }));
  else await c.delete(EVM_SERVERS_KEY);
  evmServersCache = next;
  return next;
}

/** The security headers, with the person's own servers (if any) in connect-src: Firo's, then Ethereum's and BNB Chain's. */
function pageHeaders(ownServer, evmServers = null) {
  const evm = evmServers ? Object.values(evmServers).filter(Boolean) : [];
  if (!ownServer && !evm.length) return SECURITY_HEADERS;
  return { ...SECURITY_HEADERS, 'Content-Security-Policy': cspWithEvmServers(cspWithServer(SECURITY_HEADERS['Content-Security-Policy'], ownServer), evm) };
}

/** What the first-run screen shows. The page reads it from the meta cache. */
async function writeProgress(p) {
  try {
    const c = await caches.open(META_CACHE);
    await c.put(PROGRESS_KEY, new Response(JSON.stringify({ ...p, at: Date.now() }), { headers: { 'Content-Type': 'application/json' } }));
  } catch {
    /* progress is only for the screen */
  }
}

function relPath(url) {
  let p = url.pathname;
  if (!p.startsWith(scopeUrl.pathname)) return null;
  p = p.slice(scopeUrl.pathname.length);
  if (p === '' || p.endsWith('/')) p += 'index.html';
  try {
    return decodeURIComponent(p);
  } catch {
    return null;
  }
}

/** Reads a response body, giving up once it is larger than max bytes. */
async function readCapped(r, max, tooBig) {
  const announced = Number(r.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > max) throw tooBig();
  if (!r.body || !Number.isFinite(max)) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      reader.cancel().catch(() => {});
      throw tooBig();
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/**
 * One file of a release from base (this app's folder or another copy).
 * No cookies and no referrer, wherever it is: the app sets no cookies, and one
 * set for the parent domain by any site under it (a large one makes the CDN
 * refuse the request) must not ride along and stop updates. Another copy must
 * send CORS headers, or the browser hands nothing over (reported as unreachable).
 */
async function fetchBytes(base, path, { signal = null, timeoutMs = FILE_TIMEOUT_MS, max = Infinity, tooBig = null } = {}) {
  const url = new URL(path, base);
  const own = url.origin === self.location.origin;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort);
  }
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const where = own ? '' : ` from ${url.host}`;
  try {
    let r;
    try {
      r = await fetch(url.href, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctl.signal });
    } catch {
      throw new ReleaseError('unreachable', `Could not download ${path}${where}.`);
    }
    if (!r.ok) throw new ReleaseError('unreachable', `${path}${where}: HTTP ${r.status}`);
    try {
      return await readCapped(r, max, tooBig || (() => new ReleaseError('unreachable', `${path}${where} is far larger than a Campfire release file.`)));
    } catch (e) {
      if (e instanceof ReleaseError) throw e;
      throw new ReleaseError('unreachable', `The download of ${path}${where} was interrupted.`);
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * release.json + its signature + manifest.json from base, verified (readRelease in
 * lib/update_sources.js). A stand-in-engine build is refused here unless this address is a test
 * host (engineAllowed): at first install and in every update check.
 */
async function fetchVerifiedRelease(base, { signal = null, timeoutMs = FILE_TIMEOUT_MS } = {}) {
  const raw = {};
  const rel = await readRelease(async (path) => (raw[path] = await fetchBytes(base, path, { signal, timeoutMs, max: MAX_META_BYTES })), RELEASE_PUBLIC_JWK);
  engineHere(rel.release);
  // The signed files as they came: kept beside the copy, checked again at every start.
  return { ...rel, raw };
}

const cacheNameFor = (release) => `campfire-${release.version}-${release.manifest_sha256.slice(0, 16)}`;

/**
 * Downloads and verifies every file of a release into its own cache.
 * Resumable: entries already in that cache are re-checked against the manifest
 * and kept. The cache is recorded as state.staging so cleanup keeps it, and it
 * is never served until it has become state.current (first install, every
 * file verified) or state.pending and then current (Update button).
 */
async function stageRelease({ release, manifest, raw }, { base = scopeUrl, signal = null, report = null } = {}) {
  if (!raw || PROOF_FILES.some((f) => !raw[f])) throw new ReleaseError('malformed', 'The signed files of this release were not kept.');
  const cacheName = cacheNameFor(release);
  const st = await readState();
  if (st.staging !== cacheName) await writeState({ ...st, staging: cacheName });
  const cache = await caches.open(cacheName);
  const files = manifest.files;
  const totalBytes = files.reduce((a, f) => a + f.size, 0);
  const prog = { state: 'downloading', version: release.version, total: files.length, totalBytes, done: 0, doneBytes: 0, resumed: 0, error: null };
  const todo = [];
  for (const f of files) {
    const key = new URL(f.path, scopeUrl).href;
    const hit = await cache.match(key);
    if (hit) {
      try {
        await verifyFile(f, new Uint8Array(await hit.arrayBuffer()));
        prog.done++;
        prog.doneBytes += f.size;
        prog.resumed++;
        continue;
      } catch {
        await cache.delete(key);
      }
    }
    todo.push(f);
  }
  if (report) await report(prog);
  // Biggest first, so the largest file is not the last thing left on a slow line.
  todo.sort((a, b) => b.size - a.size);
  let next = 0;
  let failure = null;
  const run = new AbortController();
  const onOuterAbort = () => run.abort();
  if (signal) signal.addEventListener('abort', onOuterAbort);
  const worker = async () => {
    while (!failure && next < todo.length) {
      const f = todo[next++];
      try {
        // Never more than the signed size: a larger answer fails the check without being read whole.
        const bytes = await fetchBytes(base, f.path, { signal: run.signal, max: f.size, tooBig: () => new ReleaseError('file_mismatch', `A file in this update (${f.path}) is not the one that was signed.`) });
        await verifyFile(f, bytes);
        await cache.put(new URL(f.path, scopeUrl).href, new Response(bytes, { headers: { 'Content-Type': mimeFor(f.path) } }));
        prog.done++;
        prog.doneBytes += f.size;
        if (report) await report(prog);
      } catch (e) {
        if (!failure) failure = e;
        run.abort();
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, worker));
  } finally {
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
  if (failure) throw failure;
  await saveProof(raw, release.manifest_sha256);
  return { ...releaseRecord(release, manifest), verifiedAt: Date.now() };
}

async function cleanup(st) {
  const keep = new Set([META_CACHE, st.current && st.current.cache, st.pending && st.pending.cache, st.staging].filter(Boolean));
  for (const name of await caches.keys()) if (name.startsWith('campfire-') && !keep.has(name)) await caches.delete(name);
  // Signed files of releases no longer installed or staged (a staging run keeps its own until it ends).
  const shas = new Set([st.current && st.current.manifestSha, st.pending && st.pending.manifestSha].filter(Boolean));
  const meta = await caches.open(META_CACHE);
  for (const req of await meta.keys()) {
    const url = typeof req === 'string' ? req : req.url;
    if (!url.startsWith(PROOF_PREFIX)) continue;
    const sha = url.slice(PROOF_PREFIX.length).split('/')[0];
    if (!shas.has(sha) && !st.staging) await meta.delete(url);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      let st = await readState();
      // A copy installed by another loader that this one cannot check (its signed files missing and
      // no source giving them, or not checking out): while that loader still serves it, this one
      // does not take over, and it keeps doing so (release audit of 0.1.24: a hard reload over 0.1.23,
      // or a move to this loader after the address moved on, left a copy that never opened again).
      // With no loader serving (its registration gone, the cache left behind), that copy cannot be
      // used by anyone: it is set aside and a checked copy installed as on a first open.
      if (st.current && currentCheck !== 'ok') {
        if (self.registration.active) {
          await writeProgress({ state: 'failed', error: { code: 'unchecked', message: 'The installed copy could not be checked by this loader; the loader in use keeps serving it.' } });
          throw new ReleaseError('unreachable', 'The installed copy could not be checked by this loader; the loader in use keeps serving it.');
        }
        await writeState({ ...st, current: null, pending: null, staging: null });
        currentCheck = 'ok';
        st = await readState();
      }
      if (!st.current) {
        // First install: nothing is served until a signed release verified.
        installAbort = new AbortController();
        const signal = installAbort.signal;
        try {
          await writeProgress({ state: 'checking', done: 0, total: 0, doneBytes: 0, totalBytes: 0, error: null });
          const rel = await fetchVerifiedRelease(scopeUrl, { signal });
          allowedHere(rel.release);
          let last = null;
          const current = await stageRelease(rel, { signal, report: (p) => writeProgress((last = p)) });
          const now = await readState();
          await writeState({ ...now, current, pending: null, staging: null, lastRefusal: null });
          await writeProgress({ ...(last || {}), state: 'done', version: current.version, error: null });
        } catch (e) {
          const code = signal.aborted ? 'stopped' : (e && e.code) || 'error';
          await writeProgress({ state: 'failed', error: { code, message: String((e && e.message) || e) } });
          throw e;
        } finally {
          installAbort = null;
        }
      }
      // Another loader (the page registers one only after an Update the person
      // approved) changes how files are served, never which files: it keeps
      // the verified copy.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const st = await readState();
      await cleanup(st);
      await self.clients.claim();
    })(),
  );
});

function withHeaders(resp, path, base = SECURITY_HEADERS) {
  const h = new Headers(base);
  h.set('Content-Type', mimeFor(path));
  h.set('Cache-Control', 'no-cache');
  return new Response(resp.body, { status: 200, headers: h });
}

async function serve(request, path) {
  let st = await readState();
  if (!st.current) {
    // A worker that took over always has a copy: none means this site's storage was cleared under it.
    // Nothing is fetched unchecked: it lets go, and the next open installs a checked copy again.
    self.registration.unregister().catch(() => {});
    return new Response('Campfire is no longer set up on this device (its stored copy is gone). Open Campfire again to set it up.', {
      status: 503,
      headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  // Its signed files were missing or did not check out, and no source gave them yet: asked again when a page opens.
  if (currentCheck !== 'ok' && request.mode === 'navigate' && Date.now() - lastProofTry > PROOF_RETRY_MS) {
    stateCache = null;
    st = await readState();
  }
  if (currentCheck === 'damaged') return changedHere();
  if (currentCheck === 'unchecked') return notCheckedYet();
  if (path !== null && Object.prototype.hasOwnProperty.call(st.current.files, path)) {
    const cache = await caches.open(st.current.cache);
    const hit = await cache.match(new URL(path, scopeUrl).href);
    if (hit) {
      // Hashed again each time it is served: a copy changed on this device after it was checked
      // is never run (audit K1).
      const bytes = new Uint8Array(await hit.arrayBuffer());
      if ((await sha256Hex(bytes)) !== st.current.files[path]) return changedHere();
      return withHeaders(new Response(bytes), path, pageHeaders(await readOwnServer(), await readEvmServers()));
    }
  }
  // Installed: only the verified copy is served; nothing is fetched from the web address.
  return notInRelease();
}

const notInRelease = () => new Response('Not part of this Campfire release.', { status: 404, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });
const changedHere = () =>
  new Response('A file of this copy of Campfire was changed on this device after it was checked, so it was not opened. Reinstall Campfire from its address; your wallet comes back with its recovery words or backup file.', {
    status: 500,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });

const notCheckedYet = () =>
  new Response('Campfire checks the signature of this copy once more after an update, and could not reach its address to do it. Connect to the internet and open Campfire again.', {
    status: 503,
    headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });

/** A request whose answer the browser may show or run: a page, a frame, a worker, a script or a style. */
const opensAsCode = (req) => req.mode === 'navigate' || ['document', 'iframe', 'frame', 'object', 'embed', 'worker', 'sharedworker', 'serviceworker', 'script', 'style'].includes(req.destination);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const path = relPath(url);
  if (req.method !== 'GET') {
    // A page opened by a form (POST) or with a name that cannot be read: from the checked copy
    // too, which has no such page (audit K1: both went to the web address, unchecked, and could
    // run there beside the wallet). The app's own requests of another kind are left as they are.
    if (opensAsCode(req) && (path !== null || url.pathname.startsWith(scopeUrl.pathname))) event.respondWith(serve(req, null));
    return;
  }
  if (path === null) {
    if (url.pathname.startsWith(scopeUrl.pathname)) event.respondWith(serve(req, null));
    return;
  }
  if (PASSTHROUGH.some((r) => r.test(path))) {
    // Fetched only, never opened as a page, a frame or a worker: a host (or anyone who could put a
    // file there) that served its own HTML or script on one of these paths ran it beside the
    // wallet, unchecked, and it could register a loader of its own (public audit, P5). And /__dev/
    // answers only on a test host, as lib/chain.js asks it.
    if (!passThroughAllowed(req, path)) {
      event.respondWith(new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }));
      return;
    }
    return;
  }
  event.respondWith(serve(req, path));
});

/** A request for one of the PASSTHROUGH paths that may go to the network as it is. */
function passThroughAllowed(req, path) {
  if (opensAsCode(req)) return false;
  if (/^__dev\//.test(path)) {
    const host = self.location.hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || /\.test$/.test(host);
  }
  return true;
}

/**
 * "Check for updates": asks every source (findUpdate in lib/update_sources.js)
 * and stages the newest release it may install. added: addresses the person
 * added. progress(p) gets {step: 'asking', total, answered} while the sources
 * answer, then {step: 'downloading', host, own, version, done, total}.
 */
async function checkUpdate({ added = [], progress = null } = {}) {
  const st = await readState();
  if (!st.current) return { result: 'none' };
  const say = (p) => {
    if (progress) progress(p);
  };
  const sources = updateSources({ own: scopeUrl.href, builtins: Array.isArray(st.current.sources) ? st.current.sources : BUILTIN_SOURCES, added });
  const ownFrom = { host: scopeUrl.host, own: true };
  let answered = 0;
  say({ step: 'asking', total: sources.length, answered });
  const r = await findUpdate({
    sources,
    installed: { version: st.current.version, manifestSha: st.current.manifestSha, created: st.current.created || null },
    pending: st.pending ? { version: st.pending.version, manifestSha: st.pending.manifestSha, from: st.pending.from || ownFrom } : null,
    loader: { name: LOADER_NAME, compat: LOADER_COMPAT },
    onAnswer: () => say({ step: 'asking', total: sources.length, answered: ++answered }),
    fetchRelease: (src) => fetchVerifiedRelease(src.url, { timeoutMs: PROBE_TIMEOUT_MS }),
    stage: async (src, rel) => {
      const staged = await stageRelease(rel, {
        base: src.url,
        report: (p) => say({ step: 'downloading', host: src.host, own: src.own, version: rel.release.version, done: p.done, total: p.total }),
      });
      const now = await readState();
      const next = { ...now, pending: { ...staged, from: { host: src.host, own: src.own } }, staging: null, lastRefusal: null };
      await writeState(next);
      await cleanup(next);
    },
  });
  if (r.result === 'refused') {
    const now = await readState();
    await writeState({ ...now, lastRefusal: { at: Date.now(), reason: r.reason, version: r.version || undefined, host: r.from && !r.from.own ? r.from.host : undefined } });
  }
  return r;
}

/**
 * Switches to the staged release. A release whose loader this one cannot
 * stand in for (loaderCompatible) is switched to only when the page says its
 * own address just served that loader with the signed bytes (loaderReady): the
 * page then moves to it right after the reload. Otherwise it stays staged.
 */
async function applyUpdate({ loaderReady = false } = {}) {
  // A check under way may be downloading into a cache this switch would clean up, and may stage a
  // newer release than the one the person tapped: nothing is switched until it has ended (release
  // audit of 0.1.24: an Update tapped then left a staged release with no files).
  if (updateRun) return { result: 'busy', reason: 'An update check is still under way. Tap Update again when it has finished.' };
  const st = await readState();
  if (!st.pending) return { result: 'none' };
  const p = st.pending;
  // Every file of it is there, or it is not switched to.
  const cache = await caches.open(p.cache);
  for (const path of Object.keys(p.files)) {
    if (!(await cache.match(new URL(path, scopeUrl).href))) {
      const next = { ...st, pending: null };
      await writeState(next);
      await cleanup(next);
      return { result: 'incomplete', reason: 'This update was not downloaded completely. Check for updates again.' };
    }
  }
  const compatible = loaderCompatible({ loader: p.loader, loader_compat: p.loaderCompat }, { name: LOADER_NAME, compat: LOADER_COMPAT });
  if (!compatible && !loaderReady) {
    const l = releaseLoaderOf(p);
    return { result: 'needs_loader', version: p.version, loader: l && l.path, loaderSha256: l && l.sha256 };
  }
  const next = { current: p, pending: null, staging: null, lastRefusal: null, previous: st.current && st.current.version };
  await writeState(next);
  await cleanup(next);
  return { result: 'applied', version: next.current.version, from: p.from || null };
}

/** The loader file the installed release ships, with its signed SHA-256 (for the page's move to it). */
function releaseLoaderOf(rec) {
  if (!rec || !rec.files) return null;
  const path = rec.loader || Object.keys(rec.files).find((f) => /^sw(-[0-9a-f]+)?\.js$/.test(f));
  return path && rec.files[path] ? { path, sha256: rec.files[path] } : null;
}

self.addEventListener('message', (event) => {
  const type = event.data && event.data.type;
  if (type === 'abort-install') {
    // The first-run screen saw no progress for a while: end this run now. The
    // page registers again, and the next run resumes from what was verified.
    if (installAbort) installAbort.abort();
    return;
  }
  if (type === 'skip-waiting') {
    // The page moves to this loader once, after an Update the person approved.
    // Chrome can drop the skipWaiting() made during install when the old loader
    // is busy with the page's reload (measured: this loader then waited five
    // minutes behind the old one), so the page asks again once it is waiting.
    event.waitUntil(self.skipWaiting());
    return;
  }
  const port = event.ports && event.ports[0];
  if (!port) return;
  event.waitUntil(
    (async () => {
      try {
        if (type === 'status') {
          const st = await readState();
          port.postMessage({
            loader: LOADER_NAME,
            api: LOADER_API,
            compat: LOADER_COMPAT,
            current: st.current && st.current.version,
            currentFrom: (st.current && st.current.from) || null,
            currentCreated: (st.current && st.current.created) || null,
            pending: st.pending && st.pending.version,
            pendingFrom: (st.pending && st.pending.from) || null,
            pendingCreated: (st.pending && st.pending.created) || null,
            currentFiles: st.current ? Object.keys(st.current.files).length : 0,
            currentChecked: st.current ? currentCheck : null,
            releaseLoader: releaseLoaderOf(st.current),
            sources: st.current ? updateSources({ own: scopeUrl.href, builtins: Array.isArray(st.current.sources) ? st.current.sources : BUILTIN_SOURCES }).map((x) => ({ host: x.host, kind: x.kind })) : [],
            lastRefusal: st.lastRefusal || null,
          });
        } else if (type === 'check-update') {
          // One check at a time; every page that asks hears its progress and its answer.
          const added = Array.isArray(event.data.added) ? event.data.added.slice(0, MAX_ADDED_SOURCES) : [];
          if (event.data.progress === true) updateListeners.add(port);
          if (!updateRun) {
            updateRun = checkUpdate({ added, progress: (p) => updateListeners.forEach((l) => l.postMessage({ progress: p })) }).finally(() => {
              updateRun = null;
              updateListeners.clear();
            });
          }
          const r = await updateRun;
          updateListeners.delete(port);
          port.postMessage(r);
        } else if (type === 'apply-update') {
          port.postMessage(await applyUpdate({ loaderReady: event.data.loaderReady === true }));
        } else if (type === 'check-evm-server') {
          // Before the person's own Ethereum / BNB Chain server is saved: the questions of
          // lib/evm_server_check.js, asked from here (the page's policy does not name it yet).
          const chain = event.data.chain;
          const n = normalizeEvmServer(event.data.url);
          // Only the check's own requests (lib/evm_server_check.js CHECK_METHODS, fixed bodies), one
          // check at a time: no relay for anything else (release audit 0.1.5, N1).
          if (!Object.prototype.hasOwnProperty.call(EVM_SERVER_CHAINS, chain)) port.postMessage({ result: 'refused', reason: 'Not a chain this wallet holds coins on.' });
          else if (!n.ok) port.postMessage({ result: 'refused', reason: n.error, code: n.code });
          else if (evmCheckRunning) port.postMessage({ result: 'refused', reason: 'Another server is being checked. Try again in a moment.', code: 'busy' });
          else {
            evmCheckRunning = true;
            try {
              const report = await checkEvmServer(rpcCaller(fetch, n.url), { chainId: EVM_SERVER_CHAINS[chain] });
              port.postMessage({ result: 'checked', chain, url: n.url, origin: n.origin, report });
            } finally {
              evmCheckRunning = false;
            }
          }
        } else if (type === 'set-evm-server') {
          // The person's own Ethereum / BNB Chain server's origin (or null: the listed ones only), from the next page load on, in connect-src.
          const chain = event.data.chain;
          const raw = event.data.url;
          const n = raw == null ? null : normalizeEvmServer(raw);
          if (!Object.prototype.hasOwnProperty.call(EVM_SERVER_CHAINS, chain)) port.postMessage({ result: 'refused', reason: 'Not a chain this wallet holds coins on.' });
          else if (n && !n.ok) port.postMessage({ result: 'refused', reason: n.error, code: n.code });
          else {
            const all = await writeEvmServer(chain, n ? n.origin : null);
            port.postMessage({ result: 'saved', chain, origin: all[chain] });
          }
        } else if (type === 'set-server') {
          // The person's own ElectrumX server (or null for Firo's servers): from the next page load on, in connect-src.
          const raw = event.data.server;
          const n = raw == null ? null : normalizeServerAddress(raw);
          if (n && !n.ok) port.postMessage({ result: 'refused', reason: n.error });
          else {
            await writeOwnServer(n ? n.address : null);
            port.postMessage({ result: 'saved', server: n ? n.address : null });
          }
        } else {
          port.postMessage({ result: 'error', reason: 'unknown request' });
        }
      } catch (e) {
        port.postMessage({ result: 'error', reason: String((e && e.message) || e) });
      }
    })(),
  );
});

// ---------------------------------------------------------------- notifications (lib/notify.js)
//
// Everything a notification says is worked out by the page, on this device, from the wallet's own
// data; nothing comes from a server (there is no push subscription). Two things happen here:
//   - a tap on a notification opens the app (or brings it to front) at the screen it names: only
//     "#open=<screen>[&tx=<hex>]" within this app's scope, nothing else;
//   - when the browser wakes this worker for Periodic Background Sync (Chrome / Edge, an installed
//     app), the reminders the page left for later ('w:<id>:notify-reminders' in the app's own
//     store) that are due are shown, if notifications and "Reminders when Campfire is closed"
//     (prefs.notify.wakeUps) are still on, and then forgotten. With that switch off (the
//     default), a wake-up shows nothing and asks the browser for no more of them.

const OPEN_LINK = /^#open=[a-zA-Z]+(&tx=[0-9a-f]{1,128})?$/;
const APP_DB = 'campfire-firo-app';
const APP_STORE = 'kv';
const REMINDERS_SUFFIX = ':notify-reminders';
const SYNC_TAG = 'campfire-reminders'; // lib/notify.js SYNC_TAG

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const link = typeof data.url === 'string' && OPEN_LINK.test(data.url) ? data.url : '#open=home';
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const inScope = wins.filter((c) => c.url.startsWith(scopeUrl.href));
      if (inScope.length) {
        const c = inScope.find((w) => w.focused) || inScope[0];
        c.postMessage({ type: 'campfire-open', url: link });
        try {
          await c.focus();
        } catch {
          /* already in front, or not allowed: the message still opens the screen */
        }
        return;
      }
      await self.clients.openWindow(new URL(link, scopeUrl).href);
    })(),
  );
});

/** The app's own store, opened the way the app opens it (lib/store.js), so a first open here creates it the same. */
function appDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(APP_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(APP_STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('blocked'));
  });
}

const idb = (r) =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

async function showDueReminders(now = Date.now()) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return 0;
  const db = await appDb();
  try {
    const read = db.transaction(APP_STORE, 'readonly').objectStore(APP_STORE);
    const prefs = (await idb(read.get('prefs'))) || {};
    const n = prefs.notify || {};
    const on = n.on === true || (n.on === undefined && prefs.paymentNotifications === true);
    if (n.wakeUps !== true || !on) {
      // Not turned on (an earlier release asked for wake-ups by itself), or notifications are off: no more of them.
      if (self.registration.periodicSync) await self.registration.periodicSync.unregister(SYNC_TAG).catch(() => {});
      return 0;
    }
    const keys = (await idb(read.getAllKeys(IDBKeyRange.bound('w:', 'w:\uffff')))).filter((k) => typeof k === 'string' && k.endsWith(REMINDERS_SUFFIX));
    let shown = 0;
    for (const k of keys) {
      const list = (await idb(db.transaction(APP_STORE, 'readonly').objectStore(APP_STORE).get(k))) || [];
      const due = list.filter((r) => r && r.at <= now);
      if (!due.length) continue;
      for (const r of due) {
        const kindOn = !n.kinds || n.kinds[r.kind] !== false;
        if (!on || !kindOn) continue;
        await self.registration.showNotification(String(r.title).slice(0, 120), {
          body: String(r.body || '').slice(0, 240),
          tag: `campfire-${String(r.id).slice(0, 100)}`,
          icon: 'icons/icon-192.png',
          lang: 'en',
          data: { url: OPEN_LINK.test(r.url) ? r.url : '#open=home' },
        });
        shown++;
      }
      const keep = list.filter((r) => r && r.at > now);
      await idb(db.transaction(APP_STORE, 'readwrite').objectStore(APP_STORE).put(keep, k));
    }
    if (shown && self.navigator && typeof self.navigator.setAppBadge === 'function') self.navigator.setAppBadge(shown).catch(() => {});
    return shown;
  } finally {
    db.close();
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(showDueReminders().catch(() => 0));
});

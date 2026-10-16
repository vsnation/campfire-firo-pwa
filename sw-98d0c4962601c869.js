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

const RELEASE_PUBLIC_JWK = {"kty":"EC","crv":"P-256","x":"IBYdPwiOE1bGU9-SZHlgx3iwDmlcsgIeXk-hDE-DW3Q","y":"MW3DhEKtl4oh8dGwH57rQZCagrX4gkKMjwBES6QxcUE"};
const SECURITY_HEADERS = {"Cross-Origin-Opener-Policy":"same-origin","Cross-Origin-Embedder-Policy":"require-corp","Cross-Origin-Resource-Policy":"same-origin","Content-Security-Policy":"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' wss://electrumx.firo.org:50004 wss://electrumx01.firo.org:50004 wss://electrumx02.firo.org:50004 wss://electrumx03.firo.org:50004 https://eth2.stackwallet.com https://ethereum-rpc.publicnode.com https://eth.drpc.org https://rpc.mevblocker.io https://eth-mainnet.public.blastapi.io https://mainnet.gateway.tenderly.co https://eth.blockrazor.xyz https://bsc-dataseed.bnbchain.org https://bsc.nodereal.io https://bsc-dataseed1.defibit.io https://bsc-dataseed1.ninicoin.io https://1rpc.io/bnb https://bsc-mainnet.public.blastapi.io https://bsc.rpc.blxrbdn.com https://bsc.blockrazor.xyz https://api.coingecko.com/api/v3/simple/price https://buyfiro.app/api/v1/buy/ https://buyfiro.app/api/v1/sell/ https://1click.chaindefuser.com/v0/; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff","Permissions-Policy":"camera=(self), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()","Strict-Transport-Security":"max-age=31536000"};
const MIME = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json",".webmanifest":"application/manifest+json",".wasm":"application/wasm",".svg":"image/svg+xml",".png":"image/png",".ttf":"font/ttf",".woff2":"font/woff2",".txt":"text/plain; charset=utf-8",".sig":"text/plain; charset=utf-8",".jwk":"application/json"};

// ---- inlined from lib/release.js
// Signed releases. Shared by the service worker (the build inlines this file
// into sw.js), the build (which signs) and the unit tests. No imports, so it
// can be inlined; only WebCrypto, available in browsers, workers and Node 22.
//
// A deployment carries three files:
//   manifest.json  {"app","version","files":[{"path","sha256","size"}, ...]}
//   release.json   {"app","version","created","manifest_sha256","file_count",
//                   "loader","loader_compat","update_sources","engine"}
//   release.sig    base64 of the ECDSA P-256 / SHA-256 signature (IEEE P1363,
//                  r||s, 64 bytes, the format WebCrypto produces and Safari
//                  verifies) over the exact bytes of release.json.
// The app trusts a release only when the signature verifies under the public
// key built into it, manifest.json hashes to manifest_sha256, and every file
// matches its size and SHA-256.

const RELEASE_APP_ID = 'campfire-firo-pwa';

class ReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'bad_signature' | 'malformed' | 'manifest_mismatch' | 'file_mismatch' | 'downgrade' | 'test_build' | 'unreachable'
  }
}

function bytesToHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

async function sha256Hex(data) {
  const buf = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)));
}

function b64ToBytes(s) {
  const bin = atob(String(s).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importReleaseKey(publicJwk) {
  if (!publicJwk || publicJwk.kty !== 'EC' || publicJwk.crv !== 'P-256' || publicJwk.d)
    throw new ReleaseError('malformed', 'Release key must be a public P-256 JWK.');
  const { kty, crv, x, y } = publicJwk;
  return crypto.subtle.importKey('jwk', { kty, crv, x, y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

/** Compares "1.2.3" style versions. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Verifies release.json bytes against release.sig with the embedded key.
 * Returns the parsed release object.
 */
async function verifyReleaseSignature(releaseBytes, sigText, publicJwk) {
  const key = await importReleaseKey(publicJwk);
  let sig;
  try {
    sig = b64ToBytes(sigText);
  } catch {
    throw new ReleaseError('bad_signature', 'The release signature is not readable.');
  }
  const ok = sig.length === 64 && (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, releaseBytes));
  if (!ok) throw new ReleaseError('bad_signature', 'This update is not signed with the Campfire release key.');
  let rel;
  try {
    rel = JSON.parse(new TextDecoder().decode(releaseBytes));
  } catch {
    throw new ReleaseError('malformed', 'release.json is not JSON.');
  }
  if (rel.app !== RELEASE_APP_ID || typeof rel.version !== 'string' || !/^[0-9a-f]{64}$/.test(rel.manifest_sha256 || ''))
    throw new ReleaseError('malformed', 'release.json is missing fields.');
  return rel;
}

/** Checks manifest.json bytes against a verified release; returns the manifest. */
async function verifyManifest(release, manifestBytes) {
  const h = await sha256Hex(manifestBytes);
  if (h !== release.manifest_sha256) throw new ReleaseError('manifest_mismatch', "This update's file list is not the one that was signed.");
  const m = JSON.parse(new TextDecoder().decode(manifestBytes));
  if (m.app !== RELEASE_APP_ID || m.version !== release.version || !Array.isArray(m.files))
    throw new ReleaseError('malformed', 'manifest.json does not belong to this release.');
  if (typeof release.file_count === 'number' && release.file_count !== m.files.length)
    throw new ReleaseError('manifest_mismatch', 'File count differs from the signed release.');
  const seen = new Set();
  for (const f of m.files) {
    if (typeof f.path !== 'string' || !/^[A-Za-z0-9._\-/]+$/.test(f.path) || f.path.includes('..') || f.path.startsWith('/'))
      throw new ReleaseError('malformed', `Bad file path in manifest: ${f.path}`);
    if (seen.has(f.path)) throw new ReleaseError('malformed', `Duplicate path ${f.path}`);
    seen.add(f.path);
    if (!/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size < 0)
      throw new ReleaseError('malformed', `Bad entry for ${f.path}`);
  }
  return m;
}

/** Checks one downloaded file against its manifest entry. */
async function verifyFile(entry, bytes) {
  const len = bytes.byteLength;
  if (len !== entry.size) throw new ReleaseError('file_mismatch', `A file in this update (${entry.path}) is not the one that was signed.`);
  const h = await sha256Hex(bytes);
  if (h !== entry.sha256) throw new ReleaseError('file_mismatch', `A file in this update (${entry.path}) is not the one that was signed.`);
}

// ---- end of lib/release.js

// ---- inlined from lib/update_sources.js
// Where "Check for updates" looks for a newer signed release, and how it picks
// one. Shared by the service worker (the build inlines this file into sw.js,
// after lib/release.js, whose names it uses), the page (an address the person
// adds) and the unit tests. The only import is lib/release.js; the build drops
// that line when inlining.
//
// Every source is held to the same checks (lib/release.js): the signature under
// the key built into the app, the manifest hash, every file's size and SHA-256,
// the app id, and a version strictly newer than the one installed. So where the
// bytes come from does not decide what runs; it only decides whether an update
// can be found at all once the app's own address is gone.
//
// Sources: this app's own address, then the copies below (or the list the
// installed, signed release names), then an address the person added. A tapped
// check asks every one of them (at once, each with its own time limit) and keeps
// the newest signed release; on a tie, the own address's copy. So an address
// that keeps serving an old signed release (frozen, or taken over) cannot hide a
// newer one that a copy has. A source that does not answer, sends no CORS
// headers, sends something unsigned or altered, or is behind the installed
// version is noted. Each answer carries its signed release date (created), so
// the page can say when the newest release it found is old.

// Public copies of the published release: the signed build of each release is pushed to the
// `release` branch of github.com/vsnation/campfire-firo-pwa (its main branch holds the source),
// which GitHub Pages also serves. Each serves every file with Access-Control-Allow-Origin: *.
// They serve updates only: the app refuses to run from any of them (lib/shared_host.js, H9).
// Fresher first: raw.githubusercontent.com caches 5 min, GitHub Pages 10 min, jsDelivr up to 12 h.
// tools/build.mjs writes this list into release.json (signed), and the loader
// prefers the installed release's list, so a release can change it without a
// new loader.
const BUILTIN_SOURCES = Object.freeze([
  'https://raw.githubusercontent.com/vsnation/campfire-firo-pwa/release/',
  'https://vsnation.github.io/campfire-firo-pwa/',
  'https://cdn.jsdelivr.net/gh/vsnation/campfire-firo-pwa@release/',
]);

const MAX_SOURCE_LENGTH = 2000;
const MAX_RELEASE_SOURCES = 10;
const MAX_ADDED_SOURCES = 3;

/**
 * An address the person typed or pasted, as the folder a copy is served from:
 * https only, no user name or password, no query or fragment, a trailing slash.
 * An address typed without a scheme ("example.org/campfire") gets https, and
 * a link to the copy's index.html or release.json means its folder.
 * Returns {ok: true, url} or {ok: false, reason}.
 */
function normalizeSource(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return { ok: false, reason: 'Paste the address of a copy of Campfire.' };
  if (s.length > MAX_SOURCE_LENGTH) return { ok: false, reason: 'That address is too long.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: "That isn't a web address." };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'Use an address that starts with https://.' };
  if (u.username || u.password) return { ok: false, reason: 'Leave out the user name and password: the address must work without them.' };
  if (!u.hostname) return { ok: false, reason: "That isn't a web address." };
  u.hash = '';
  u.search = '';
  u.pathname = u.pathname.replace(/\/(index\.html|release\.json|release\.sig|manifest\.json)$/i, '/');
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return { ok: true, url: u.href };
}

/** The list a signed release names (release.json update_sources), cleaned; null when it names none. */
function releaseSources(release) {
  if (!release || !Array.isArray(release.update_sources)) return null;
  const out = [];
  for (const s of release.update_sources.slice(0, MAX_RELEASE_SOURCES)) {
    if (typeof s !== 'string') continue;
    const n = normalizeSource(s);
    if (n.ok && !out.includes(n.url)) out.push(n.url);
  }
  return out;
}

/**
 * Every place to ask, in order, each once: {url, host, kind: 'own'|'builtin'|'added', own}.
 * own is the app's own folder (the service worker's scope).
 */
function updateSources({ own, builtins = BUILTIN_SOURCES, added = [] }) {
  const out = [];
  const seen = new Set();
  const push = (url, kind) => {
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, host: new URL(url).host, kind, own: kind === 'own' });
  };
  push(new URL(own).href, 'own');
  for (const b of builtins || []) {
    const n = normalizeSource(b);
    if (n.ok) push(n.url, 'builtin');
  }
  for (const a of (added || []).slice(0, MAX_ADDED_SOURCES)) {
    if (typeof a !== 'string') continue;
    const n = normalizeSource(a);
    if (n.ok) push(n.url, 'added');
  }
  return out;
}

// Hosts that are never a public deployment: localhost and RFC 2606's reserved .test names. The
// same rule as lib/chain.js isTestHost (test/unit/release_engine.test.mjs checks they agree);
// a copy here because this file is inlined into the loader, which imports nothing.
const TEST_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const isTestHostname = (host) => TEST_HOSTS.has(host) || /\.test$/.test(String(host || ''));

/**
 * Whether a release may be installed at this address (hostname: the loader's own). A build with
 * the stand-in engine (release.json engine: 'fake', tools/build.mjs --engine fake: sample
 * balances, no Firo network) is signed like a release, so the signature alone cannot keep it off
 * a real address: it installs only on a test host. A release that names no engine predates the
 * field and is real.
 */
function engineAllowed(release, hostname) {
  const engine = release && release.engine !== undefined ? release.engine : 'real';
  return engine === 'real' || isTestHostname(hostname);
}

/**
 * Whether a release can run under the loader that is running now. A service
 * worker can only come from the app's own address, so a release from anywhere
 * else runs under the current loader until that address answers again. That
 * is safe when the release ships this very loader, or one that serves pages
 * exactly as this one does: the same security headers, MIME types and
 * page <-> loader contract (the build hashes those into
 * loader_compat; sw.js holds its own value).
 */
function loaderCompatible(release, loader) {
  if (!release || !loader || typeof release.loader !== 'string') return false;
  if (release.loader === loader.name) return true;
  return typeof release.loader_compat === 'string' && Boolean(loader.compat) && release.loader_compat === loader.compat;
}

/**
 * release.json, its signature and manifest.json from one source, verified.
 * get(path) returns the bytes. Something that is not this app's release.json
 * at all (a parking page, another app, an error page) means there is no
 * release there: 'unreachable', not 'refused'. A release.json that names this
 * app but fails the signature or the manifest hash is refused.
 */
async function readRelease(get, publicJwk) {
  const relBytes = await get('release.json');
  let claimed = null;
  try {
    claimed = JSON.parse(new TextDecoder().decode(relBytes));
  } catch {
    claimed = null;
  }
  if (!claimed || claimed.app !== RELEASE_APP_ID) throw new ReleaseError('unreachable', 'No Campfire release is published at this address.');
  const sig = new TextDecoder().decode(await get('release.sig'));
  const release = await verifyReleaseSignature(relBytes, sig, publicJwk);
  const manifest = await verifyManifest(release, await get('manifest.json'));
  return { release, manifest };
}

const reasonOf = (e) => String((e && e.message) || e || 'unknown error');
const isUnreachable = (e) => !e || !e.code || e.code === 'unreachable';
/** A release's signed date (release.json created) when it is one; else null. */
const createdOf = (release) => (release && typeof release.created === 'string' && Number.isFinite(Date.parse(release.created)) ? release.created : null);

/**
 * Asks every source, keeps the newest signed release and stages it.
 * installed/pending: {version, manifestSha} (installed also {created}, pending
 * also {from}); loader: {name, compat}. fetchRelease(source) -> {release,
 * manifest}; stage(source, rel) downloads and verifies every file (and throws
 * on the first that fails). onSource(source) when a source is asked,
 * onAnswer(source) when it has answered (or failed to).
 *
 * The newest version newer than the installed one is staged, from the own
 * address when it has it, else from the first copy in order that has it; when
 * that fails, the next source with it, then older ones. Nothing is staged from
 * a source other than the own address when the release could not run under the
 * current loader.
 *
 * Returns {result, version?, reason?, from?: {host, own}, newest: {version,
 * created}, ownVersion?, tried: [...] (in source order)}, where result is
 * 'ready' (a newer release is verified and waiting for Update), 'none'
 * (nothing newer anywhere that answered), 'needs_own_address' (newer, but only
 * installable from the own address), 'refused' (a newer release could not be
 * had intact, or only altered or unsigned releases answered) or 'unreachable'
 * (no release answered at all). newest is the newest signed release any source
 * (or the installed copy) knows of, with its date; ownVersion is what the own
 * address served, when it served a signed release.
 */
async function findUpdate({ sources, installed, pending = null, loader, fetchRelease, stage, onSource = null, onAnswer = null }) {
  const notes = new Array(sources.length).fill(null);
  const note = (i, outcome, extra = {}) => {
    const src = sources[i];
    notes[i] = { host: src.host, kind: src.kind, own: src.own, outcome, ...extra };
    return notes[i];
  };
  const from = (t) => ({ host: t.host, own: t.own });
  const answers = await Promise.all(
    sources.map(async (src) => {
      if (onSource) await onSource(src);
      try {
        return { rel: await fetchRelease(src) };
      } catch (e) {
        return { error: e };
      } finally {
        if (onAnswer) await onAnswer(src);
      }
    }),
  );

  let newest = { version: installed.version, created: installed.created || null };
  let ownVersion;
  let refused = null; // a fetch refused: unsigned, altered list, a look-alike of the installed version
  let same = null;
  let behind = false;
  const candidates = [];
  answers.forEach((a, i) => {
    const src = sources[i];
    if (a.error) {
      const t = note(i, isUnreachable(a.error) ? 'unreachable' : 'refused', { reason: reasonOf(a.error) });
      if (t.outcome === 'refused' && !refused) refused = t;
      return;
    }
    const v = a.rel.release.version;
    const created = createdOf(a.rel.release);
    if (src.own) ownVersion = v;
    const cmp = compareVersions(v, newest.version);
    if (cmp > 0 || (cmp === 0 && created && (!newest.created || src.own))) newest = { version: v, created };
    const vs = compareVersions(v, installed.version);
    if (vs < 0) {
      note(i, 'older', { version: v });
      behind = true;
    } else if (vs === 0 && a.rel.release.manifest_sha256 !== installed.manifestSha) {
      const t = note(i, 'refused', { version: v, reason: `A different release claims version ${v}.` });
      if (!refused) refused = t;
    } else if (vs === 0) {
      const t = note(i, 'same', { version: v });
      if (!same || (src.own && !same.own)) same = t;
    } else {
      note(i, 'not_needed', { version: v }); // newer; replaced below by what happened to it
      candidates.push({ i, src, rel: a.rel, v });
    }
  });
  // Newest first; for one version the own address first, then the copies in order.
  candidates.sort((a, b) => compareVersions(b.v, a.v) || Number(b.src.own) - Number(a.src.own) || a.i - b.i);

  let blocked = null;
  let failedNewer = null;
  for (const c of candidates) {
    const { i, src, rel, v } = c;
    if (pending && pending.version === v && pending.manifestSha === rel.release.manifest_sha256) {
      const t = note(i, 'ready', { version: v });
      return { result: 'ready', version: v, from: pending.from || from(t), newest, ownVersion, tried: notes };
    }
    if (!src.own && !loaderCompatible(rel.release, loader)) {
      const t = note(i, 'needs_own_address', { version: v });
      if (!blocked) blocked = t;
      continue;
    }
    try {
      await stage(src, rel);
    } catch (e) {
      const t = note(i, isUnreachable(e) ? 'unreachable' : 'refused', { version: v, reason: reasonOf(e) });
      if (t.outcome === 'refused' && !failedNewer) failedNewer = t;
      continue;
    }
    const t = note(i, 'ready', { version: v });
    return { result: 'ready', version: v, from: from(t), created: createdOf(rel.release), newest, ownVersion, tried: notes };
  }
  if (blocked) return { result: 'needs_own_address', version: blocked.version, from: from(blocked), newest, ownVersion, tried: notes };
  // A newer signed release exists but could not be had intact: not "up to date".
  if (failedNewer) return { result: 'refused', version: failedNewer.version || null, reason: failedNewer.reason, from: from(failedNewer), newest, ownVersion, tried: notes };
  if (same) return { result: 'none', version: installed.version, from: from(same), newest, ownVersion, tried: notes };
  if (refused) return { result: 'refused', version: refused.version || null, reason: refused.reason, from: from(refused), newest, ownVersion, tried: notes };
  if (behind) return { result: 'none', version: installed.version, newest, ownVersion, tried: notes };
  return { result: 'unreachable', newest, tried: notes };
}

// ---- end of lib/update_sources.js

// ---- inlined from lib/server_address.js
// The person's own ElectrumX server: "host:port" and nothing else, reached over wss://.
// Shared by the page (lib/servers.js, screens/servers.js) and the service worker: the build
// inlines this file into sw.js, so it imports nothing. The worker runs every address through
// normalizeServerAddress before it goes into a Content-Security-Policy, so nothing but
// [a-z0-9.-], one colon and a port can ever reach that header.

const SERVER_EXAMPLE = 'electrum.example.com:50004';
/** ElectrumX's usual secure WebSocket port, used when none is typed. */
const DEFAULT_WSS_PORT = 50004;

const fail = (code, error) => ({ ok: false, code, error });

function validIPv4(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255);
}

function validHostname(host) {
  if (host.length > 253) return false;
  const labels = host.split('.');
  // An all-digit last label would be read as a (shortened) IPv4 address.
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return false;
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/**
 * "wss://Electrum.Example.com:50004/" -> {ok: true, address: "electrum.example.com:50004", host, port}.
 * A missing port is ElectrumX's wss port, 50004. Refused, each with a plain sentence: a scheme
 * other than wss://, a user name or password, a path, query or fragment, IPv6 (CSP host sources
 * cannot name one), an out-of-range port, anything that is not a host name or an IPv4 address.
 */
function normalizeServerAddress(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return fail('empty', `Type your server's address, for example ${SERVER_EXAMPLE}.`);
  if (/^wss:\/\//i.test(s)) s = s.slice(6);
  else if (/^(ws|tcp|ssl):\/\//i.test(s)) return fail('insecure', `A browser reaches ElectrumX over a secure WebSocket (wss) only. Type the host and its wss port, like ${SERVER_EXAMPLE}.`);
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return fail('scheme', `Leave out ${s.slice(0, s.indexOf('://') + 3)} and type only the host and port, like ${SERVER_EXAMPLE}.`);
  if (s.endsWith('/')) s = s.slice(0, -1);
  if (s.includes('@')) return fail('credentials', `Leave out the user name and password: type only the host and port, like ${SERVER_EXAMPLE}.`);
  if (/[/?#\\]/.test(s)) return fail('path', `Leave out everything after the port: type only the host and port, like ${SERVER_EXAMPLE}.`);
  if (/\s/.test(s)) return fail('host', `An address has no spaces. It looks like ${SERVER_EXAMPLE}.`);
  if (s.startsWith('[') || (s.match(/:/g) || []).length > 1) return fail('ipv6', "IPv6 addresses can't be used here. Use the server's host name or its IPv4 address.");
  const colon = s.lastIndexOf(':');
  let port = DEFAULT_WSS_PORT;
  let host = s;
  if (colon >= 0) {
    const portText = s.slice(colon + 1);
    if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) return fail('port', 'The port must be a number from 1 to 65535.');
    port = Number(portText);
    host = s.slice(0, colon);
  }
  host = host.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (/[^\x21-\x7e]/.test(host)) {
    // An international name: its ASCII (punycode) form is what DNS and the CSP use.
    try {
      host = new URL(`wss://${host}/`).hostname;
    } catch {
      host = '';
    }
  }
  const dotted = /^[0-9.]+$/.test(host);
  if (!host || (dotted ? !validIPv4(host) : !validHostname(host))) return fail('host', `That is not a host name or an IPv4 address. It looks like ${SERVER_EXAMPLE}.`);
  return { ok: true, address: `${host}:${port}`, host, port };
}

/** The WebSocket origin of a checked address: "wss://host:port". */
function serverOrigin(address) {
  const n = normalizeServerAddress(address);
  if (!n.ok) throw new Error('not a server address');
  return `wss://${n.address}`;
}

/** `csp` with the person's own server added to connect-src, and nothing else changed. null: `csp` itself. */
function cspWithServer(csp, address) {
  if (address == null) return csp;
  const origin = serverOrigin(address);
  return csp
    .split('; ')
    .map((d) => (d.startsWith('connect-src ') && !d.split(' ').includes(origin) ? `${d} ${origin}` : d))
    .join('; ');
}

// ---- end of lib/server_address.js

// ---- inlined from lib/evm_server_address.js
// The person's own Ethereum or BNB Chain server: one address per chain, "Server address (https://…)".
// Shared by the page (lib/servers.js, lib/eth/hosts.js, the server screen) and the service worker:
// the build inlines this file into sw.js, so it imports nothing. The worker runs every address
// through normalizeEvmServer before its origin goes into a Content-Security-Policy, and puts only
// that origin there (scheme, host, port: never a path, a query or a wildcard), so nothing but
// [a-z0-9.-], one colon and a port can reach that header (cspWithEvmServers).
//
// What is accepted, and why:
//   - https:// only. http:// only for a node on this device: localhost or 127.0.0.1 (browsers treat
//     both as secure, and nothing leaves the device). [::1] is this device too, but a CSP host
//     source cannot name an IPv6 address: it is taken as localhost (the same node; said).
//     With no scheme typed: https://, or http:// for localhost and 127.0.0.1.
//   - A host name (an international one in its ASCII form, which is what the browser and the CSP
//     use, and what the screen shows back) or an IPv4 address written plainly (no 0x7f.1, 2130706433,
//     127.1: the browser would read those as another address than the one shown).
//   - Any port. A path and a query, as providers give them (an API key is often one): they stay in
//     the request URL only. Nothing the browser would rewrite ("..", "./", %2e, characters outside
//     plain ASCII): the address used is exactly the one typed.
//   - Refused: a user name or password (anything with @), a fragment (#), spaces and backslashes,
//     other schemes (ws, wss, javascript, data, ...), IPv6 other than [::1], 0.0.0.0.

const EVM_SERVER_EXAMPLE = 'https://eth.example.com';
/** The chains a server can be added for, with their chain ids (lib/eth/chains.js has the same). */
const EVM_SERVER_CHAINS = Object.freeze({ ethereum: 1, bsc: 56 });
const MAX_EVM_SERVER_URL = 2048;
/** Where the page keeps each chain's choice (prefs): a listed server's id, or EVM_OWN with the address under `url`. */
const EVM_SERVER_PREFS = Object.freeze({ ethereum: Object.freeze({ pick: 'ethRpc', url: 'ethRpcUrl' }), bsc: Object.freeze({ pick: 'bscRpc', url: 'bscRpcUrl' }) });
/** The pick that means "the person's own server". */
const EVM_OWN = 'custom';

const EVM_LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const evmFail = (code, error) => ({ ok: false, code, error });
const EVM_SCHEMES = 'Use an address that starts with https:// (or http:// for a node on this device: localhost or 127.0.0.1).';

function evmIPv4(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p) && Number(p) <= 255) && parts[0] !== '0';
}

function evmHostname(host) {
  if (host.length > 253) return false;
  const labels = host.split('.');
  // An all-digit last label would be read as a (shortened) IPv4 address.
  if (/^[0-9]+$/.test(labels[labels.length - 1])) return false;
  return labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/**
 * "https://Eth.Example.com:8545/v3/KEY" -> {ok: true, url: "https://eth.example.com:8545/v3/KEY",
 * origin: "https://eth.example.com:8545", host, port, local, note}. local: a node on this device.
 * note: a sentence when the address was taken in another form ([::1] -> localhost), else null.
 * Refused: {ok: false, code, error} with a plain sentence.
 */
function normalizeEvmServer(input) {
  let s = String(input == null ? '' : input).trim();
  if (!s) return evmFail('empty', `Type your server's address, for example ${EVM_SERVER_EXAMPLE}.`);
  if (s.length > MAX_EVM_SERVER_URL) return evmFail('long', 'That address is too long for a server address.');
  if (/[\s\\]|[\x00-\x1f\x7f]/.test(s)) return evmFail('chars', 'An address has no spaces or backslashes. Paste it as your provider gives it.');
  let scheme = null;
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (m) {
    scheme = m[1].toLowerCase();
    if (scheme !== 'https' && scheme !== 'http') return evmFail('scheme', EVM_SCHEMES);
    s = s.slice(m[0].length);
  }
  if (s.includes('@')) return evmFail('credentials', 'Leave out any user name and password (the part before @): Campfire sends none.');
  if (s.includes('#')) return evmFail('fragment', 'Leave out the # and everything after it.');
  const cut = s.search(/[/?]/);
  const authority = cut < 0 ? s : s.slice(0, cut);
  let rest = cut < 0 ? '' : s.slice(cut);
  if (rest.startsWith('?')) rest = `/${rest}`;
  if (!authority) return evmFail('host', `That is not a server address. It looks like ${EVM_SERVER_EXAMPLE}.`);
  let rawHost;
  let portText;
  if (authority.startsWith('[')) {
    const v6 = /^\[([^\]]*)\](?::(.*))?$/.exec(authority);
    if (!v6) return evmFail('host', `That is not a server address. It looks like ${EVM_SERVER_EXAMPLE}.`);
    rawHost = `[${v6[1].toLowerCase()}]`;
    portText = v6[2];
    if (rawHost !== '[::1]') return evmFail('ipv6', "IPv6 addresses can't be used here (the browser's rules cannot name them). Use the server's host name.");
  } else {
    if ((authority.match(/:/g) || []).length > 1) return evmFail('ipv6', "IPv6 addresses can't be used here (the browser's rules cannot name them). Use the server's host name.");
    const colon = authority.indexOf(':');
    rawHost = (colon < 0 ? authority : authority.slice(0, colon)).toLowerCase();
    portText = colon < 0 ? undefined : authority.slice(colon + 1);
  }
  let port = null;
  if (portText !== undefined) {
    if (!/^[0-9]{1,5}$/.test(portText) || Number(portText) < 1 || Number(portText) > 65535) return evmFail('port', 'The port (after the colon) must be a number from 1 to 65535.');
    port = Number(portText);
  }
  const local = EVM_LOCAL_HOSTS.has(rawHost);
  if (!scheme) scheme = local ? 'http' : 'https';
  if (scheme === 'http' && !local) return evmFail('insecure', 'Use https://. Only a node on this device (localhost or 127.0.0.1) may use http://.');
  let host = rawHost;
  let note = null;
  if (rawHost === '[::1]') {
    host = 'localhost';
    note = 'Saved as localhost: the same node on this device ([::1] cannot be named in the browser\'s rules).';
  } else if (/[^\x21-\x7e]/.test(rawHost)) {
    // An international name: its ASCII (punycode) form is what DNS, the browser and the CSP use.
    try {
      host = new URL(`https://${rawHost}/`).hostname;
    } catch {
      host = '';
    }
  }
  const dotted = /^[0-9.]+$/.test(host);
  if (!host || (dotted ? !evmIPv4(host) : !evmHostname(host))) return evmFail('host', `That is not a host name or an IPv4 address. It looks like ${EVM_SERVER_EXAMPLE}.`);
  // The path and query exactly as typed: plain ASCII, no dot segments, nothing a browser rewrites.
  if (/[^\x21-\x7e]/.test(rest)) return evmFail('path', 'The part after the host may hold plain letters, digits and punctuation only.');
  const path = rest.split('?')[0];
  if (/(^|\/)\.{1,2}(\/|$)/.test(path) || /%2e/i.test(path)) return evmFail('path', 'Leave out "./" and "../" in the address: type it as your provider gives it.');
  const defaultPort = scheme === 'https' ? 443 : 80;
  const shownPort = port !== null && port !== defaultPort ? `:${port}` : '';
  const candidate = `${scheme}://${host}${shownPort}${rest || '/'}`;
  let u;
  try {
    u = new URL(candidate);
  } catch {
    return evmFail('host', `That is not a server address. It looks like ${EVM_SERVER_EXAMPLE}.`);
  }
  if (u.protocol !== `${scheme}:` || u.hostname !== host || u.username || u.password || u.hash || `${u.pathname}${u.search}` !== (rest || '/'))
    return evmFail('path', 'That address has parts a browser would change. Type it as your provider gives it.');
  const origin = u.origin;
  if (!/^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/.test(origin)) return evmFail('host', `That is not a server address. It looks like ${EVM_SERVER_EXAMPLE}.`);
  return { ok: true, url: u.href, origin, host, port: u.port ? Number(u.port) : null, local, note };
}

/** The origin (scheme, host, port) of a checked address, as connect-src names it. Throws for anything else. */
function evmServerOrigin(address) {
  const n = normalizeEvmServer(address);
  if (!n.ok) throw new Error('not a server address');
  return n.origin;
}

/**
 * `csp` with the person's own Ethereum / BNB Chain servers' origins added to connect-src (each once,
 * after what is there), and nothing else changed. `origins`: a list or {chain: origin}; null entries
 * are skipped. Throws when one is not an origin normalizeEvmServer gives back unchanged.
 */
function cspWithEvmServers(csp, origins) {
  const list = (Array.isArray(origins) ? origins : Object.values(origins || {})).filter((o) => o != null);
  if (!list.length) return csp;
  const add = list.map((o) => {
    const origin = evmServerOrigin(o);
    if (origin !== o) throw new Error('not an origin');
    return origin;
  });
  return csp
    .split('; ')
    .map((d) => {
      if (!d.startsWith('connect-src ')) return d;
      const have = d.split(' ');
      let out = d;
      for (const o of add) if (!have.includes(o) && !out.split(' ').includes(o)) out = `${out} ${o}`;
      return out;
    })
    .join('; ');
}

/** The own server's address `prefs` choose for `chain` (normalized), or null when a listed one is chosen. */
function ownEvmServerOf(prefs, chain) {
  const k = EVM_SERVER_PREFS[chain];
  if (!k || !prefs || prefs[k.pick] !== EVM_OWN) return null;
  const n = normalizeEvmServer(prefs[k.url]);
  return n.ok ? n : null;
}

/** {ethereum, bsc} with each value an origin normalizeEvmServer gives back unchanged, or null. Anything else is dropped. */
function cleanEvmOrigins(saved) {
  const out = {};
  for (const k of Object.keys(EVM_SERVER_CHAINS)) {
    const v = saved && typeof saved === 'object' ? saved[k] : null;
    let ok = null;
    if (typeof v === 'string') {
      const n = normalizeEvmServer(v);
      if (n.ok && n.origin === v) ok = v;
    }
    out[k] = ok;
  }
  return out;
}

// ---- end of lib/evm_server_address.js
// ---- inlined from lib/evm_server_check.js
// Is this an Ethereum / BNB Chain server the wallet can rely on? The same questions for a listed
// server (the server screen, from the page) and for the person's own server before it is saved
// (from the service worker, whose own policy may reach any https address: the page's may not reach
// an address it does not name yet). The build inlines this file into sw.js, so it imports nothing
// and holds no words for the screen (lib/eth/server_words.js has those).
//
// The questions, in order, each a plain JSON-RPC request with no address in it (the server sees
// the IP address and these questions, never which wallet asks):
//   1. eth_chainId: the chain the person added it for (1 Ethereum, 56 BNB Chain).
//   2. eth_getBlockByNumber('latest'): its newest block and that block's time: fresh when it is
//      at most FRESH_SECONDS old by this device's clock (generous for a clock that is off); how
//      long this answer took is the speed shown.
//   3. a receipt of a recent transaction: the first transaction of a block a few below the newest
//      (eth_getBlockByNumber, then eth_getTransactionReceipt). A server that keeps receipts for
//      paying users only ("Archive requests require a personal token") can never show a payment
//      confirmed: refused.
//   4. eth_call: Multicall3's getBlockNumber() (the same contract address on both chains), which
//      must be near the newest block: it runs contract code against current state, as balances
//      and swap prices do.
// Reaching it at all also proves CORS: requests go as a web page's (mode cors, a JSON content
// type, so the browser asks first), and a server that does not allow pages fails like one that is
// down: the browser does not tell the two apart.

const EVM_CHECK_TIMEOUT_MS = 10000;
/** The newest block may be this old (seconds) by this device's clock before the server counts as behind. */
const FRESH_SECONDS = 600;
/** How many blocks below the newest are looked at for a transaction to ask the receipt of. */
const RECEIPT_LOOKBACK = 6;
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const GET_BLOCK_NUMBER = '0x42cbb15c'; // getBlockNumber()
const PAYING_USERS_ONLY = /archive requests require|personal token|api key|upgrade your plan|paid plan/i;
/** The only requests a check sends (release audit 0.1.5, N1: the worker is no relay for other requests). */
const CHECK_METHODS = Object.freeze(['eth_chainId', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_call']);
/** The most one answer of a check may be: a block's transaction hashes, a receipt (N5). */
const MAX_CHECK_ANSWER_BYTES = 4 * 1024 * 1024;

/** A response's body as text, refused past `max` bytes (announced or read). */
async function readCheckBody(res, max) {
  const announced = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('content-length')) : NaN;
  if (Number.isFinite(announced) && announced > max) return null;
  if (!res.body || typeof res.body.getReader !== 'function') {
    const t = await res.text();
    return t.length > max ? null : t;
  }
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.byteLength;
  }
  return new TextDecoder().decode(all);
}

class CheckError extends Error {
  constructor(code, message, rpcCode = null) {
    super(message);
    this.code = code;
    this.rpcCode = rpcCode;
  }
}

/**
 * call(method, params) -> the result, over fetchImpl, as EthRpc sends requests (no cookies, no
 * cache, no redirects, no referrer, a timeout). Errors carry a code: 'unreachable' (no answer, or
 * not allowed by CORS), 'timeout', 'busy' (429), 'http' (not JSON-RPC), 'rpc' (an error answer,
 * rpcCode and its message).
 */
function rpcCaller(fetchImpl, url, { timeoutMs = EVM_CHECK_TIMEOUT_MS } = {}) {
  let id = 0;
  return async function call(method, params = []) {
    if (!CHECK_METHODS.includes(method)) throw new CheckError('bad_answer', `not a check request: ${String(method).slice(0, 40)}`);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          mode: 'cors',
          signal: ctl.signal,
        });
      } catch {
        throw new CheckError(ctl.signal.aborted ? 'timeout' : 'unreachable', ctl.signal.aborted ? 'no answer in time' : 'not reachable');
      }
      if (res.status === 429) throw new CheckError('busy', 'too many requests');
      let text;
      try {
        text = await readCheckBody(res, MAX_CHECK_ANSWER_BYTES);
      } catch {
        throw new CheckError(ctl.signal.aborted ? 'timeout' : 'unreachable', 'stopped answering');
      }
      if (text === null) throw new CheckError('http', 'an answer far larger than any check needs');
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        throw new CheckError('http', `not a JSON-RPC answer (HTTP ${res.status})`);
      }
      if (!j || typeof j !== 'object' || Array.isArray(j)) throw new CheckError('http', 'not a JSON-RPC answer');
      if (j.error) {
        const e = j.error;
        throw new CheckError('rpc', typeof e.message === 'string' ? e.message.slice(0, 200) : 'error', typeof e.code === 'number' ? e.code : null);
      }
      if (!('result' in j)) throw new CheckError('http', 'an answer without a result');
      return j.result;
    } finally {
      clearTimeout(timer);
    }
  };
}

const hexNumber = (v) => (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? Number(BigInt(v)) : NaN);
const isHash = (v) => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);

/**
 * Asks one server the four questions. call: rpcCaller(...) or a stand-in; chainId: what it must
 * be on; now(): this device's clock (ms). Never throws. Returns a plain object (it crosses from the
 * service worker to the page):
 *   {ok, problem, chainId, head, headAge (s), ms, receipts, call, detail}
 * ok: every answer as it must be. problem: the first that was not, in the order asked:
 *   'unreachable' | 'timeout' | 'busy' | 'bad_answer' | 'wrong_chain' | 'stale' | 'receipts_refused'
 *   | 'receipts_missing' | 'no_transactions' | 'receipts_error' | 'call_failed' | null.
 * receipts: 'yes' | 'refused' | 'missing' (a mined transaction without one) | 'none' (no
 * transaction near the newest block to ask about) | 'error' | null (not asked).
 * call: 'yes' | 'wrong' (answered, far from the newest block) | 'error' | null.
 * detail: the server's own words for the problem, for whoever debugs it (never shown as the reason).
 */
async function checkEvmServer(call, { chainId, now = () => Date.now() } = {}) {
  const r = { ok: false, problem: null, chainId: null, head: null, headAge: null, ms: null, receipts: null, call: null, detail: null };
  const stop = (problem, e = null) => {
    r.problem = problem;
    if (e && e.message) r.detail = String(e.message).slice(0, 200);
    return r;
  };
  const transport = (e) => (e && (e.code === 'unreachable' || e.code === 'timeout' || e.code === 'busy') ? e.code : 'bad_answer');
  try {
    r.chainId = hexNumber(await call('eth_chainId', []));
  } catch (e) {
    return stop(transport(e), e);
  }
  if (!Number.isSafeInteger(r.chainId)) return stop('bad_answer');
  if (r.chainId !== chainId) return stop('wrong_chain');
  let latest;
  const t0 = now();
  try {
    latest = await call('eth_getBlockByNumber', ['latest', false]);
  } catch (e) {
    return stop(transport(e), e);
  }
  r.ms = Math.max(0, Math.round(now() - t0));
  const head = latest && typeof latest === 'object' ? hexNumber(latest.number) : NaN;
  const time = latest && typeof latest === 'object' ? hexNumber(latest.timestamp) : NaN;
  if (!Number.isSafeInteger(head) || !Number.isSafeInteger(time)) return stop('bad_answer');
  r.head = head;
  r.headAge = Math.round(now() / 1000 - time);
  // The receipt of a recent transaction (a few blocks below the newest: not every server has the newest one's yet).
  try {
    let hash = null;
    for (let b = head - 2, i = 0; b >= 0 && i < RECEIPT_LOOKBACK && !hash; b--, i++) {
      const blk = await call('eth_getBlockByNumber', [`0x${b.toString(16)}`, false]);
      const txs = blk && Array.isArray(blk.transactions) ? blk.transactions : [];
      const first = txs.length ? txs[0] : null;
      hash = isHash(first) ? first.toLowerCase() : first && isHash(first.hash) ? first.hash.toLowerCase() : null;
    }
    if (!hash) r.receipts = 'none';
    else {
      try {
        const rc = await call('eth_getTransactionReceipt', [hash]);
        if (rc === null) r.receipts = 'missing';
        else r.receipts = rc && typeof rc === 'object' && String(rc.transactionHash).toLowerCase() === hash && /^0x[01]$/.test(String(rc.status)) ? 'yes' : 'error';
      } catch (e) {
        r.receipts = e && PAYING_USERS_ONLY.test(e.message) ? 'refused' : 'error';
        if (!r.detail && e && e.message) r.detail = String(e.message).slice(0, 200);
      }
    }
  } catch (e) {
    r.receipts = 'error';
    if (!r.detail && e && e.message) r.detail = String(e.message).slice(0, 200);
  }
  try {
    const out = await call('eth_call', [{ to: MULTICALL3, data: GET_BLOCK_NUMBER }, 'latest']);
    const n = typeof out === 'string' && /^0x[0-9a-fA-F]{64}$/.test(out) ? Number(BigInt(out)) : NaN;
    r.call = Number.isSafeInteger(n) && Math.abs(n - head) <= 1000 ? 'yes' : 'wrong';
  } catch (e) {
    r.call = 'error';
    if (!r.detail && e && e.message) r.detail = String(e.message).slice(0, 200);
  }
  if (r.headAge > FRESH_SECONDS) return stop('stale');
  if (r.receipts === 'refused') return stop('receipts_refused');
  if (r.receipts === 'missing') return stop('receipts_missing');
  if (r.receipts === 'none') return stop('no_transactions');
  if (r.receipts !== 'yes') return stop('receipts_error');
  if (r.call !== 'yes') return stop('call_failed');
  r.ok = true;
  r.detail = null;
  return r;
}

// ---- end of lib/evm_server_check.js

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
const LOADER_API = 2;
// Hash of what this loader does to pages (security headers, MIME types, the
// own-server policy, LOADER_API), filled in by the build; release.json carries the
// same value for the release's own loader (see loaderCompatible()).
const LOADER_COMPAT = "d70d9607985328855e1fd9a16be7a3cb8e5a28cca5f68ce0e6c7ebe9c4bedd5a";
const LOADER_NAME = self.location.pathname.split('/').pop();

let stateCache = null;
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
  const c = await caches.open(META_CACHE);
  const r = await c.match(STATE_KEY);
  stateCache = r ? await r.json() : { current: null, pending: null };
  return stateCache;
}

async function writeState(st) {
  const c = await caches.open(META_CACHE);
  await c.put(STATE_KEY, new Response(JSON.stringify(st), { headers: { 'Content-Type': 'application/json' } }));
  stateCache = st;
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
  const rel = await readRelease((path) => fetchBytes(base, path, { signal, timeoutMs, max: MAX_META_BYTES }), RELEASE_PUBLIC_JWK);
  if (!engineAllowed(rel.release, self.location.hostname))
    throw new ReleaseError('test_build', 'This is a test build of Campfire (sample balances, no Firo network), not a release.');
  return rel;
}

const cacheNameFor = (release) => `campfire-${release.version}-${release.manifest_sha256.slice(0, 16)}`;

/**
 * Downloads and verifies every file of a release into its own cache.
 * Resumable: entries already in that cache are re-checked against the manifest
 * and kept. The cache is recorded as state.staging so cleanup keeps it, and it
 * is never served until it has become state.current (first install, every
 * file verified) or state.pending and then current (Update button).
 */
async function stageRelease({ release, manifest }, { base = scopeUrl, signal = null, report = null } = {}) {
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
  const map = {};
  for (const f of files) map[f.path] = f.sha256;
  return {
    version: release.version,
    cache: cacheName,
    files: map,
    manifestSha: release.manifest_sha256,
    created: createdOf(release), // the release's signed date, for "released ..." and the age warning
    verifiedAt: Date.now(),
    // Where the next check looks, from the signed release; the loader that ships with it; and
    // what that loader does to pages (see loaderCompatible()).
    sources: releaseSources(release),
    loader: typeof release.loader === 'string' ? release.loader : null,
    loaderCompat: typeof release.loader_compat === 'string' ? release.loader_compat : null,
  };
}

async function cleanup(st) {
  const keep = new Set([META_CACHE, st.current && st.current.cache, st.pending && st.pending.cache, st.staging].filter(Boolean));
  for (const name of await caches.keys()) if (name.startsWith('campfire-') && !keep.has(name)) await caches.delete(name);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const st = await readState();
      if (!st.current) {
        // First install: nothing is served until a signed release verified.
        installAbort = new AbortController();
        const signal = installAbort.signal;
        try {
          await writeProgress({ state: 'checking', done: 0, total: 0, doneBytes: 0, totalBytes: 0, error: null });
          const rel = await fetchVerifiedRelease(scopeUrl, { signal });
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
  const st = await readState();
  if (!st.current) return fetch(request); // not installed yet: no page is controlled by this worker then
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
  const st = await readState();
  if (!st.pending) return { result: 'none' };
  const p = st.pending;
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

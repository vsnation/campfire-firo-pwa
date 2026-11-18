// Which own Firo node and Ethereum / BNB Chain servers a wallet approved, sealed under that wallet's
// secret (outside security audit 2026-11-18, #3: the approval was a plain address in the same stored
// preferences as the node itself, so whoever could write the browser's storage could set both, and
// the wallet sent its addresses to their node at the next unlock).
//
// An approval is the address and an HMAC-SHA256 of it, keyed by HKDF-SHA256 of the wallet's secret
// (the one its password and passkey envelopes hold) with the wallet's id. Only a wallet that is open
// can make or check one; a locked wallet uses no own node or server at all.
//
//   trusted = { firo: 'host:port', ethereum: <url>, bsc: <url>, mac: { firo: hex, ... } }
//
// Works in browsers and in Node 22 (globalThis.crypto).

export const TRUST_KINDS = Object.freeze(['firo', 'ethereum', 'bsc']);
const SALT = 'campfire-firo-trust-v1';
const enc = new TextEncoder();

async function trustKey(dbPass, walletId) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(dbPass)), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode(SALT), info: enc.encode(String(walletId)) }, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
}

const message = (kind, address) => enc.encode(`${kind}\n${address}`);

function hexOf(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesOf(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const addressOf = (trusted, kind) => (trusted && typeof trusted === 'object' && typeof trusted[kind] === 'string' && trusted[kind] ? trusted[kind] : null);

/**
 * `trusted` with `kind` approved as `address` (or dropped, address null), sealed under the open
 * wallet's secret. The other approvals are kept as they are.
 */
export async function approve(dbPass, walletId, trusted, kind, address) {
  // i18n-ignore: callers approve only for the open wallet and a known kind; a programming error, never shown
  if (!dbPass) throw new Error('No open wallet to approve with.');
  // i18n-ignore: a programming error (an unknown kind), never shown
  if (!TRUST_KINDS.includes(kind)) throw new Error(`Not something a wallet approves: ${kind}`);
  const prev = trusted && typeof trusted === 'object' ? trusted : {};
  const mac = { ...(prev.mac && typeof prev.mac === 'object' ? prev.mac : {}) };
  const next = { ...prev };
  if (address) {
    next[kind] = String(address);
    mac[kind] = hexOf(await crypto.subtle.sign('HMAC', await trustKey(dbPass, walletId), message(kind, next[kind])));
  } else {
    delete next[kind];
    delete mac[kind];
  }
  next.mac = mac;
  return next;
}

/**
 * What the open wallet approved: {firo, ethereum, bsc} (each the address, or null), and `unsealed`:
 * the kinds with an address but no seal at all, as versions before 0.1.24 saved them. Those are
 * asked about once (screens/own_node_confirm.js); a seal that does not match is never used.
 */
export async function checkTrust(dbPass, walletId, trusted) {
  const out = { firo: null, ethereum: null, bsc: null, unsealed: [] };
  if (!dbPass || !trusted || typeof trusted !== 'object') return out;
  const macs = trusted.mac && typeof trusted.mac === 'object' ? trusted.mac : {};
  let key = null;
  for (const kind of TRUST_KINDS) {
    const address = addressOf(trusted, kind);
    if (!address) continue;
    const sig = bytesOf(macs[kind]);
    if (!Object.prototype.hasOwnProperty.call(macs, kind)) {
      out.unsealed.push(kind);
      continue;
    }
    if (!sig) continue;
    key = key || (await trustKey(dbPass, walletId));
    if (await crypto.subtle.verify('HMAC', key, sig, message(kind, address))) out[kind] = address;
  }
  return out;
}

/**
 * What the open wallet's secret approved: {walletId, firo, ethereum, bsc}. Set after an unlock,
 * cleared at a lock; nothing else makes a wallet use an own node or server (lib/wallets.js withTrust).
 */
let approved = null;

/** After an unlock (`checked`: checkTrust's answer), or (null) at a lock. */
export function setApproved(walletId, checked) {
  approved = walletId && checked ? { walletId, firo: checked.firo || null, ethereum: checked.ethereum || null, bsc: checked.bsc || null } : null;
}

/** The approvals of `record` while it is the open wallet; none otherwise. */
export function approvedFor(record) {
  return approved && record && approved.walletId === record.id ? approved : {};
}

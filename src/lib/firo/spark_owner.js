// Which diversifier a Spark address claims, read with this wallet's view key.
//
// A Spark address is bech32m over F4Grumble(d ‖ Q1 ‖ Q2), where d is the address's
// diversifier encrypted with a key only the owner's view key gives (sparkmobile
// a9d0789 keys.cpp Address::encode, IncomingViewKey::get_diversifier; util.cpp
// kdf_diversifier, diversifier_decrypt; f4grumble.cpp). Reading d back finds any
// address of this wallet, also one another wallet (Campfire) handed out and this
// one never showed.
//
// The decryption is not authenticated: any address gives some number. The
// answer is only a candidate; the caller makes the address for that diversifier
// with the Spark library and compares (backend whoseAddress), so a mistake here
// can only miss an address of this wallet, never claim one that is not.
import { bech32m } from '../../vendor/noble/scure-base/index.js';
import { sha512 } from '../../vendor/noble/noble-hashes/sha2.js';
import { concatBytes, utf8ToBytes } from './bytes.js';
import { SPARK_ADDRESS_BYTES } from './address.js';

const LABEL_PROTOCOL = 'SPARK';
const HASH_MODE_KDF = 3;
const LABEL_KDF_DIVERSIFIER = 'DIVERSIFIER';
const LABEL_F4GRUMBLE_G = 'SPARK_F4GRUMBLE_G';
const LABEL_F4GRUMBLE_H = 'SPARK_F4GRUMBLE_H';
const AES_BLOCK = 16;
const AES256_KEY = 32;
const SCALAR_BYTES = 32;

/** A size as CDataStream writes a uint64_t: 8 bytes, little-endian. */
function u64le(n) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

/** SparkUtils::kdf_diversifier(s1): the AES-256 key of the diversifier. Copies of s1 are wiped. */
export function diversifierKey(s1) {
  const label = utf8ToBytes(LABEL_KDF_DIVERSIFIER);
  const input = concatBytes(utf8ToBytes(LABEL_PROTOCOL), Uint8Array.of(HASH_MODE_KDF), u64le(label.length), label, u64le(AES256_KEY), u64le(s1.length), s1);
  const digest = sha512(input);
  const key = digest.slice(0, AES256_KEY);
  input.fill(0);
  digest.fill(0);
  return key;
}

function grumbleHash(label, network, i, u, size) {
  return sha512(concatBytes(utf8ToBytes(label), Uint8Array.of(network, i), u)).slice(0, size);
}

function xor(a, b) {
  const r = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) r[i] = a[i] ^ b[i];
  return r;
}

/** F4Grumble::decode: the address's bytes from the scrambled ones. */
export function f4Decode(network, input) {
  const lL = Math.floor(input.length / 2);
  const lR = input.length - lL;
  const c = input.slice(0, lL);
  const d = input.slice(lL);
  const y = xor(c, grumbleHash(LABEL_F4GRUMBLE_H, network, 1, d, lL));
  const x = xor(d, grumbleHash(LABEL_F4GRUMBLE_G, network, 1, y, lR));
  const a = xor(y, grumbleHash(LABEL_F4GRUMBLE_H, network, 0, x, lL));
  const b = xor(x, grumbleHash(LABEL_F4GRUMBLE_G, network, 0, a, lR));
  return concatBytes(a, b);
}

/**
 * The diversifier `address` claims under the full view key `fvk` (serialized
 * FullViewKey: s1 first), as a Number; null when it is no Spark address of `net`
 * or does not decrypt to one. Only a candidate: see above.
 */
export async function claimedDiversifier(address, fvk, net, subtle = globalThis.crypto && globalThis.crypto.subtle) {
  if (typeof address !== 'string' || !(fvk instanceof Uint8Array) || fvk.length < SCALAR_BYTES || !subtle) return null;
  let raw;
  try {
    const { prefix, words } = bech32m.decode(address.toLowerCase(), 200);
    if (prefix !== net.sparkHrp) return null;
    const scrambled = bech32m.fromWords(words);
    if (scrambled.length !== SPARK_ADDRESS_BYTES) return null;
    raw = f4Decode(net.sparkNetwork.charCodeAt(0), Uint8Array.from(scrambled));
  } catch {
    return null;
  }
  try {
    // Padded AES-256-CBC with a zero IV over one block: 8 bytes of diversifier and their padding.
    const raw32 = diversifierKey(fvk.subarray(0, SCALAR_BYTES));
    let key;
    try {
      key = await subtle.importKey('raw', raw32, { name: 'AES-CBC' }, false, ['decrypt']);
    } finally {
      raw32.fill(0);
    }
    const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(AES_BLOCK) }, key, raw.slice(0, AES_BLOCK)));
    if (plain.length !== 8) return null;
    const d = new DataView(plain.buffer, plain.byteOffset, 8).getBigUint64(0, true);
    return d <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(d) : null;
  } catch {
    return null; // the padding did not check out: not one of this wallet's
  }
}

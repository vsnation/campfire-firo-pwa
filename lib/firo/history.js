// The wallet's activity as WALLET_API's Tx list: transparent transactions
// read from our own history, Spark payments from what the spark client
// recognised as ours, merged where one transaction is both (a privatize that
// minted to our own Spark address; a Spark payment to our own transparent
// address). Amounts are BigInt here and satoshi strings in the result.
//
// Tx = { txid, height: number|null, time, confirmations,
//        direction: 'in'|'out'|'self',
//        kind: 'transparent'|'privatize'|'spark'|'spark-name'|'lelantus'|'coinbase'|'masternode',
//        amount, fee, memo?, counterparty?, toPublic?, parts? }
// parts: where the coins of a payment of ours went (Activity's details: owner 2026-11-18, a privatize
// with change read as more than was moved): {fromPublic, fromPrivate, toPrivateSelf, toPublicSelf,
// toOthers, changePublic, changePrivate, fee}, each a BigInt, 0n when none.
// toPublic: our own Spark payment, all of it to our own public addresses (FIRO made public, 0.1.21).
// heightApprox (number): a Spark entry whose block is known only roughly (found while restoring)
// has height null and heightApprox the block it is placed at; the screens say "about <date>".
// unsure: a payment of ours whose broadcast had no answer, not seen on the network yet (audit
// FM-1); dropped: one the network does not have (it did not go through: nothing left), or one the
// person let go (letGo: on the node in use's word alone, release re-audit 3 RE3-3); oneNode: one
// the node in use says it never received, with no second node to ask for an hour: the person may
// let it go (backend.letGo);
// unproven: in a block, says the node, with an output to us not proven yet (audit FE-1):
// confirmations 0 until it is.

import { NETWORKS } from './params.js';
import { addressToScript } from './address.js';

/**
 * A public transaction paying this wallet counts (confirmed, spendable) only once proven (audit
 * D-01, FE-1): its Merkle branch leads to the root of the header two nodes agree on, or the
 * person's own node says so. Not 'one-server' (no second node answered: 0.1.3 counted it; release
 * re-audit R1-3: the node in use alone could invent a payment the wallet then spent): such a record
 * is asked again.
 */
export const PROVEN = Object.freeze(new Set(['two-servers', 'own-node']));

/**
 * What counts in the balance and as confirmed: proven, or 'one-node' (0.1.20, owner's choice of the
 * Campfire way: its Merkle branch leads to the root of the header the node in use gives, and no second
 * node could be asked; Campfire believes its one node). Said as such on Home, and asked of a second
 * node again at every sync. A node that invents one can show it, never make it spendable: the network
 * refuses a payment of a coin that does not exist. Settling a payment of our own still needs PROVEN.
 */
export const COUNTED = Object.freeze(new Set([...PROVEN, 'one-node']));

/** Stage 3 (block 486,221): from here the masternode is paid the largest coinbase output (50 %, then 70 %). */
const MASTERNODE_LARGEST_FROM = { main: 486221, test: 84459 };

const PART_KEYS = ['fromPublic', 'fromPrivate', 'toPrivateSelf', 'toPublicSelf', 'toOthers', 'changePublic', 'changePrivate', 'backPrivate', 'fee'];
/** A payment's parts, every key present (0n when none). */
function parts(p) {
  const out = {};
  for (const k of PART_KEYS) out[k] = typeof p[k] === 'bigint' && p[k] > 0n ? p[k] : 0n;
  return out;
}

/**
 * A privatize of ours, once it is known how much of what it minted is this wallet's own (the Spark
 * side's coins, or its own record): the rest of the minted coins, and any public output to someone
 * else, went to others. Nothing to others: moved to the private balance (self), that amount.
 */
/** Where it went, all of it: what was taken is every part, or the parts are not shown (toApi). */
function addsUp(p) {
  return p.fromPublic + p.fromPrivate === p.toPrivateSelf + p.toPublicSelf + p.toOthers + p.changePublic + p.changePrivate + p.backPrivate + p.fee;
}

/**
 * A private payment of ours whose change (or the coin it made to our own Spark address) the Spark
 * side has not found yet: that much is on its way back to the private balance (audit of 0.1.26: the
 * details of a payment just sent left it out, so they did not add up).
 */
function withComingBack(p, ours) {
  const out = p.toPrivateSelf + p.toPublicSelf + p.toOthers + p.changePublic + p.changePrivate + p.fee;
  const taken = p.fromPublic + p.fromPrivate;
  if (ours && p.fromPrivate > 0n && taken > out) p.backPrivate = taken - out;
  return p;
}

function settlePrivatize(e, toSelf) {
  const p = e.parts;
  const minted = e.minted ?? 0n;
  const self = toSelf > minted ? minted : toSelf;
  p.toPrivateSelf = self;
  p.toOthers = (e.otherPublic ?? 0n) + (minted - self);
  e.direction = p.toOthers > 0n ? 'out' : 'self';
  e.amount = p.toOthers > 0n ? p.toOthers : self;
}

/**
 * Entries for transparent transactions.
 * records: Map txid → {decoded, height, time, firstSeen, inputs, proof?, dropped?}
 * isOwnScript(script) → bool
 * isChangeScript(script) → bool: one of this wallet's change addresses (a payment to itself counts only
 *   what went to its receiving address, not the change; outside audit 2026-11-18, #07)
 * pending: Map txid → {unsure?, oneNode?, letGo?}: this wallet's own payments not in a block yet (transparent.js).
 * selfMints: Map txid → BigInt: of a privatize this wallet made, what it minted to its own Spark
 *   address, as written down when it was sent (the Spark side finds those coins only later).
 * Returns Map txid → entry (BigInt amounts).
 */
export function transparentEntries({ net = NETWORKS.main, records, isOwnScript, isChangeScript = () => false, isBigScript = () => false, tipHeight, pending = new Map(), oneNode = false, selfMints = new Map() }) {
  const counted = oneNode ? COUNTED : PROVEN;
  const out = new Map();
  // Only an address the node will not list (second audit, N-6: any address let a lying node show a
  // payment received as one sent to ourselves).
  const ownAddress = (a) => {
    try {
      return isBigScript(addressToScript(a, net));
    } catch {
      return false;
    }
  };
  for (const [txid, r] of records) {
    const d = r.decoded;
    let ownIn = 0n;
    let allIn = 0n;
    let inputsKnown = true;
    let sender = null;
    d.vin.forEach((i, n) => {
      if (!i.txid) return; // coinbase, Spark or Lelantus input: no transparent value
      const parent = records.get(i.txid);
      const po = parent?.decoded.vout[i.vout];
      const fallback = r.inputs?.[n];
      let value = po ? po.value : fallback?.valueSat != null ? BigInt(fallback.valueSat) : null;
      // A coin whose own transaction is not held (spent from an address the node will not list, of
      // thousands of payments): ours by the node's word for its address (audit of 0.1.14, U-3: a
      // payment with change showed as money received).
      const mine = po ? isOwnScript(po.script) : Boolean(fallback?.address && ownAddress(fallback.address));
      if (value === null) inputsKnown = false;
      else allIn += value;
      if (mine) ownIn += value ?? 0n;
      else if (!sender) sender = po?.address ?? fallback?.address ?? null;
    });
    let ownOut = 0n;
    let changeOut = 0n; // of ownOut, what went to a change address
    let allOut = 0n;
    let otherOut = 0n;
    let minted = 0n;
    let firstOther = null;
    const others = []; // every address paid other than this wallet's (N12: "Paid before?" saw only the first)
    let largest = null;
    let ownLargest = false;
    for (const o of d.vout) {
      allOut += o.value;
      if (!largest || o.value > largest.value) largest = o;
      // Minted coins: whose, only the Spark side (or this wallet's own record) can tell; never a public payment.
      if (o.type === 'spark-mint') {
        minted += o.value;
        continue;
      }
      if (o.type === 'nulldata') continue;
      if (isOwnScript(o.script)) {
        ownOut += o.value;
        if (isChangeScript(o.script)) changeOut += o.value;
      }
      else {
        otherOut += o.value;
        if (!firstOther && o.address) firstOther = o.address;
        if (o.address && !others.includes(o.address)) others.push(o.address);
      }
    }
    if (largest && isOwnScript(largest.script)) ownLargest = true;

    const height = r.height > 0 ? r.height : null;
    // Paying us, in a block on the node's word only: not confirmed until proven, or counted on one
    // node's Merkle proof when no second node answers (FE-1; COUNTED).
    // A payment of ours still followed needs two nodes, as its coins do (transparent.js utxos).
    const unproven = height !== null && ownOut > 0n && !(pending.has(txid) ? PROVEN : counted).has(r.proof);
    const e = {
      txid,
      height,
      time: height ? r.time ?? r.firstSeen ?? null : r.firstSeen ?? r.time ?? null,
      confirmations: height && tipHeight && !unproven ? Math.max(0, tipHeight - height + 1) : 0,
      direction: 'in',
      kind: 'transparent',
      amount: 0n,
      fee: 0n,
      ownIn,
      ownOut,
      // Public outputs to anyone else (a payment to our own public address only has none: made public).
      otherOut,
    };
    const p = pending.get(txid);
    if (r.dropped) {
      e.dropped = true;
      if (p?.letGo) e.letGo = true;
      if (p?.letGo && Number.isFinite(p.letGoAt)) e.letGoAt = p.letGoAt;
    } else if (height === null) {
      if (p?.unsure) e.unsure = true;
      if (p?.oneNode) e.oneNode = true;
    }
    if (unproven) e.unproven = true;
    // Confirmed on the node in use's proof alone (COUNTED): said in Activity (audit of 0.1.20).
    else if (height !== null && ownOut > 0n && r.proof === 'one-node') e.oneNodeProof = true;
    const paidFee = ownIn > 0n && inputsKnown && d.vin.every((i) => i.txid) ? allIn - allOut : 0n;

    if (d.kind === 'coinbase') {
      e.kind = ownLargest && height !== null && height >= (MASTERNODE_LARGEST_FROM[net.id] ?? 0) ? 'masternode' : 'coinbase';
      e.amount = ownOut;
    } else if (d.kind === 'spark-spend') {
      // Spark → transparent. From someone else, unless the Spark side knows it as ours (merged later).
      e.kind = d.sparkName ? 'spark-name' : 'spark';
      e.amount = ownOut;
      // Paid out of a Spark balance into this wallet's public one: on the blockchain anyone sees what
      // arrived, so it is a public receipt, not a private one (outside audit 2026-11-18, #05).
      if (ownOut > 0n) e.inPublic = true;
      if (d.spark?.fee !== undefined) e.sparkFee = d.spark.fee;
    } else if (d.kind === 'spark-mint') {
      // Public → Spark. Who the Spark outputs are for only the Spark side can tell (merged later);
      // until then it counts as sent: the minted amount plus any public payment to others.
      e.kind = 'privatize';
      e.minted = minted;
      if (ownIn > 0n) {
        e.direction = 'out';
        e.amount = otherOut + minted;
        e.fee = paidFee;
        e.parts = parts({ fromPublic: ownIn, toPublicSelf: ownOut - changeOut, changePublic: changeOut, toOthers: otherOut + minted, fee: paidFee });
        e.otherPublic = otherOut;
        if (selfMints.has(txid)) settlePrivatize(e, selfMints.get(txid));
        // To a Spark address of someone else's: who, as written down when it was sent (audit X2).
        // Everyone paid: its Spark recipients, as written down, and its public ones (third audit F5:
        // the public recipient of a payment to both was missing).
        const sparkTo = Array.isArray(p?.toAll) && p.toAll.length ? p.toAll : p?.to ? [p.to] : [];
        const all = [...new Set([...sparkTo, ...others])];
        if (all.length) e.counterparty = all[0];
        if (all.length > 1) e.counterparties = all.slice(0, 20);
      } else {
        e.amount = ownOut;
        if (sender) e.counterparty = sender;
      }
    } else if (d.kind === 'lelantus') {
      e.kind = 'lelantus';
      e.direction = ownIn > 0n ? 'out' : 'in';
      e.amount = ownIn > 0n ? ownIn - ownOut : ownOut;
    } else if (ownIn > 0n) {
      e.fee = paidFee;
      e.parts = parts({ fromPublic: ownIn, toPublicSelf: ownOut - changeOut, changePublic: changeOut, toOthers: otherOut, fee: paidFee });
      if (otherOut === 0n) {
        e.direction = 'self';
        // What was paid to this wallet's own address, without the change (1 FIRO to itself from a 10
        // FIRO coin read 9.9999); all of it when everything went to change addresses.
        e.amount = ownOut - changeOut > 0n ? ownOut - changeOut : ownOut;
      } else {
        e.direction = 'out';
        e.amount = otherOut;
        if (firstOther) e.counterparty = firstOther;
        if (others.length > 1) e.counterparties = others.slice(0, 20);
      }
    } else {
      e.amount = ownOut;
      if (sender) e.counterparty = sender;
    }
    out.set(txid, e);
  }
  return out;
}

/**
 * Entries for Spark payments.
 * coins: [{txid (where received), value (BigInt), memo, isChange, spentTxid?, height?, heightApprox?, time?}]
 * sends: Map txid → {amount, fee, to?, memo?, kind?, time?} — payments this wallet made (its own log)
 * Returns Map txid → entry (BigInt amounts).
 */
/**
 * The most a Spark payment's fee can be. A restored payment that sent part of its value back to
 * this wallet, with a remainder no larger than this, is a payment to itself and the remainder is
 * its fee (a fee is about 1 sat a byte: 0.00003403 FIRO for a 3,285-byte spend).
 */
export const MAX_SPARK_FEE = 1000000n;

/**
 * spendInfo: what the server said about our own Spark spends when asked among decoys (Settings ->
 * Exact dates): txid -> {height, time, fee (sats), name (a Spark name registration)}.
 */
export function sparkEntries({ coins, sends = new Map(), tipHeight, spendInfo = new Map() }) {
  const out = new Map();
  const ensure = (txid, base) => {
    if (!out.has(txid)) out.set(txid, { txid, height: null, time: null, confirmations: 0, direction: 'in', kind: 'spark', amount: 0n, fee: 0n, received: 0n, change: 0n, spent: 0n, ...base });
    return out.get(txid);
  };
  const place = (e, c) => {
    if (c.height && (!e.height || c.height < e.height)) {
      e.height = c.height;
      e.heightApprox = !!c.heightApprox;
    }
    if (c.time && !e.time) e.time = c.time;
  };
  for (const c of coins) {
    const e = ensure(c.txid);
    if (c.isChange) e.change += c.value;
    else {
      e.received += c.value;
      if (c.memo && !e.memo) e.memo = c.memo;
      // Its set not confirmed by a second node yet (public audit, P4): not confirmed, not spendable.
      if (c.unproven) e.unproven = true;
    }
    place(e, c);
    if (c.spentTxid) {
      const s = ensure(c.spentTxid, { direction: 'out' });
      s.spent += c.value;
      place(s, { height: c.spentHeight ?? null, heightApprox: true, time: c.spentTime ?? null });
    }
  }
  for (const [txid, s] of sends) {
    // Given up on (backend _dropLostSends: the nodes do not have it, its coins are back): still
    // listed, as not gone through, with its own record (audit FE-2).
    const e = ensure(txid, { direction: 'out' });
    e.logged = s;
    if (s.time && !e.time) e.time = s.time;
    if (s.unsure) e.unsure = true;
    if (s.oneNode) e.oneNode = true;
  }
  for (const [txid, i] of spendInfo) {
    const e = out.get(txid);
    if (!e) continue;
    if (i.height) {
      e.height = i.height;
      e.heightApprox = false;
    }
    if (i.time) e.time = i.time;
    if (i.fee !== undefined && i.fee !== null) e.sparkFee = BigInt(i.fee);
    if (i.name) e.kind = 'spark-name';
  }
  for (const e of out.values()) {
    if (e.spent > 0n || e.logged) {
      e.direction = 'out';
      const known = e.logged?.fee !== undefined ? BigInt(e.logged.fee) : e.sparkFee ?? null;
      const rest = e.spent - e.change - e.received; // left this wallet: payments to others and the fee
      // Not sent from here and not asked about: a remainder small enough to be a fee, with part of
      // the value back to this wallet, is a payment to itself.
      const fee = known ?? (e.received > 0n && rest >= 0n && rest <= MAX_SPARK_FEE ? rest : 0n);
      e.fee = fee;
      if (e.logged?.amount !== undefined) e.amount = BigInt(e.logged.amount);
      else e.amount = rest - fee > 0n ? rest - fee : 0n;
      if (e.received > 0n && e.amount === 0n) {
        e.direction = 'self';
        e.amount = e.received;
      }
      // Its coins known (spent here): where they went.
      if (e.spent > 0n) {
        // What it paid to this wallet's own public addresses, as written down when sent: ours, not sent away.
        const own = e.direction === 'out' && /^\d+$/.test(String(e.logged?.toPublicSelf ?? '')) ? BigInt(e.logged.toPublicSelf) : 0n;
        const toPublicSelf = own < e.amount ? own : e.amount;
        e.parts = withComingBack(parts({ fromPrivate: e.spent, changePrivate: e.change, toPrivateSelf: e.received, toPublicSelf, toOthers: e.direction === 'out' ? e.amount - toPublicSelf : 0n, fee }), Boolean(e.logged));
      }
      if (e.logged?.kind) e.kind = e.logged.kind;
      if (e.logged?.to) e.counterparty = e.logged.to;
      if (Array.isArray(e.logged?.toAll) && e.logged.toAll.length > 1) e.counterparties = e.logged.toAll.slice(0, 20);
      if (e.logged?.memo) e.memo = e.logged.memo;
      // No coin of ours spent by it: it did not go through (a coin seen spent by it says otherwise).
      if (e.logged?.dropped && e.spent === 0n) {
        e.dropped = true;
        if (e.logged.letGo) e.letGo = true;
        if (e.logged.letGo && Number.isFinite(e.logged.letGoAt)) e.letGoAt = e.logged.letGoAt;
      }
    } else {
      e.amount = e.received;
    }
    e.confirmations = e.height && tipHeight && !e.unproven ? Math.max(0, tipHeight - e.height + 1) : 0;
  }
  return out;
}

/**
 * Both sides together, newest first, as WALLET_API Tx objects (satoshi strings).
 * A transaction known to both sides becomes one entry.
 */
export function mergeEntries(transparent, spark) {
  const all = new Map();
  for (const [txid, t] of transparent) all.set(txid, { ...t });
  for (const [txid, s] of spark) {
    const t = all.get(txid);
    if (!t) {
      all.set(txid, { ...s });
      continue;
    }
    // One transaction, both sides.
    if (t.kind === 'privatize') {
      if (t.ownIn > 0n && t.parts) {
        // Our public coins minted, some or all of them to our own Spark address (the Spark side's
        // word, or this wallet's own record of it when that came first).
        settlePrivatize(t, s.received > t.parts.toPrivateSelf ? s.received : t.parts.toPrivateSelf);
      } else if (t.ownIn > 0n) {
        const toOthers = t.amount > s.received ? t.amount - s.received : 0n;
        t.direction = toOthers > 0n ? 'out' : 'self';
        t.amount = toOthers > 0n ? toOthers : s.received;
      } else {
        t.amount += s.received;
      }
      if (s.memo) t.memo = s.memo;
    } else if ((t.kind === 'spark' || t.kind === 'spark-name') && (s.spent > 0n || s.logged)) {
      // Our own Spark payment, and some of it came to our own public address.
      const fee = s.logged?.fee !== undefined ? BigInt(s.logged.fee) : t.sparkFee ?? 0n;
      const outflow = s.spent - s.change - s.received - fee; // left our Spark balance, fee aside
      // The log's amount counts every recipient but our own Spark addresses, so our own public
      // address too: what reached it (ownOut) is ours (release audit of 0.1.21: a Make public from
      // the app read "Sent").
      const loggedOthers = s.logged?.amount !== undefined ? BigInt(s.logged.amount) - t.ownOut : null;
      const toOthers = loggedOthers !== null ? (loggedOthers > 0n ? loggedOthers : 0n) : outflow - t.ownOut;
      t.fee = fee;
      t.direction = toOthers > 0n ? 'out' : 'self';
      t.amount = toOthers > 0n ? toOthers : t.ownOut + s.received;
      if (s.spent > 0n) t.parts = withComingBack(parts({ fromPrivate: s.spent, changePrivate: s.change, toPrivateSelf: s.received, toPublicSelf: t.ownOut, toOthers: toOthers > 0n ? toOthers : 0n, fee }), Boolean(s.logged));
      // All of it to our own public addresses, none to a Spark one of ours: FIRO made public (0.1.21).
      // Its kind stays 'spark' (the private balance paid it: lib/sell/pay.js, the CSV's side).
      // Never with a public output to anyone else (a restore that has not found every coin spent can
      // make outflow look small: release audit of 0.1.21).
      if (toOthers <= 0n && s.received === 0n && t.ownOut > 0n && (t.otherOut ?? 0n) === 0n && t.kind === 'spark') t.toPublic = true;
      if (s.memo) t.memo = s.memo;
      if (s.counterparty) t.counterparty = s.counterparty;
      if (s.counterparties) t.counterparties = s.counterparties;
    } else if (t.kind === 'spark' || t.kind === 'spark-name') {
      // Someone's Spark payment that reached both our public and our Spark address.
      t.amount += s.received;
      if (s.memo) t.memo = s.memo;
    }
    if (!t.height && s.height) {
      t.height = s.height;
      t.heightApprox = s.heightApprox;
    }
    all.set(txid, t);
  }
  const list = [...all.values()].map(toApi);
  // Unconfirmed first, then newest first; a roughly placed entry sorts at the block it is placed at.
  const at = (t) => t.height ?? t.heightApprox ?? null;
  list.sort((a, b) => {
    if ((at(a) === null) !== (at(b) === null)) return at(a) === null ? -1 : 1;
    if (at(a) !== at(b)) return (at(b) ?? 0) - (at(a) ?? 0);
    if ((a.time ?? 0) !== (b.time ?? 0)) return (b.time ?? 0) - (a.time ?? 0);
    return a.txid < b.txid ? -1 : 1;
  });
  return list;
}

function toApi(e) {
  const tx = {
    txid: e.txid,
    height: e.height ?? null,
    time: e.time ?? null,
    confirmations: e.confirmations ?? 0,
    direction: e.direction,
    kind: e.kind,
    amount: String(e.amount ?? 0n),
    fee: String(e.fee ?? 0n),
  };
  if (e.memo) tx.memo = e.memo;
  if (e.counterparty) tx.counterparty = e.counterparty;
  if (e.toPublic) tx.toPublic = true;
  // Only when they add up (audit of 0.1.26): a coin of unknown value, or a restore that has not found
  // every coin spent, would show parts that do not; Activity then shows the fee alone, as before.
  if (e.parts && !e.dropped && addsUp(e.parts)) tx.parts = Object.fromEntries(PART_KEYS.map((k) => [k, String(e.parts[k] ?? 0n)]));
  if (e.inPublic) tx.inPublic = true;
  if (Array.isArray(e.counterparties) && e.counterparties.length > 1) tx.counterparties = e.counterparties;
  if (e.dropped) {
    tx.dropped = true;
    tx.confirmations = 0;
    if (e.letGo) tx.letGo = true;
    if (e.letGoAt) tx.letGoAt = e.letGoAt;
  } else if (!tx.height) {
    if (e.unsure) tx.unsure = true;
    if (e.oneNode) tx.oneNode = true;
  }
  if (e.unproven) {
    tx.unproven = true;
    tx.confirmations = 0;
  } else if (e.oneNodeProof) tx.oneNodeProof = true;
  if (e.heightApprox && e.height && !e.time) {
    // Found while restoring (no time): WALLET_API's height is an exact block or null, and
    // heightApprox the rough one. A coin seen live keeps its block, within a block or two.
    tx.height = null;
    tx.heightApprox = e.height;
  }
  return tx;
}

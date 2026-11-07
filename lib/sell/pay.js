// Paying a sell from this wallet, without any screen (screens/sell_order.js shows it): written
// down before anything leaves, sent once, and what a failure means said by the engine's own
// words (lib/send_outcome.js), so a payment that may have left is never offered again.

import { sendOutcome, followVerdict } from '../send_outcome.js';
import { untilText } from './words.js';
import { startPayment } from '../payment_flight.js';
import { t } from '../i18n.js';

// The sells this page is paying now, from the first step of paySell (or sendSellPayment) until its
// outcome is known (release verification 0.1.8): the sell's own record says "a payment started"
// only once it is written down, and a screen opened again before then offered "It isn't there: send
// 500 FIRO", whose retry paid it a second time. A screen reads this, and a second payment of the
// same sell is refused while one is under way.
const paying = new Set();
const payingWatchers = new Set();

/** Whether this page is paying the sell `orderId` right now (its outcome not known yet). */
export function sellPaymentUnderWay(orderId) {
  return paying.has(orderId);
}

/** fn() whenever a sell's payment starts or ends here (an open sell screen's redraw). Returns the unsubscribe. */
export function onSellPayment(fn) {
  payingWatchers.add(fn);
  return () => payingWatchers.delete(fn);
}

/** Claims the sell for one payment: a function that lets it go, or null while another is under way. */
function claim(orderId) {
  if (paying.has(orderId)) return null;
  paying.add(orderId);
  tellPaying();
  return () => {
    paying.delete(orderId);
    tellPaying();
  };
}

function tellPaying() {
  for (const fn of [...payingWatchers]) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}

const underWay = () => ({ kind: 'refused', code: 'paid', text: t('A payment for this sell is already on its way, so nothing more was sent.') });
const otherPayment = () => ({ kind: 'refused', code: 'busy', text: t('Your last payment is still being sent, so nothing was sent for this sell. Send it once that one has left.') });

/** A payment needs this long before the sell's deadline: a block or two, and buyfiro.app's look (audit FM-3). */
export const PAY_MARGIN_MS = 10 * 60 * 1000;
/** How long the look at buyfiro.app right before paying may take. */
export const LOOK_TIMEOUT_MS = 15000;
/** A look older than this (the password prompt took a while) is taken again before paying. */
export const LOOK_FRESH_MS = 60000;

/** Why the sell cannot be paid any more because of its deadline (words), or null. */
export function expiryReason(o, now = Date.now()) {
  if (!o || o.expiresAt == null) return null;
  if (o.expiresAt <= now) return t('buyfiro.app took FIRO for this sell until {amount}. Nothing was sent. Once buyfiro.app ends it, start a new sell.', { amount: untilText(o.expiresAt, now) });
  if (o.expiresAt - now <= PAY_MARGIN_MS) return t('buyfiro.app takes FIRO for this sell only until {amount}, too soon for a payment to reach it in time. Nothing was sent. Once buyfiro.app ends it, start a new sell.', { amount: untilText(o.expiresAt, now) });
  return null;
}

/**
 * Whether the sell `o`, as buyfiro.app answered about it just now (answered), may be paid:
 * null, or {code, text}: 'unreachable' (no answer: never paid on an old look), 'moved' (no longer
 * waiting for FIRO), 'expiring' (deadline passed or too close).
 */
export function payGate(o, { answered, now = Date.now() }) {
  if (!o) return { code: 'moved', text: t('This sell is not on this device any more. Nothing was sent.') };
  if (!answered) return { code: 'unreachable', text: t("Firo PWA couldn't reach buyfiro.app to check that this sell still takes FIRO, so nothing was sent. Try again in a moment.") };
  if (!o.isOpen || (o.lastState || 'awaiting_deposit') !== 'awaiting_deposit') return { code: 'moved', text: t('buyfiro.app no longer waits for FIRO on this sell, so nothing was sent.') };
  const ex = expiryReason(o, now);
  if (ex) return { code: 'expiring', text: ex };
  return null;
}

/**
 * The whole payment of a sell, for the screen: the engine's figures again (a change is shown,
 * never sent), a fresh look at buyfiro.app (only a sell it says still waits for FIRO, with time
 * to spare, is paid: FM-3), the person's confirmation, the sell read again after it, then
 * sendSellPayment with the figures reviewed (expect: the engine refuses others, 'fee-changed').
 * retry: the person looked in Activity after an interrupted start (sendStartedAt, no txid) and
 * found nothing. -> {kind: 'changed', quote} | {kind: 'refused', code, text} | {kind: 'cancelled'}
 * | sendSellPayment's.
 */
export async function paySell(args) {
  // One payment of a sell at a time in this page (release verification 0.1.8).
  const release = claim(args.orderId);
  if (!release) return underWay();
  try {
    return await payClaimed(args);
  } finally {
    release();
  }
}

async function payClaimed({ c, w, orderId, from, to, reviewedTotal, confirm, retry = false, clock = { now: () => Date.now() }, lookTimeoutMs = LOOK_TIMEOUT_MS, onStage = () => {} }) {
  await adoptLetGo(c, orderId, w).catch(() => {});
  // A payment of this sell let go of may still arrive: from that balance only, spending its coins.
  const rule = letGoRule(c.order(orderId), from, clock.now());
  if (rule.refused) return rule.refused;
  let fresh;
  try {
    fresh = await w.quote({ from, to, subtractFee: false, ...(rule.conflictWith ? { conflictWith: rule.conflictWith } : {}) });
  } catch (error) {
    if (error && error.code === 'conflict-coin') return { kind: 'refused', code: 'conflict-coin', text: sellConflictText(error) };
    throw error;
  }
  if (reviewedTotal == null || fresh.total !== reviewedTotal) return { kind: 'changed', quote: fresh };
  onStage('look');
  let look = await c.lookNow(orderId, { timeoutMs: lookTimeoutMs });
  let lookedAt = clock.now();
  let gate = payGate(look.order, { answered: look.answered, now: lookedAt });
  if (gate) return { kind: 'refused', ...gate };
  onStage('confirm');
  if (!(await confirm())) return { kind: 'cancelled' };
  // Read again after the confirmation: a look meanwhile may have moved it; a long wait looks again.
  if (clock.now() - lookedAt > LOOK_FRESH_MS) {
    onStage('look');
    look = await c.lookNow(orderId, { timeoutMs: lookTimeoutMs });
    lookedAt = clock.now();
    if (!look.answered) return { kind: 'refused', ...payGate(look.order, { answered: false }) };
  }
  const o = c.order(orderId);
  gate = payGate(o, { answered: true, now: clock.now() });
  if (gate) return { kind: 'refused', ...gate };
  // retry: the person looked in Activity after an interrupted start and found nothing.
  if ((o.sendStartedAt && !retry) || o.sentTxid || o.unsureTxid) return { kind: 'refused', code: 'paid', text: t('A payment for this sell has already started, so nothing more was sent.') };
  onStage('send');
  return sendClaimed({ c, w, orderId, from, to, retry, expect: { fee: fresh.fee, total: fresh.total }, clock });
}

/**
 * Sends exactly `to` (buyfiro.app's deposit address and the sell's amount) from `from`, for the
 * sell `orderId` of controller `c`, through wallet `w`. The person has reviewed and confirmed it.
 * -> {kind: 'sent', txid}
 *  | {kind: 'not-noted', error}               the mark could not be written: nothing was sent
 *  | {kind: 'not-sent', error, otherServer}   refused before it left, or by the node: may be paid again
 *  | {kind: 'unsure', txid}                   no answer from the node: it may have left (kept with the sell)
 *  | {kind: 'unknown', error}                 cannot tell: the sell stays "a payment started"
 */
export async function sendSellPayment(args) {
  const release = claim(args.orderId);
  if (!release) return underWay();
  try {
    return await sendClaimed(args);
  } finally {
    release();
  }
}

async function sendClaimed({ c, w, orderId, from, to, retry = false, expect = null, clock = { now: () => Date.now() } }) {
  // Every way to send a sell (this, and paySell) keeps the let-go rule (round-6 audit).
  const rule = letGoRule(c.order(orderId), from, clock.now());
  if (rule.refused) return rule.refused;
  // One Firo payment at a time from this page's screens (lib/payment_flight.js): a payment from
  // Review still being sent holds this one, before anything is written down.
  const done = startPayment('sell');
  if (!done) return otherPayment();
  try {
    return await markAndSend({ c, w, orderId, from, to, retry, expect, conflictWith: rule.conflictWith });
  } finally {
    done();
  }
}

async function markAndSend({ c, w, orderId, from, to, retry, expect, conflictWith = null }) {
  try {
    await c.markSending(orderId, { retry });
  } catch (error) {
    // Paid meanwhile by another way in (the controller refuses a second mark): nothing more is sent.
    if (error && error.code === 'paid') return { kind: 'refused', code: 'paid', text: error.message };
    return { kind: 'not-noted', error };
  }
  let r;
  try {
    r = await w.send({ from, to, subtractFee: false, ...(expect ? { expect } : {}), ...(conflictWith ? { conflictWith } : {}) });
  } catch (error) {
    const out = sendOutcome(error);
    if (out.kind === 'not-sent') {
      await c.markNotSent(orderId);
      return { kind: 'not-sent', error, otherServer: out.otherServer };
    }
    if (out.kind === 'unsure') {
      await c.markUnsure(orderId, { txid: out.txid, from, height: tipHeight(w) });
      return { kind: 'unsure', txid: out.txid, error };
    }
    return { kind: 'unknown', error };
  }
  await c.markSent(orderId, { txid: r.txid, from });
  return { kind: 'sent', txid: r.txid };
}

function tipHeight(w) {
  const h = w && w.state && w.state.tip ? Number(w.state.tip.height) : NaN;
  return Number.isSafeInteger(h) ? h : null;
}

/**
 * What there is to settle about a sell's payment, from the wallet's view (the engine's Tx flags):
 * for a payment that may have left (unsureTxid): 'left' (in a block), 'checking', or 'gone' (the
 * network does not have it: it may be paid again); for a payment the node took (sentTxid): 'gone'
 * once the network does not have it after all; null when there is nothing to settle.
 */
export function unsureState(order, w) {
  if (!order) return null;
  if (order.unsureTxid && !order.sentTxid) return followVerdict({ txid: order.unsureTxid }, w);
  if (order.sentTxid) return followVerdict({ txid: order.sentTxid }, w) === 'gone' ? 'gone' : null;
  return null;
}

/**
 * Settles a sell's payment once the wallet knows: an unsure one in a block -> paid (markSent);
 * one the network does not have (Tx.dropped) -> not paid (markDropped: it may be paid again,
 * release audit FM-1). Returns the state.
 */
export async function settleUnsure(c, orderId, w) {
  const o = c.order(orderId);
  const st = unsureState(o, w);
  if (st === 'left') await c.markSent(orderId, { txid: o.unsureTxid, from: o.sentFrom || o.payFrom });
  else if (st === 'gone') {
    const txid = o.unsureTxid || o.sentTxid;
    const tx = w && w.state && Array.isArray(w.state.txs) ? w.state.txs.find((x) => x.txid === txid) : null;
    // When the engine let it go (seconds), not when this screen noticed (round-7 audit).
    await c.markDropped(orderId, { txid, letGo: Boolean(tx && tx.letGo), letGoAt: tx && Number.isFinite(tx.letGoAt) ? tx.letGoAt * 1000 : null });
  }
  return st;
}

/** As long as the let-go payment's coins are spent first by the next payment (CONFLICT_KEEP_MS, 48 h): after it, the rule protects nothing. */
export const LET_GO_SAME_SIDE_MS = 48 * 3600 * 1000;

/**
 * What the let-go rule asks of a payment of sell `o` from `from` now: {refused} (another balance), or
 * {conflictWith}: the let-go payment's txid, whose coins the engine must spend one of (none: no rule).
 */
export function letGoRule(o, from, now = Date.now()) {
  const side = sideAfterLetGo(o, now);
  if (!side) return {};
  // Two payments of it let go of (round-7 audit: the next one could conflict with only one of them),
  // or none named: nothing more is sent from this wallet until the window ends.
  if (o.letGoCount > 1 || !o.letGoTxid) return { refused: { kind: 'refused', code: 'let-go-twice', text: t('Earlier payments for this sell may still go through, so nothing more is sent for it from this wallet for 48 hours after you let the last one go. If this sell ends first, start a new one.') } };
  if (side !== from) return { refused: { kind: 'refused', code: 'let-go-side', text: side === 'public' ? t('Your earlier payment for this sell may still go through, so this one is paid from your public balance too: then only one of the two can arrive. Nothing was sent.') : t('Your earlier payment for this sell may still go through, so this one is paid from your private balance too: then only one of the two can arrive. Nothing was sent.') } };
  return o.letGoTxid ? { conflictWith: o.letGoTxid } : {};
}

/** A refusal to conflict, said for a sell: with the way on when the sell ends first. */
export function sellConflictText(error) {
  return /after all/.test(error.message || '') ? error.message : t('Your earlier payment for this sell may still go through, and this one cannot be made from the same coins yet, so nothing was sent. Wait until it is settled (see Activity), or 48 hours after you let it go. If this sell ends first, start a new one.');
}

/**
 * A payment of this sell let go of that the sell does not carry (its screen was closed, or the
 * payment came back after two nodes called it gone, round-8 audit): found in the wallet's history by
 * the sell's deposit addresses, and kept with the sell as markDropped would have.
 */
export async function adoptLetGo(c, orderId, w) {
  const o = c.order(orderId);
  if (!o || !w || !w.state || !Array.isArray(w.state.txs)) return o;
  const to = [o.sparkDepositAddress, o.depositAddress].filter(Boolean);
  const now = Date.now();
  const found = w.state.txs
    .filter((x) => x.direction === 'out' && x.dropped && x.letGo && Number.isFinite(x.letGoAt) && now - x.letGoAt * 1000 < LET_GO_SAME_SIDE_MS && to.includes(x.counterparty))
    .sort((a, b) => b.letGoAt - a.letGoAt);
  if (!found.length) return o;
  // The newest, and how many there are (each one more makes the sell refused here for the window).
  const newest = found[0];
  if (newest.txid === o.letGoTxid && (o.letGoCount || 0) >= found.length) return o;
  // Its balance by its kind (round-9 audit: a private payment can go to the public deposit address).
  const from = newest.kind === 'spark' || newest.kind === 'spark-name' ? 'private' : 'public';
  return c.adoptLetGo(orderId, { txid: newest.txid, letGoAt: newest.letGoAt * 1000, from, count: found.length });
}

/** The only balance this sell may be paid from now ('public' | 'private'), or null: either. */
export function sideAfterLetGo(o, now = Date.now()) {
  return o && o.letGoFrom && Number.isFinite(o.letGoAt) && now - o.letGoAt < LET_GO_SAME_SIDE_MS ? o.letGoFrom : null;
}

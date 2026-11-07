// Payments this wallet made that are not confirmed yet, by address (Review's "Paid before?").
// No imports: screens and their tests load it as it is.

/**
 * This wallet's payments to `address` that are not confirmed yet: on their way, or that may have left
 * (no answer after a node had them). Review says so before the same address is paid again (audit of
 * 0.1.8, X2: a payment re-entered by Scan or Contacts while the first one was being sent went again
 * with no word). A payment that did not go through (dropped) is not one of them.
 */
export function openPaymentsTo(txs, address, now = Date.now()) {
  const a = String(address || '').trim();
  if (!a) return [];
  const paid = (t) => t.counterparty === a || (Array.isArray(t.counterparties) && t.counterparties.includes(a));
  // A payment let go of (on one node's word) may still be mined for a while (CONFLICT_KEEP_MS after
  // the let-go): a public payment conflicts with it, a private one cannot (round-3 audit of 0.1.20),
  // so Review says so whichever balance pays. Made within the last LET_GO_WARN_MS.
  const letGoRecent = (t) => t.dropped && t.letGo && now - Number(t.letGoAt || t.time || 0) * 1000 < LET_GO_WARN_MS;
  return (txs || []).filter((t) => t && t.direction === 'out' && paid(t) && (letGoRecent(t) || (!t.dropped && (t.unsure || !(Number(t.confirmations) > 0)))));
}

/** How long after it was let go of (or made, for a record from before 0.1.20) a payment is said on Review: 48 h kept + margin. */
export const LET_GO_WARN_MS = 4 * 24 * 3600 * 1000;

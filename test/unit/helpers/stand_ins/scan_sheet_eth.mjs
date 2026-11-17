// screens/scan_sheet.js as Ethereum Send sees it: the next scan answers what the test set.
export const scanned = { next: null };
export async function scanEthAddress() {
  const r = scanned.next;
  scanned.next = null;
  return r;
}

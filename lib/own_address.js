// How an address of this wallet is named (Send, My addresses): from the engine's whoseAddress or
// myAddresses entry. Spark addresses by their diversifier (1 is the first Receive shows), public
// ones from 1.
import { t } from './i18n.js';

/** "Spark address 3", "Public address 1", "Change address 2", "Spark change address". */
export function ownAddressName(w) {
  if (w.kind === 'spark' || w.diversifier !== undefined) return w.change ? t('Spark change address') : t('Spark address {n}', { n: w.diversifier });
  return w.chain === 'change' ? t('Change address {n}', { n: w.index + 1 }) : t('Public address {n}', { n: w.index + 1 });
}

/** The sentence Send adds for one of this wallet's addresses. */
export function ownAddressWords(w) {
  return t('It is one of your addresses: {name}. The payment stays in this wallet.', { name: ownAddressName(w) });
}

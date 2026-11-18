/* Rescan (Settings -> Rescan)
 * Spec: ONE job: read the blockchain again for this wallet's payments.
 *       Primary CTA: "Rescan".
 *       Taps from app open: 2 (☰ -> Rescan), 3 to start.
 * Exit-intent reasons and answers:
 *   - "Will I lose coins or history?" -> no: it only reads again; nothing is sent.
 *   - "How long?" -> said up front: it reads everything, so it takes a while; Home shows how far
 *     along it is, and sending waits until it is done.
 * A Rescan always reads the whole history. It once offered to start at a block, which the engine
 * did not do, and its "Everything" kept a recent wallet's later start (outside audit 2026-11-18,
 * #02): one way now, the one that is always complete.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, notice, toast } from '../lib/ui.js';
import { wallet } from '../lib/wallet.js';
import { isNotYet } from '../lib/chain.js';
import { t } from '../lib/i18n.js';

export default function rescan(app) {
  const msg = h('div', { 'aria-live': 'polite' });
  const cta = primary(t('Rescan'), run, { 'data-testid': 'rescan-start' });

  async function run() {
    cta.disabled = true;
    try {
      // Words made on this device: nothing before it existed to look for.
      await wallet.rescan(null, { madeHere: Boolean(app.record && app.record.newWallet && !app.record.restored) });
      toast(t('Rescanning. Home shows how far along it is.'), 4000);
      app.go('home');
    } catch (e) {
      cta.disabled = false;
      put(msg, notice(isNotYet(e) ? 'info' : 'error', isNotYet(e) ? t('Rescanning is not in this version yet.') : t('The rescan did not start: {message}', { message: e.message })));
    }
  }

  const el = screen(
    { title: t('Rescan'), back: () => app.back('settings'), actions: [cta] },
    h('p', { class: 'lead', text: t('Firo PWA reads the Firo blockchain again for your payments. Nothing is sent and nothing is deleted.') }),
    h('div', { class: 'card', 'data-testid': 'rescan-all' }, h('p', { class: 'small', text: t('It reads the whole Spark history, from the first block, so nothing is missed.') })),
    notice('info', t('It may take a while. Sending waits until it is done; you can leave the app and come back.')),
    msg,
  );
  return { el };
}

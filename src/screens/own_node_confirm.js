/* Your own node (right after an unlock, when there is something to ask)
 * Spec: ONE job: keep, or leave, the own Firo node / Ethereum / BNB Chain server this device uses for
 *       this wallet when the wallet's own approval of it does not check out: saved by a version
 *       before 0.1.24 (no seal), or a seal that does not match (lib/trust.js; outside security audit
 *       2026-11-18, #3: a plain stored address could be written there by whoever had this browser's
 *       data, so it may not be the person's choice at all).
 *       Primary CTA: "Use the public ones" (secondary: "Keep using it", after the password).
 *       Taps from app open: 0 (it comes by itself after the unlock); 1 to answer (2 and the password to keep).
 * Exit-intent reasons and answers:
 *   - "Why ask, I set it myself?" -> said: Firo PWA now seals the choice with the password, and asks
 *     once for a choice saved before that.
 *   - "I don't know that address" -> said what to do: the public ones, and that someone with this
 *     device's data may have put it there.
 *   - "What happens meanwhile?" -> nothing connects until the answer: no address goes anywhere.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, secondary, notice } from '../lib/ui.js';
import { approve, checkTrust, setApproved } from '../lib/trust.js';
import { normalizeServerAddress } from '../lib/server_address.js';
import { useFiroServers } from '../lib/servers.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { t } from '../lib/i18n.js';

const WHAT = {
  firo: (a) => t('Your own Firo node: {address}', { address: a }),
  ethereum: (a) => t('Your own Ethereum server: {address}', { address: a }),
  bsc: (a) => t('Your own BNB Chain server: {address}', { address: a }),
};

export default function ownNodeConfirm(app, params = {}) {
  const trusted = (app.prefs && app.prefs.trusted) || {};
  const kinds = (Array.isArray(params.kinds) ? params.kinds : []).filter((k) => WHAT[k] && typeof trusted[k] === 'string');
  const msg = h('div', { 'aria-live': 'polite' });
  let busy = false;

  async function answer(keep) {
    if (busy) return;
    busy = true;
    // Keeping it is approving it now: with the password, as choosing a node in Settings is.
    if (keep && !(await confirmIdentity(app, { title: t('Keep using it'), detail: t('Your password first.'), cta: t('Continue'), passwordOnly: true }))) {
      busy = false;
      return;
    }
    keepBtn.disabled = true;
    publicBtn.disabled = true;
    try {
      let next = trusted;
      for (const kind of kinds) next = await approve(app.dbPass, app.record.id, next, kind, keep ? trusted[kind] : null);
      setApproved(app.record.id, await checkTrust(app.dbPass, app.record.id, next));
      await app.setPrefs({ trusted: next });
      // Firo's public nodes chosen: the own node also leaves this device's policy (another wallet that
      // approved it under its own password sets it again when it opens).
      if (!keep && kinds.includes('firo')) await useFiroServers(app);
      await app.openWallet();
    } catch (e) {
      busy = false;
      keepBtn.disabled = false;
      publicBtn.disabled = false;
      put(msg, notice('error', t('That did not work: {message}', { message: String((e && e.message) || e) })));
    }
  }

  const publicBtn = primary(t('Use the public ones'), () => answer(false), { 'data-testid': 'own-node-public' });
  const keepBtn = secondary(t('Keep using it'), () => answer(true), { 'data-testid': 'own-node-keep' });
  const unchecked = Array.isArray(params.unchecked) && params.unchecked.length > 0;
  const shown = (kind) => (kind === 'firo' ? normalizeServerAddress(trusted.firo).address || trusted.firo : trusted[kind]);

  const el = screen(
    { title: t('Your own node'), actions: [publicBtn, keepBtn] },
    h('div', { class: 'status-icon wait' }, icon('globe')),
    h('p', { class: 'lead', text: unchecked ? t("This wallet is set to use the following, but its approval of it doesn't check out:") : t('This wallet was set to use:') }),
    h('div', { class: 'card own-node-list', 'data-testid': 'own-node-list' }, ...kinds.map((k) => h('p', { text: WHAT[k](shown(k)) }))),
    h('p', { class: 'small', text: unchecked ? t('An approval is sealed with your password; this one may have been changed on this device. Nothing connects until you answer.') : t('Firo PWA now seals this choice with your password, and asks once for one saved before. Nothing connects until you answer.') }),
    notice('warn', t("Don't recognise it? Choose the public ones: someone with this device's data may have put it there.")),
    msg,
  );
  return { el };
}

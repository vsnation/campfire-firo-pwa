/* Face ID / Touch ID setup
 * Spec: ONE job: let Face ID / Touch ID unlock the wallet.
 *       Primary CTA: "Turn on Face ID" (secondary: "Not now").
 *       Taps from app open: 4 (create) / 3 (restore); from Settings: 2.
 * Exit-intent reasons and answers:
 *   - "Does Apple get my keys?" -> no: the passkey only unlocks a key kept on this device. But the
 *     passkey itself lives in Apple's or Google's password manager and may sync there, so that
 *     account, with a copy of this device's data, would open the wallet: said plainly, with what
 *     to do (protect the account).
 *   - "What if it fails?" -> the password still works; we say so if this device can't do it.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, textButton, notice } from '../lib/ui.js';
import { addPasskey } from '../lib/session.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { t } from '../lib/i18n.js';

/**
 * Why a passkey cannot protect the wallet key here, and what to do (owner, 2026-11-17: Chrome on a
 * Mac kept the passkey in its own storage, "This passkey will only be saved on this device", which
 * has no PRF; the message blamed the macOS version). The page cannot pick where a passkey is kept.
 */
export function noPrfText(env = globalThis) {
  const nav = env.navigator || {};
  const ua = String(nav.userAgent || '');
  const touchMac = /Macintosh/.test(ua) && Number(nav.maxTouchPoints) > 1;
  if (/iPhone|iPad|iPod/.test(ua) || touchMac) return t("This iPhone or iPad can't use a passkey to protect the wallet key: that needs iOS 18 or newer. Your password keeps working.");
  if (/Macintosh/.test(ua) && /Chrome\//.test(ua) && !/Edg\/|OPR\//.test(ua)) {
    return t("Chrome kept this passkey in its own storage on this Mac, which can't protect a key. In Chrome's Password Manager settings, turn on passkeys from iCloud Keychain (macOS 15 or newer), then try again. Your password keeps working.");
  }
  return t("This browser kept the passkey where it can't protect a key. Your password keeps working.");
}

export default function passkeySetup(app, params = {}) {
  const first = Boolean(params.first);
  const msg = h('div', { 'aria-live': 'polite' });
  const next = () => (first ? app.openWallet() : app.go('settings'));
  const cta = primary(h('span', {}, t('Turn on Face ID')), turnOn, { 'data-testid': 'passkey-on' });
  cta.prepend(icon('face'));
  // The password was given: just set (first), or checked here within the last minute and no attempt
  // failed since (release audit of 0.1.21: a password checked once must not leave the screen open to
  // whoever picks the phone up next).
  let checkedAt = first ? Infinity : 0;
  const CHECK_KEEP_MS = 60000;
  const checked = () => Date.now() - checkedAt < CHECK_KEEP_MS;

  async function turnOn() {
    cta.disabled = true;
    // From Settings: the password first. An unlocked phone in someone else's hands must not be able
    // to add a passkey of theirs (a security key, another account) to this wallet (public audit, P2).
    // Right after the password was set (first), it was just typed.
    if (!checked()) {
      if (!(await confirmIdentity(app, { title: t('Turn on Face ID'), detail: t('Your password first.'), cta: t('Continue'), passwordOnly: true }))) {
        cta.disabled = false;
        return;
      }
      checkedAt = Date.now();
      // Checking the password takes a moment, and Safari lets a page make a passkey only right after
      // a tap (owner, 2026-11-17: on a Mac it "doesn't work": Safari refused, and it read as
      // cancelled). Where that window has closed, one more tap starts it.
      if (navigator.userActivation && !navigator.userActivation.isActive) {
        cta.disabled = false;
        put(msg, h('div', { 'data-testid': 'passkey-tap-again' }, notice('info', t('Password checked. Tap Turn on Face ID again to save the passkey.'))));
        return;
      }
    }
    try {
      await addPasskey(app);
      put(msg, notice('success', t('Face ID / Touch ID is on for this wallet.')));
      setTimeout(next, 700);
    } catch (e) {
      cta.disabled = false;
      if (!first) checkedAt = 0; // the next try asks for the password again
      const text =
        e.code === 'cancelled'
          ? t('Face ID was cancelled. You can try again, or skip and use your password.')
          : e.code === 'no_prf'
            ? noPrfText()
            : e.code === 'unsupported'
              ? t('Face ID / Touch ID passkeys are not available in this browser. Your password keeps working.')
              : t('That didn\'t work: {message} Your password keeps working.', { message: e.message });
      put(msg, notice(e.code === 'cancelled' ? 'info' : 'warn', text));
    }
  }

  const el = screen(
    { title: t('Unlock with Face ID'), back: first ? null : () => app.go('settings'), actions: [cta, textButton(first ? t('Not now') : t('Cancel'), next, { 'data-testid': 'passkey-skip' })] },
    first ? h('p', { class: 'step', text: t('Almost done') }) : null,
    h('p', { class: 'lead', text: t('Open Firo PWA with Face ID or Touch ID instead of typing your password.') }),
    h(
      'div',
      { class: 'card' },
      h('h3', { text: t('How it stays private') }),
      h('p', { class: 'small', text: t("A passkey unlocks the wallet's key, which never leaves this device. Firo PWA has no server and no account. Your password keeps working too.") }),
      h('p', { class: 'small', 'data-testid': 'passkey-account', text: t('The passkey is kept by your Apple or Google password manager and may sync with that account. Protect the account (two-step sign-in) as you would this password.') }),
    ),
    msg,
  );
  return { el };
}

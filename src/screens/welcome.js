/* Welcome
 * Spec: ONE job: start a Firo wallet on this device - a new one, one from its recovery words, or
 *       one from a Campfire backup file.
 *       Primary CTA: "Create a new wallet" (secondary: "Restore with recovery words",
 *       "Restore from a backup file").
 *       Taps from app open: 0 (first screen for a new device); each choice is 1 tap.
 * Exit-intent reasons and answers:
 *   - "Is this a scam / who holds my money?" -> the line under the buttons: no account, your keys
 *     stay on this device.
 *   - "Three buttons, which one is me?" -> the new wallet is the obvious (primary) one; the other two
 *     are named after what you bring: your words, or your backup file.
 *   - "I have a Campfire app wallet" -> its 12 or 24 words restore it here (same keys).
 *   - "Will I lose it if Safari clears data? Can I install it?" -> the install card under the logo:
 *     Install (Chrome, Edge, Android) or the Home Screen / Dock steps (iPhone, iPad, Mac Safari), with
 *     why (screens/home_screen_guide.js). Where nothing can be installed, nothing is offered.
 *   - "What does it cost?" -> nothing to install or sign up; network fees are shown before paying.
 *   - "It is not in my language" -> it follows the device's language; the language control at the top
 *     right (each language named in its own script) changes it at once.
 */
import { h, put } from '../lib/dom.js';
import { screen, primary, secondary } from '../lib/ui.js';
import { languagePicker } from '../lib/lang_ui.js';
import { t } from '../lib/i18n.js';
import { welcomeInstallCard } from './home_screen_guide.js';

export default function welcome(app) {
  // Compact when the install card must fit above the fold too (375x667 without scrolling).
  const hero = h('div', { class: 'hero' });
  const guide = welcomeInstallCard(app, (shown) => hero.classList.toggle('compact', shown));
  const el = screen(
    {
      topbar: false,
      cls: 'welcome',
      actions: [
        primary(t('Create a new wallet'), () => {
          app.setup = { mode: 'create' };
          app.go('backup');
        }, { 'data-testid': 'create' }),
        secondary(t('Restore with recovery words'), () => {
          app.setup = { mode: 'restore' };
          app.go('restore');
        }, { 'data-testid': 'restore' }),
        secondary(t('Restore from a backup file'), () => {
          app.setup = { mode: 'file' };
          app.go('restoreFile');
        }, { 'data-testid': 'restore-file' }),
        h('button', { class: 'btn btn-text', 'data-testid': 'watch', onclick: () => { app.setup = { mode: 'watch' }; app.go('watch'); } }, t('Watch a wallet with its view key')),
        h('p', { class: 'small center', text: t('No sign-up. Your keys stay on this device.') }),
      ],
    },
    h('div', { class: 'lang-bar' }, languagePicker()),
    put(
      hero,
      h('img', { src: 'img/logo.svg', alt: '' }),
      h('h1', { text: 'Firo PWA' }), // i18n-ignore: a name, the same in every language
      h('p', { text: t('Your privacy. Your wallet. Your Firo.') }),
    ),
    guide.el,
  );
  return { el, destroy: guide.destroy };
}

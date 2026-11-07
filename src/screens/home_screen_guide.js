/* Installing Firo PWA: why, and how, on every browser that can (owner, 2026-11-05: "Why I don't see
 * Install recommendation and requirement")
 * Spec (Welcome card): ONE job: before a wallet exists, a person in a browser tab learns that the
 *       installed app is the place for it, and installs it. Primary CTA of the screen stays "Create a
 *       new wallet"; the card's own action is secondary: "Install" (Chrome, Edge, Android: the
 *       browser's Install dialog) or "Show me how" (iPhone, iPad, Mac Safari: the steps in a sheet).
 *       Taps from app open: 1 ("Install", then the browser's own Install).
 * Spec (Home card): ONE job: a wallet that lives in a tab: say what the tab risks and the way out.
 *       Secondary card under the balance: "Install" / "Show me how", and "Later" (a week).
 * Spec (Settings row): the same, at any time, also after "Later" or the Welcome card's X.
 * Exit-intent reasons and answers:
 *   - "Why should I bother?" -> the reason first, as what the browser does, never as a fault: Safari
 *     deletes a tab's data after 7 days without a visit; other browsers clear it when space runs low,
 *     and keep an installed app's.
 *   - "I can't find Share" -> since iOS 26 Safari hides it behind ••• (or ☰) next to the address:
 *     said in step 1. On a Mac: File, then Add to Dock (or Share in the toolbar).
 *   - "Add to Home Screen is not in the list" -> step 2 says to scroll down, or tap More.
 *   - "Will my wallet come along?" -> Chrome / Edge / Android: yes, the installed app shares this
 *     site's data ("Your wallet comes with it"). iPhone, iPad, Mac Safari: no, the app has its own,
 *     so the steps end where the wallet is started (or restored) in the installed app.
 *   - "Setup says keep this screen open" -> the setup card says there is no need to wait: the Home
 *     Screen (Dock) app sets itself up separately.
 *   - "Firefox: nothing to install?" -> nothing is offered where nothing can be installed.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { openSheet, toast } from '../lib/ui.js';
import { installWay, promptInstall, onInstallChange } from '../lib/install_prompt.js';
import { evictionRisk } from '../lib/storage.js';
import { t, tk, tNodes, sentences } from '../lib/i18n.js';

/** The texts, marked with tk() and translated where they are shown. 'ios' and 'mac' are the two ways with steps. */
export const HOME_SCREEN_TEXT = Object.freeze({
  title: { ios: tk('Add Firo PWA to your Home Screen'), mac: tk('Add Firo PWA to the Dock') },
  first: { ios: tk('First, add Firo PWA to your Home Screen'), mac: tk('First, add Firo PWA to the Dock') },
  why: {
    ios: tk("Safari deletes a site's data after 7 days without a visit. The Home Screen app is not under that rule."),
    mac: tk("Safari deletes a site's data after 7 days without a visit. An app in the Dock is not under that rule."),
  },
  notMoved: { ios: tk('A wallet made in a Safari tab does not move to the Home Screen app.'), mac: tk('A wallet made in a Safari tab does not move to the Dock app.') },
  // The setup screen: leaving it is fine, though it also says to keep it open while it works.
  noWait: { ios: tk("You don't need to wait here: the Home Screen app sets itself up separately."), mac: tk("You don't need to wait here: the Dock app sets itself up separately.") },
  share: tk('Tap Share {share}. No Share button? Tap {more} or {menu} next to the address first.'),
  add: tk('Tap "Add to Home Screen" (scroll down, or tap More if it is not in the list). If you see "Open as Web App", leave it on. Tap Add.'),
  macMenu: tk('In the menu bar, choose File, then Add to Dock. Or click Share {share} in the toolbar, then Add to Dock.'),
  macAdd: tk('Click Add.'),
  // The last step, by what the person has: nothing yet, their words, their backup file, a view key.
  open: {
    ios: {
      start: tk('Open Firo PWA from your Home Screen and start your wallet there.'),
      words: tk('Open Firo PWA from your Home Screen and restore your wallet there with your recovery words.'),
      file: tk('Open Firo PWA from your Home Screen and restore your wallet there from your backup file.'),
      view: tk('Open Firo PWA from your Home Screen and watch your wallet there again with its view key.'),
    },
    mac: {
      start: tk('Open Firo PWA from the Dock and start your wallet there.'),
      words: tk('Open Firo PWA from the Dock and restore your wallet there with your recovery words.'),
      file: tk('Open Firo PWA from the Dock and restore your wallet there from your backup file.'),
      view: tk('Open Firo PWA from the Dock and watch your wallet there again with its view key.'),
    },
  },
  // Home, for a wallet in a Safari tab whose storage is not kept: the same last step, said in one sentence.
  homeTitle: tk('Safari can delete this wallet after 7 days without a visit.'),
  homeBody: {
    ios: {
      words: tk('Add Firo PWA to your Home Screen (Share, then Add to Home Screen) and restore your wallet there with your recovery words: the Home Screen app keeps its data.'),
      file: tk('Add Firo PWA to your Home Screen (Share, then Add to Home Screen) and restore your wallet there from your backup file: the Home Screen app keeps its data.'),
      view: tk('Add Firo PWA to your Home Screen (Share, then Add to Home Screen) and watch your wallet there again with its view key: the Home Screen app keeps its data.'),
    },
    mac: {
      words: tk('Add Firo PWA to the Dock (File, then Add to Dock) and restore your wallet there with your recovery words: the Dock app keeps its data.'),
      file: tk('Add Firo PWA to the Dock (File, then Add to Dock) and restore your wallet there from your backup file: the Dock app keeps its data.'),
      view: tk('Add Firo PWA to the Dock (File, then Add to Dock) and watch your wallet there again with its view key: the Dock app keeps its data.'),
    },
  },
  // Chrome, Edge, Android: the browser's own Install; the installed app shares this site's data.
  install: tk('Install Firo PWA'),
  installWhy: tk('It opens like an app, and the browser keeps its data instead of clearing it when space runs low.'),
  installCarries: tk('Your wallet comes with it.'),
  installBtn: tk('Install'),
  installed: tk('Firo PWA is installed.'),
  showMe: tk('Show me how'),
  gotIt: tk('Got it'),
});

/** What the person brings to the installed app: 'start' (no wallet yet) | 'words' | 'file' | 'view'. */
export function lastStep(record) {
  if (!record) return 'start';
  if (record.watchOnly) return 'view';
  // Restored from a backup file and the words never written down: the file is what they have.
  return record.wordsConfirmed === false ? 'file' : 'words';
}

/** The steps for 'ios' or 'mac', as a numbered list. last: lastStep(). */
export function homeScreenSteps(way, last = 'start') {
  const w = way === 'mac' ? 'mac' : 'ios';
  const open = HOME_SCREEN_TEXT.open[w];
  const icons = { share: icon('share', 'inline-icon'), more: icon('more', 'inline-icon'), menu: icon('menu', 'inline-icon') };
  return h(
    'ol',
    { class: 'steps-list a2hs-steps', 'data-testid': 'a2hs-steps', 'data-way': w },
    w === 'mac' ? h('li', {}, ...tNodes(HOME_SCREEN_TEXT.macMenu, { share: icons.share })) : h('li', {}, ...tNodes(HOME_SCREEN_TEXT.share, icons)),
    h('li', { text: t(w === 'mac' ? HOME_SCREEN_TEXT.macAdd : HOME_SCREEN_TEXT.add) }),
    h('li', { text: t(open[last] || open.start) }),
  );
}

/** The reason and the steps in a sheet ("Show me how"). */
export function openHomeScreenGuide(way, last = 'start') {
  const w = way === 'mac' ? 'mac' : 'ios';
  const title = t(HOME_SCREEN_TEXT.title[w]);
  return openSheet((close) => [
    h('h2', { text: title }),
    h('p', { class: 'lead', 'data-testid': 'a2hs-why', text: last === 'start' ? sentences(t(HOME_SCREEN_TEXT.why[w]), t(HOME_SCREEN_TEXT.notMoved[w])) : t(HOME_SCREEN_TEXT.why[w]) }),
    homeScreenSteps(w, last),
    h('button', { class: 'btn btn-primary', 'data-testid': 'a2hs-got-it', onclick: () => close(true) }, t(HOME_SCREEN_TEXT.gotIt)),
  ], { label: title });
}

/** The browser's Install dialog; says so when it is done. Resolves its outcome. */
export async function installNow() {
  const outcome = await promptInstall();
  if (outcome === 'accepted') toast(t(HOME_SCREEN_TEXT.installed), 4000);
  return outcome;
}

/** The action of a card or row: the browser's Install, or the steps. */
export function installAction(way, last) {
  return way === 'prompt' ? installNow() : openHomeScreenGuide(way, last);
}

/** The title of the Settings row, or null where Firo PWA cannot be installed from here. */
export function installRowTitle(way) {
  if (way === 'prompt') return t(HOME_SCREEN_TEXT.install);
  if (way === 'ios' || way === 'mac') return t(HOME_SCREEN_TEXT.title[way]);
  return null;
}

/**
 * Welcome: the card before any wallet exists, or nothing; it appears when Chrome's Install arrives
 * (about a second after load) and goes when it is used. onShow(shown): the hero is made compact.
 */
export function welcomeInstallCard(app, onShow = () => {}) {
  const box = h('div', { 'data-testid': 'install-box' });
  let shownWay = undefined;
  const render = () => {
    const way = app.prefs && app.prefs.a2hsDismissed ? null : installWay();
    if (way === shownWay) return;
    shownWay = way;
    onShow(Boolean(way));
    if (!way) return put(box);
    const close = h('button', {
      class: 'icon-btn',
      type: 'button',
      'aria-label': t('Hide this tip'),
      'data-testid': 'a2hs-close',
      onclick: async () => {
        await app.setPrefs({ a2hsDismissed: true }).catch(() => {});
        render();
      },
    }, icon('close'));
    const prompt = way === 'prompt';
    put(
      box,
      h(
        'div',
        { class: 'card a2hs', 'data-testid': 'a2hs', 'data-way': way },
        h('div', { class: 'banner' }, h('h3', { class: 'grow', text: prompt ? t(HOME_SCREEN_TEXT.install) : t(HOME_SCREEN_TEXT.first[way]) }), close),
        h('p', { text: prompt ? t(HOME_SCREEN_TEXT.installWhy) : sentences(t(HOME_SCREEN_TEXT.why[way]), t(HOME_SCREEN_TEXT.notMoved[way])) }),
        prompt
          ? h('button', { class: 'btn btn-secondary btn-small a2hs-install', type: 'button', 'data-testid': 'a2hs-install', onclick: () => installNow() }, icon('apps'), h('span', { text: t(HOME_SCREEN_TEXT.installBtn) }))
          : h('button', { class: 'btn btn-text btn-small inline', type: 'button', 'data-testid': 'a2hs-how', onclick: () => openHomeScreenGuide(way, 'start') }, t(HOME_SCREEN_TEXT.showMe)),
      ),
    );
  };
  const off = onInstallChange(render);
  render();
  return { el: box, destroy: off };
}

export const INSTALL_SNOOZE_MS = 7 * 24 * 3600 * 1000;

/**
 * Home: for a wallet in a tab. Safari (storage not kept): it can delete the wallet, and the way to keep
 * it. Chrome, Edge, Android: Install, which keeps this very wallet. "Later" hides it for a week.
 */
export function homeInstallCard(app) {
  const box = h('div', { 'data-testid': 'install-home-box' });
  let shown = '';
  const render = () => {
    const way = installWay();
    const snoozed = Number(app.prefs && app.prefs.installSnoozedUntil) > Date.now();
    const safari = (way === 'ios' || way === 'mac') && evictionRisk(app) === 'safariTab';
    const show = app.record && !snoozed && (way === 'prompt' || safari) ? way : '';
    const last = lastStep(app.record);
    const key = `${show}|${last}`;
    if (key === shown) return;
    shown = key;
    if (!show) return put(box);
    const later = h('button', {
      class: 'btn btn-text btn-small',
      type: 'button',
      'data-testid': 'install-later',
      onclick: async () => {
        await app.setPrefs({ installSnoozedUntil: Date.now() + INSTALL_SNOOZE_MS }).catch(() => {});
        render();
      },
    }, t('Later'));
    const prompt = show === 'prompt';
    const body = prompt ? sentences(t(HOME_SCREEN_TEXT.installWhy), t(HOME_SCREEN_TEXT.installCarries)) : t(HOME_SCREEN_TEXT.homeBody[show][last === 'start' ? 'words' : last]);
    put(
      box,
      h(
        'div',
        { class: `notice ${prompt ? 'info' : 'warn'}`, 'data-testid': 'install-home', 'data-way': show },
        icon(prompt ? 'apps' : 'alert'),
        h(
          'div',
          { class: 'grow' },
          h('strong', { text: `${prompt ? t(HOME_SCREEN_TEXT.install) : t(HOME_SCREEN_TEXT.homeTitle)} ` }),
          body,
          h(
            'div',
            { class: 'btn-row prompt-actions' },
            prompt
              ? h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'install-home-go', onclick: () => installNow() }, t(HOME_SCREEN_TEXT.installBtn))
              : h('button', { class: 'btn btn-secondary btn-small', type: 'button', 'data-testid': 'install-home-how', onclick: () => openHomeScreenGuide(show, last) }, t(HOME_SCREEN_TEXT.showMe)),
            later,
          ),
        ),
      ),
    );
  };
  const off = onInstallChange(render);
  render();
  return { el: box, render, destroy: off };
}

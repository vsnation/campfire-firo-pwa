/* My addresses (Receive -> My addresses, ☰ -> My addresses)
 * Spec: ONE job: find an address of this wallet, or check that an address is this wallet's.
 *       Primary CTA: none (a search and a list); each address opens with Copy.
 *       Taps from app open: 2 (Home -> Receive -> My addresses).
 * Exit-intent reasons and answers:
 *   - "Is this address mine?" -> paste it in the search: a full address is checked at once, Spark
 *     ones too, also one another wallet of the same words handed out (owner, 2026-10-26).
 *   - "Which one did I give them?" -> every address handed out, numbered, with what it holds now
 *     and how many payments arrived; typing a part of one finds it.
 *   - "Do Spark addresses give me away?" -> no: said under the Spark list, only this wallet can tell
 *     they are its own.
 *   - "What is a change address?" -> one line under the public list.
 */
import { h, put, shorten } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, notice, secondary, textButton, openSheet, copyText } from '../lib/ui.js';
import { formatAmount, UNIT } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { ownAddressName } from '../lib/own_address.js';
import { qrElement } from './receive.js';
import { t, tn } from '../lib/i18n.js';

const KINDS = ['spark', 'transparent'];
// From this length a search is taken as a whole address (a public one has 34 characters).
const WHOLE = 30;

export default function addresses(app, params = {}) {
  let kind = params.kind === 'transparent' ? 'transparent' : 'spark';
  let book = null;
  let checkSeq = 0;
  const search = h('input', { class: 'input', type: 'search', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: t('Search or paste an address'), 'aria-label': t('Search or paste an address'), 'data-testid': 'addr-search', oninput: () => render() });
  const verdict = h('div', { 'aria-live': 'polite', 'data-testid': 'addr-verdict' });
  const kindBox = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': t('Address type') });
  const body = h('div');

  const holdsLine = (a) => [a.holds !== '0' ? t('Holds {amount} {UNIT}', { amount: formatAmount(BigInt(a.holds)), UNIT }) : t('Holds nothing now'), a.payments === null ? t('too many payments to count') : tn({ one: '{n} payment', other: '{n} payments' }, a.payments)].join(' · ');

  function copyButton(address) {
    const b = secondary(h('span', {}, t('Copy address')), () => copyText(address, t('Address copied')), { 'data-testid': 'addr-copy' });
    b.prepend(icon('copy'));
    return b;
  }

  function details(a, k) {
    openSheet((close) => [
      h('h2', { 'data-testid': 'addr-sheet-title', text: ownAddressName({ ...a, kind: k }) }),
      h('div', { class: 'qr' }, qrElement(`firo:${a.address}`)),
      h('div', { class: 'address-box' }, h('p', { class: 'mono', 'data-testid': 'addr-sheet-address', text: a.address })),
      h('p', { class: 'small', text: holdsLine(a) }),
      copyButton(a.address),
      textButton(t('Close'), () => close()),
    ], { label: t('Address') });
  }

  function row(a, k) {
    return h(
      'button',
      { type: 'button', class: 'row', 'data-testid': 'addr-row', 'data-kind': k, 'data-address': a.address, onclick: () => details(a, k) },
      h('div', { class: 'ico' }, icon(k === 'spark' ? 'spark' : 'eye')),
      h(
        'div',
        { class: 'main' },
        h('div', { class: 't addr-title' }, h('span', { 'data-testid': 'addr-name', text: ownAddressName({ ...a, kind: k }) }), a.current ? h('span', { class: `tag ${k === 'spark' ? 'private' : 'public'}`, 'data-testid': 'addr-current', text: t('On Receive') }) : null),
        h('div', { class: 's mono', text: shorten(a.address, 12, 8) }),
        h('div', { class: 's', 'data-testid': 'addr-holds', text: holdsLine(a) }),
      ),
    );
  }

  function renderKinds() {
    put(
      kindBox,
      ...KINDS.map((id) =>
        h(
          'button',
          { type: 'button', class: `seg${kind === id ? ' on' : ''}`, role: 'radio', 'aria-checked': String(kind === id), 'data-testid': `addr-kind-${id}`, onclick: () => ((kind = id), renderKinds(), render()) },
          h('span', { class: 'seg-t' }, icon(id === 'spark' ? 'spark' : 'eye'), id === 'spark' ? 'Spark' /* i18n-ignore: a name, the same in every language */ : t('Transparent')),
          h('span', { class: 'seg-s', text: book ? String(book[id].length) : '' }),
        ),
      ),
    );
  }

  /** A full address in the search: whose it is, said at once (Spark: read with the view key). */
  async function checkWhole(text) {
    const seq = ++checkSeq;
    put(verdict);
    if (text.length < WHOLE) return;
    const w = await wallet.whoseAddress(text).catch(() => null);
    if (seq !== checkSeq || !w) return;
    if (w.kind !== 'spark' && w.kind !== 'transparent' && w.kind !== 'exchange') return;
    if (w.mine) {
      // A view-only wallet watches someone's addresses: never "yours" (audit of 0.1.15, M2).
      const words = wallet.state.viewOnly
        ? t('Yes, this address belongs to the wallet you are watching: {name}.', { name: ownAddressName(w) })
        : t('Yes, this address is yours: {name}. Payments to it come to this wallet.', { name: ownAddressName(w) });
      put(verdict, notice('success', h('span', { 'data-testid': 'addr-mine', text: words })));
      if (w.kind !== kind && KINDS.includes(w.kind)) {
        kind = w.kind;
        renderKinds();
        render(false);
      }
    } else if (w.unknown) {
      // Nothing is said either way when this wallet cannot tell (audit of 0.1.15, L2).
      put(verdict, notice('info', h('span', { 'data-testid': 'addr-unknown', text: w.kind === 'exchange' ? t('This is an exchange (EX) address. This wallet does not follow those, so it cannot say whose it is.') : t('This wallet cannot check this kind of address, so it cannot say whose it is.') })));
    } else {
      // Spark: certain (the view key would have found it). Public: only the addresses this wallet follows are known.
      put(verdict, notice('warn', h('span', { 'data-testid': 'addr-not-mine', text: w.kind === 'spark' ? t('This Spark address is not one of this wallet’s. Payments to it go to someone else.') : t('This address is not one this wallet follows. Payments to it do not come here.') })));
    }
  }

  function render(check = true) {
    if (!book) return;
    const q = search.value.trim().toLowerCase();
    if (check) checkWhole(search.value.trim());
    // A whole address pasted: its row if it is listed, else the whole list (the check above says whose it is).
    const whole = q.length >= WHOLE;
    let list = book[kind].filter((a) => !q || (whole ? a.address.toLowerCase() === q : a.address.toLowerCase().includes(q) || ownAddressName({ ...a, kind }).toLowerCase().includes(q)));
    if (whole && !list.length) list = book[kind];
    const note = kind === 'spark'
      ? t('Only this wallet can tell that these Spark addresses are its own. To everyone else they are unrelated.')
      : t('Public addresses and what they hold can be seen by anyone. Change addresses hold what came back to you from your own public payments.');
    put(
      body,
      list.length
        ? h('div', { class: 'card list', 'data-testid': `addr-list-${kind}` }, ...list.map((a) => row(a, kind)))
        : h('div', { class: 'card empty', 'data-testid': 'addr-none' }, h('p', { text: q ? t('No address of this list has “{q}” in it.', { q: search.value.trim() }) : t('No addresses yet. Receive shows the first one.') })),
      h('p', { class: 'small', text: note }),
    );
  }

  async function load() {
    try {
      book = await wallet.myAddresses();
    } catch (e) {
      put(body, notice('error', t('Your addresses could not be read: {message}', { message: e.message })), secondary(t('Try again'), load));
      return;
    }
    renderKinds();
    render();
  }

  renderKinds();
  put(body, h('div', { class: 'spinner' }));
  load();
  return { el: screen({ title: t('My addresses'), back: () => app.back('receive') }, search, verdict, kindBox, body) };
}

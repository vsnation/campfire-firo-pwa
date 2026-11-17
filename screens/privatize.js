/* Privatize / Make public: moving FIRO between this wallet's own two balances
 * Spec: ONE job: move the amount I choose between my public (transparent) and private (Spark) balance,
 *       either way (owner, 2026-11-17: "we can't do limitations to the user to insist for them to use
 *       only private transactions"; Campfire has "Anonymize all" only).
 *       Primary CTA: "Privatize <amount> FIRO" / "Make <amount> FIRO public" (then Face ID / password).
 *       Taps from app open: 1 (Home's "Privatize" pill, or "Make FIRO public" under it), 2 to confirm.
 *       Privatize opens with the whole public balance in (Campfire's one tap); Make public opens empty.
 * Exit-intent reasons and answers:
 *   - "What does it do?" -> From / To say which balance, in words; the notice says what each means:
 *     private is hidden on the blockchain, public can be followed by anyone. Facts, never a push.
 *   - "Can I choose how much?" -> the amount box, and quick picks under it: 25%, 50%, 75% of the
 *     balance that pays (the fee on top), All (everything, the fee taken from it); the other way is
 *     one tap at the top.
 *   - "What does it cost?" -> the network fee, worked out for that amount before anything moves, and
 *     what arrives and what leaves.
 *   - "Nothing to move?" -> says so, with the way back (and the other way, if that balance has FIRO).
 *   - "The connection dropped: did it go?" -> never "nothing was moved" then (audit FM-1): the
 *     status screen says it may have left and follows it.
 *   - "I went back while it was moving" -> one payment at a time (lib/payment_flight.js): opened
 *     again meanwhile, it says the last payment is still being sent and offers nothing; a run left
 *     before the password never opens it; one left after it is said where the person is, never by
 *     taking them to its status screen (release verification 0.1.8).
 * Both ways are an ordinary payment of the engine (privatize: a mint to this wallet's Spark address;
 * make public: a Spark spend to this wallet's public address), so every check of a payment applies:
 * the figures shown or nothing (expect), one at a time, let-go payments' coins, the second node.
 */
import { h, put } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { screen, primary, notice, textButton, toast, holdTaps } from '../lib/ui.js';
import { formatAmount, parseAmount, toInputString, UNIT } from '../lib/amount.js';
import { wallet } from '../lib/wallet.js';
import { confirmIdentity } from '../lib/auth_ui.js';
import { sendOutcome, UNSURE_TITLE } from '../lib/send_outcome.js';
import { paymentInFlight, startPayment, onPaymentFlight, IN_FLIGHT_TEXT, IN_FLIGHT_NOTE } from '../lib/payment_flight.js';
import { t, asSentence } from '../lib/i18n.js';

/** The two ways, by route: which balance pays, which receives, and the words of each. */
const WAYS = {
  privatize: {
    from: 'public',
    to: 'private',
    title: () => t('Privatize'),
    cta: (amount) => t('Privatize {amount} {UNIT}', { amount, UNIT }),
    confirm: () => t('Confirm privatizing'),
    detail: (amount) => t('{amount} {UNIT} from your public balance into your private balance.', { amount, UNIT }),
    busy: () => t('Privatizing…'),
    note: () => t('Public FIRO can be followed on the blockchain by anyone. Once private, nobody can see how much you have or where it goes.'),
    noteKind: 'success',
    arrives: () => t('Arrives privately'),
    leaves: () => t('Leaves your public balance'),
    available: (amount) => t('Available: {amount} {UNIT} (public)', { amount, UNIT }),
    all: () => t('Everything in your public balance; the network fee comes out of it.'),
    tooMuch: (amount) => t('That\'s more than your public balance can move now ({amount} {UNIT}).', { amount, UNIT }),
    empty: () => t('Your public balance is empty: there is nothing to privatize.'),
    arriving: (amount) => t('{amount} {UNIT} is arriving publicly. You can privatize it once it is confirmed.', { amount, UNIT }),
    unchanged: () => t('Your last payment is still being sent, so nothing was moved. Privatize once it has left.'),
    toast: (amount) => t('Privatizing {amount} {UNIT}: it shows in Activity.', { amount, UNIT }),
    feeChangedAway: () => t('The network fee changed, so nothing was moved. Open Privatize to check the new figures.'),
    feeChanged: () => t('The network fee or your public balance changed, so nothing was moved. Check the new figures, then privatize.'),
    lookFirst: (value) => t('Firo PWA couldn\'t tell whether it went through: {value} Look in Activity before you privatize again.', { value }),
    working: () => t('Working out the network fee first. Check it, then privatize.'),
    feeFailed: () => t("The network fee couldn't be worked out just now. Tap Privatize to try again."),
  },
  makePublic: {
    from: 'private',
    to: 'public',
    title: () => t('Make public'),
    cta: (amount) => t('Make {amount} {UNIT} public', { amount, UNIT }),
    confirm: () => t('Confirm making public'),
    detail: (amount) => t('{amount} {UNIT} from your private balance into your public balance.', { amount, UNIT }),
    busy: () => t('Making public…'),
    note: () => t('Once public, anyone can see this amount on the blockchain, and where it goes next. You can privatize it again at any time.'),
    noteKind: 'info',
    arrives: () => t('Arrives publicly'),
    leaves: () => t('Leaves your private balance'),
    available: (amount) => t('Available: {amount} {UNIT} (private)', { amount, UNIT }),
    all: () => t('Everything in your private balance; the network fee comes out of it.'),
    tooMuch: (amount) => t('That\'s more than your private balance can move now ({amount} {UNIT}).', { amount, UNIT }),
    empty: () => t('Your private balance is empty: there is nothing to make public.'),
    arriving: (amount) => t('{amount} {UNIT} is arriving privately. You can make it public once it is confirmed.', { amount, UNIT }),
    unchanged: () => t('Your last payment is still being sent, so nothing was moved. Make it public once that one has left.'),
    toast: (amount) => t('Making {amount} {UNIT} public: it shows in Activity.', { amount, UNIT }),
    feeChangedAway: () => t('The network fee changed, so nothing was moved. Open Make public to check the new figures.'),
    feeChanged: () => t('The network fee or your private balance changed, so nothing was moved. Check the new figures, then make it public.'),
    lookFirst: (value) => t('Firo PWA couldn\'t tell whether it went through: {value} Look in Activity before you make it public again.', { value }),
    working: () => t('Working out the network fee first. Check it, then make it public.'),
    feeFailed: () => t("The network fee couldn't be worked out just now. Tap Make public to try again."),
  },
};

/** Home's Privatize pill: public -> private, opened with the whole public balance in. */
export default function privatize(app, params) {
  return moveScreen(app, 'privatize', params);
}

/** Home's "Make FIRO public": private -> public, opened empty. */
export function makePublic(app, params) {
  return moveScreen(app, 'makePublic', params);
}

/** p percent of `have` (BigInt sats), rounded down to a whole satoshi. */
const share = (have, p) => (have * BigInt(p)) / 100n;

function moveScreen(app, way, params = {}) {
  const w = WAYS[way];
  const body = h('div', { class: 'stack' }); // spaced as Review's content: the notices never touch
  const msg = h('div', { 'aria-live': 'polite' });
  const cta = primary(w.title(), go, { disabled: true, 'data-testid': 'privatize-confirm' });
  // Its buttons, changed with the state, inside the screen's own sticky row (on a 375 x 667 phone the
  // button stays in sight under the figures, as Send's).
  const actions = h('div', { class: 'move-actions' });
  const amount = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', placeholder: '0', 'aria-label': t('Amount'), 'data-testid': 'move-amount' });
  // Quick picks under the box (owner, 2026-11-17: "like 25%, hotkeys for that"): a share of the
  // balance that pays; All is everything, the fee taken from it.
  const PICKS = [25, 50, 75, 100];
  const pickBtns = PICKS.map((p) => h('button', { class: 'chip', type: 'button', 'data-testid': p === 100 ? 'move-max' : `move-pct-${p}`, 'aria-pressed': 'false', onclick: () => pick(p) }, p === 100 ? t('All') : `${p}%`)); // i18n-ignore: a percentage
  const picks = h('div', { class: 'move-picks', role: 'group', 'aria-label': t('How much') }, ...pickBtns);
  const amountHint = h('p', { class: 'hint', 'data-testid': 'move-amount-hint' });
  // Max: everything in the balance that pays, the fee taken from it. Privatize opens that way (the
  // one tap of Campfire's "Anonymize all"); Make public opens empty: nothing is made public unasked.
  // An amount carried over from the other way (the switch at the top) stays as typed.
  let all = params.amount == null && way === 'privatize';
  let pct = all ? 100 : null; // the quick pick in force, null once the amount is typed
  amount.value = params.amount != null ? String(params.amount) : '';
  let quoted = null; // {amount, subtractFee, fee, total} as shown: exactly what is moved
  let quoteFor = null; // the key of the request under way or answered
  let quoteErr = null;
  let feeFailed = false; // the last estimate failed: asked again on a tap, not in a loop (audit L1)
  let busy = false;
  let alive = true; // false once the screen is left (destroy)
  let quoteTimer = null;
  let typing = false; // the last change was a key: the fee is asked once typing pauses (250 ms)

  const avail = () => wallet.available(w.from);
  const dest = () => wallet.state.receive[w.to === 'private' ? 'spark' : 'transparent'];

  /** The amount in the box, or with Max the whole balance: {amt, err}. */
  function amountValue() {
    if (all) return { amt: avail() > 0n ? avail() : null, err: null };
    if (!amount.value.trim()) return { amt: null, err: null };
    try {
      const amt = parseAmount(amount.value);
      return amt <= 0n ? { amt: null, err: t('The amount must be more than zero.') } : { amt, err: null };
    } catch (e) {
      return { amt: null, err: e.message };
    }
  }

  /** The fee for this amount, as a payment of it to this wallet's own address of the other balance. */
  function requestQuote(now = false) {
    clearTimeout(quoteTimer);
    const { amt, err } = amountValue();
    if (amt == null || err || amt > avail() || !dest() || !wallet.state.sync.canSend) return;
    const key = `${amt}:${all}:${dest()}`;
    if (key === quoteFor) return;
    quoteFor = key;
    quoted = null;
    quoteErr = null;
    const ask = async () => {
      typing = false;
      try {
        const q = await wallet.quote({ from: w.from, to: [{ address: dest(), amount: amt }], subtractFee: all });
        if (quoteFor !== key) return;
        quoted = { amount: amt, subtractFee: all, address: dest(), fee: q.fee, total: q.total };
        feeFailed = false;
      } catch (e) {
        if (quoteFor !== key) return;
        // Asked again on the next tap or change (audit L1: every tap after one failure said "working
        // out the fee" and asked nothing, until the screen was opened again).
        quoteFor = null;
        if (e && ['insufficient', 'dust'].includes(e.code)) quoteErr = { e, key };
        else feeFailed = true;
      }
      render();
    };
    if (now) ask();
    else quoteTimer = setTimeout(ask, 250);
  }

  // Built once: typing into the amount never loses focus to a re-render (only the parts below change).
  const seg = (id, label, ico) =>
    h(
      'button',
      { type: 'button', class: `seg${id === way ? ' on' : ''}`, role: 'radio', 'aria-checked': String(id === way), 'data-testid': `move-way-${id}`, onclick: () => !busy && id !== way && app.go(id, all || !amount.value.trim() ? {} : { amount: amount.value }, { replace: true }) },
      h('span', { class: 'seg-t' }, icon(ico), label),
      h('span', { class: 'seg-s', text: id === 'privatize' ? t('Public → Private') : t('Private → Public') }),
    );
  // Which way: one tap to the other, the amount kept.
  const ways = h('div', { class: 'segmented from-pick', role: 'radiogroup', 'aria-label': t('Move') }, seg('privatize', t('Privatize'), 'privatize'), seg('makePublic', t('Make public'), 'eye'));
  const checkBox = h('div');
  const card = h('div', { class: 'card' });
  const notes = h('div', { class: 'stack' });
  const form = h(
    'div',
    { class: 'stack' },
    h('label', { class: 'field' }, h('span', { class: 'banner' }, h('span', { class: 'grow', text: t('Amount') }), h('span', { class: 'small', text: UNIT })), amount),
    picks,
    amountHint,
    checkBox,
    card,
    notes,
    msg,
  );
  const emptyBox = h('div');

  function render() {
    if (!alive) return;
    // A payment from another screen (or this one, opened again) still being sent: nothing new until it has left.
    const other = !busy && Boolean(paymentInFlight());
    const b = wallet.state.balance;
    const have = avail();
    const sync = wallet.state.sync;
    const kv = (k, v, testid) => h('div', { class: 'kv' }, h('span', { class: 'k', text: k }), h('span', { class: 'v', 'data-testid': testid, text: v }));
    if (have <= 0n) {
      const pending = b[w.from].pending ?? 0n;
      // What the last attempt said stays in sight (an "All" in doubt leaves the balance at 0: release audit of 0.1.21).
      put(emptyBox, h('div', { class: 'card empty', 'data-testid': 'privatize-empty' }, icon(way === 'privatize' ? 'privatize' : 'eye'), h('p', { text: pending > 0n ? w.arriving(formatAmount(pending)) : w.empty() })), msg);
      if (body.lastChild !== emptyBox) put(body, ways, emptyBox);
      put(actions, primary(t('Back to Home'), () => app.go('home'), { 'data-testid': 'privatize-home' }));
      return;
    }
    if (body.lastChild !== form) put(body, ways, form);
    if (msg.parentNode !== form) form.appendChild(msg);
    if (all && amount.value !== toInputString(have)) amount.value = toInputString(have);
    // A share follows the balance while it is in force (a payment arriving meanwhile).
    if (pct != null && !all && amount.value !== toInputString(share(have, pct))) amount.value = toInputString(share(have, pct));
    const { amt, err } = amountValue();
    let amtErr = err;
    if (!amtErr && amt != null && amt > have) amtErr = w.tooMuch(formatAmount(have));
    // An amount error the engine gave, for this very amount (a coin arriving changes the key: release audit of 0.1.21).
    if (!amtErr && quoteErr && amt != null && quoteErr.key === `${amt}:${all}:${dest()}`) amtErr = quoteErr.e.message;
    amountHint.textContent = amtErr || (all ? w.all() : w.available(formatAmount(have)));
    amountHint.className = `hint${amtErr ? ' bad' : ''}`;
    amount.classList.toggle('bad', Boolean(amtErr));
    const shown = quoted && amt != null && !amtErr && quoted.amount === amt && quoted.subtractFee === all && quoted.address === dest() ? quoted : null;
    if (shown == null && amt != null && !amtErr && !feeFailed) requestQuote(!typing);
    // Private FIRO one node showed is moved only once a second one confirmed it, as in Send (0.1.11).
    const checking = way === 'makePublic' ? b.private.checking ?? 0n : 0n;
    const pp = wallet.state.privateProof;
    const done = pp ? Math.min(99, Math.floor((pp.done / pp.total) * 100)) : null;
    put(checkBox, checking > 0n ? h('p', { class: 'hint', 'data-testid': 'move-checking', text: done != null ? t('{amount} FIRO more can be sent once a second Firo node has checked it ({pct}% done).', { amount: formatAmount(checking), pct: done }) : t('{amount} FIRO more can be sent once a second Firo node has checked it.', { amount: formatAmount(checking) }) }) : null);
    const gets = shown ? (all ? shown.total - shown.fee : shown.amount) : null;
    put(
      card,
      kv(t('From'), w.from === 'public' ? t('Your public balance') : t('Your private balance'), 'privatize-from'),
      kv(t('To'), w.to === 'private' ? t('Your private balance') : t('Your public balance'), 'privatize-to'),
      kv(t('Network fee'), shown ? `${formatAmount(shown.fee)} ${UNIT}` : amt != null && !amtErr && !feeFailed ? t('Working it out…') : t('Shown once the amount is in'), 'privatize-fee'),
      shown ? kv(w.arrives(), `${formatAmount(gets)} ${UNIT}`, 'privatize-gets') : null,
      shown ? kv(w.leaves(), `${formatAmount(shown.total)} ${UNIT}`, 'privatize-total') : null,
    );
    put(
      notes,
      notice(w.noteKind, w.note()),
      sync.canSend ? null : notice('warn', `${asSentence(sync.title)}${sync.detail}`),
      other ? h('div', { 'data-testid': 'privatize-in-flight' }, notice('info', t(IN_FLIGHT_NOTE))) : null,
      feeFailed && !shown ? h('div', { 'data-testid': 'privatize-fee-failed' }, notice('warn', w.feeFailed())) : null,
    );
    amount.disabled = busy;
    pickBtns.forEach((btn, i) => {
      btn.disabled = busy;
      btn.classList.toggle('on', PICKS[i] === pct);
      btn.setAttribute('aria-pressed', String(PICKS[i] === pct));
    });
    cta.textContent = other ? t(IN_FLIGHT_TEXT) : busy ? w.busy() : shown ? w.cta(formatAmount(gets)) : w.title();
    // A failed estimate leaves the button on: a tap asks again (audit L1).
    cta.disabled = busy || other || !sync.canSend || amt == null || Boolean(amtErr) || (!shown && !feeFailed);
    if (actions.firstChild !== cta) put(actions, cta, textButton(t('Not now'), () => app.back('home'), { 'data-testid': 'privatize-cancel' }));
  }

  async function go() {
    if (busy || paymentInFlight()) return;
    const { amt, err } = amountValue();
    if (amt == null || err) return;
    // Only what was shown, with its fee: no fee worked out yet (or for another amount, another
    // balance, another address), nothing is moved.
    if (!quoted || quoted.amount !== amt || quoted.subtractFee !== all || quoted.address !== dest() || (all && amt !== avail())) {
      feeFailed = false;
      quoteFor = null;
      requestQuote(true);
      return put(msg, h('div', { 'data-testid': 'privatize-error' }, notice('info', w.working())));
    }
    const shown = quoted;
    const gets = shown.subtractFee ? shown.total - shown.fee : shown.amount;
    busy = true;
    cta.disabled = true;
    put(msg);
    const ok = await confirmIdentity(app, { title: w.confirm(), detail: w.detail(formatAmount(gets)), cta: t('Confirm') });
    // Left while the password was asked: nothing is moved.
    if (!alive) return;
    if (!ok) {
      busy = false;
      return render();
    }
    // Another payment took the one place meanwhile: this one waits for it (release verification 0.1.8).
    const release = startPayment(way);
    if (!release) {
      busy = false;
      render();
      put(msg, h('div', { 'data-testid': 'privatize-error' }, notice('info', w.unchanged())));
      return;
    }
    cta.textContent = w.busy();
    const expect = { fee: shown.fee, total: shown.total };
    try {
      const r = way === 'privatize'
        ? await wallet.privatize(shown.amount, { subtractFee: shown.subtractFee, expect })
        : await wallet.makePublic(shown.amount, { address: shown.address, subtractFee: shown.subtractFee, expect });
      // Its status screen, from this screen only: someone who moved on stays where they are.
      if (alive) app.go('txStatus', { txid: r.txid, kind: way, amount: gets, fee: shown.fee }, { replace: true });
      else toast(w.toast(formatAmount(gets)), 6000);
    } catch (e) {
      // "Nothing was moved" only when the engine says so (FM-1); a move that may have gone through
      // is followed on its status screen (the engine's half).
      const out = sendOutcome(e);
      if (out.kind === 'unsure') {
        if (alive) app.go('txStatus', { txid: out.txid, kind: way, unsure: true, amount: gets, fee: shown.fee }, { replace: true });
        else toast(t('{title} Follow it in Activity.', { title: t(UNSURE_TITLE) }), 8000);
        return;
      }
      if (e && e.code === 'fee-changed') {
        // Nothing was built: the new figures are worked out and shown, and the person decides.
        if (!alive) return toast(w.feeChangedAway(), 8000);
        busy = false;
        quoted = null;
        quoteFor = null;
        render();
        put(msg, h('div', { 'data-testid': 'privatize-error' }, notice('warn', w.feeChanged())));
        return;
      }
      const words = out.kind === 'not-sent' ? t('Nothing was moved: {value}', { value: e.message || e }) : w.lookFirst(e.message || e);
      if (!alive) return toast(words, 8000);
      busy = false;
      render();
      put(msg, h('div', { 'data-testid': 'privatize-error' }, notice('error', words)));
    } finally {
      release();
    }
  }

  /** A quick pick: All moves everything, the fee taken from it; a share moves that part, the fee on top. */
  function pick(p) {
    const have = avail();
    if (have <= 0n) return;
    all = p === 100;
    pct = p;
    if (!all) amount.value = toInputString(share(have, p));
    quoteErr = null;
    feeFailed = false;
    render();
  }

  amount.addEventListener('input', () => {
    typing = true;
    all = false;
    pct = null;
    quoteErr = null;
    feeFailed = false;
    render();
  });

  const off = wallet.onChange(() => !busy && render());
  const offFlight = onPaymentFlight(() => !busy && render());
  render();
  const el = screen({ title: w.title(), back: () => app.back('home'), actions: [actions], cls: 'sticky-actions' }, body);
  // Home's Privatize sits where this screen's button is: the second tap of a double tap is held.
  const hold = holdTaps(el);
  return {
    el,
    destroy: () => {
      alive = false;
      clearTimeout(quoteTimer);
      hold.stop();
      off();
      offFlight();
    },
  };
}

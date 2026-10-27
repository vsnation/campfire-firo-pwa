// What system back means on a screen (lib/back.js), and what it does to the browser's history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { backAction, stepsFor, entriesUnder, installBack, SECRET_SCREENS } from '../../src/lib/back.js';
import { navHistory } from '../../src/lib/nav.js';

test('a sheet first, then a layer, then the screen\'s own Back, then tabs to Wallet; every other screen stays', () => {
  const btn = {};
  assert.equal(backAction({ overlays: [{}], backButton: btn, screenName: 'send' }), 'sheet');
  assert.equal(backAction({ overlays: [{}], backButton: null, screenName: 'home' }), 'sheet');
  assert.equal(backAction({ overlays: [{}], layerBack: btn, backButton: btn, screenName: 'bridge' }), 'sheet');
  assert.equal(backAction({ overlays: [], layerBack: btn, backButton: btn, screenName: 'bridge' }), 'layer');
  assert.equal(backAction({ overlays: [], backButton: btn, screenName: 'about' }), 'button');
  assert.equal(backAction({ overlays: [], backButton: btn, screenName: 'ethStart' }), 'button');
  for (const s of ['settings', 'activity', 'ethHome', 'ethStart']) assert.equal(backAction({ overlays: [], backButton: null, screenName: s }), 'home', s);
  // Wallet, Welcome and Unlock are the first entry; a screen with no Back of its own (a payment's
  // status, a setup step) stays put.
  for (const s of ['home', 'welcome', 'unlock', 'txStatus', 'install', 'fastStart', 'backup', 'problem']) assert.equal(backAction({ overlays: [], backButton: null, screenName: s }), 'stay', s);
});

test('the steps above the first entry: Wallet under a tab, each screen Back returns through, a layer, each sheet', () => {
  assert.equal(stepsFor({ name: 'home' }), 0);
  assert.equal(stepsFor({ name: 'unlock' }), 0);
  assert.equal(stepsFor({ name: 'settings' }), 1);
  assert.equal(stepsFor({ name: 'ethStart' }), 1, 'the Ethereum side itself');
  assert.equal(stepsFor({ name: 'ethStart', params: { from: 'settings' }, trail: [{ name: 'settings' }] }), 2, 'a step of Settings');
  assert.equal(stepsFor({ name: 'send', trail: [{ name: 'home' }] }), 1);
  assert.equal(stepsFor({ name: 'about', trail: [{ name: 'settings' }] }), 2);
  assert.equal(stepsFor({ name: 'ownNode', trail: [{ name: 'settings' }, { name: 'nodeSettings' }], layer: true, sheets: 2 }), 6);
});

test('entries under the page: in a Home Screen app any; in a tab an earlier page of this app, by the Navigation API', () => {
  const win = (o) => ({ history: { length: 3 }, matchMedia: () => ({ matches: false }), ...o });
  assert.equal(entriesUnder(win({ navigation: { currentEntry: { index: 2 } } })), true);
  assert.equal(entriesUnder(win({ navigation: { currentEntry: { index: 0 } } })), false, 'the pages before are other sites');
  assert.equal(entriesUnder(win({})), false, 'no Navigation API: a Back leaves, as in any site');
  assert.equal(entriesUnder(win({ navigator: { standalone: true } })), true);
  assert.equal(entriesUnder(win({ navigator: { standalone: true }, navigation: { currentEntry: { index: 0 } } })), true);
  assert.equal(entriesUnder(win({ matchMedia: (q) => ({ matches: q === '(display-mode: standalone)' }) })), true);
  assert.equal(entriesUnder(win({ navigator: { standalone: true }, history: { length: 1 } })), false, 'opened from its icon: nothing under it');
});

/**
 * A browser and an app, with just what installBack touches. The history is the browser's: entries
 * of other pages (or of an earlier page of the app), this page's own, then what the app adds;
 * traversals arrive later (settle()), as in a browser. Like Safari, each entry keeps a picture of
 * what was painted when it was left, and a swipe shows the picture of the entry it goes to. Like
 * the browsers, the person's Back skips entries added without a tap: Chrome those added with no tap
 * since its last Back (the entry left is marked), Safari those added over 10 s after a tap (the
 * entry added is marked, and a Back from it skips the one before too).
 */
function world({ before = 1, standalone = false, engine = 'chrome', fallback = {} } = {}) {
  const on = {};
  const observers = [];
  const entries = [...Array.from({ length: before }, (_, i) => ({ page: `before ${i}`, state: null })), { page: 'app', state: null }];
  let idx = before;
  let left = false;
  let clock = 1e6;
  let lastTap = -Infinity;
  let gesture = false; // Chrome: a tap since the last Back
  const queue = [];
  let frames = [];
  let afterPaint = [];
  let painted = null;
  const nav = navHistory();
  const ui = { overlays: [], layer: null, loading: false, secretPart: false };
  const shown = () => (app.currentName || '') + (ui.layer ? '+layer' : '') + '+sheet'.repeat(ui.overlays.length) + (ui.secretPart ? '+words' : '');
  const mutate = () => observers.forEach((f) => f([]));
  const fire = (t) => [...(on[t] || [])].forEach((f) => f({}));
  const arrive = (i) => {
    entries[idx].picture = painted;
    idx = i;
    if (idx >= 0 && entries[idx].page === 'app') fire('popstate');
    else left = true;
  };
  const app = {
    currentName: null,
    params: {},
    current: null,
    nav,
    go(name, params = {}, opts = {}) {
      nav.move(this.currentName ? { name: this.currentName, params: this.params } : null, { name, params }, opts);
      ui.overlays = [];
      ui.layer = null;
      ui.secretPart = false;
      this.currentName = name;
      this.params = params;
      this.current = {};
      mutate();
    },
    back(f = 'home') {
      const t = nav.backTarget(f);
      this.go(t.name, t.params, t.opts);
    },
  };
  // A screen still loading its code has no top bar yet.
  const backButton = () => (fallback[app.currentName] && !ui.loading ? { click: () => app.back(fallback[app.currentName]) } : null);
  let between = null;
  const win = {
    history: {
      get state() {
        return entries[idx].state;
      },
      get length() {
        return entries.length;
      },
      pushState(state) {
        if (engine === 'chrome' && !gesture) entries[idx].marked = true;
        entries[idx].picture = painted;
        entries.splice(idx + 1);
        entries.push({ page: 'app', state, marked: engine === 'webkit' && clock - lastTap > 10000 });
        idx++;
      },
      replaceState(state) {
        entries[idx].state = state;
      },
      go(d) {
        queue.push(d);
      },
    },
    navigator: { standalone },
    matchMedia: () => ({ matches: false }),
    document: {
      body: {},
      querySelectorAll: (sel) => (sel === '.overlay' ? ui.overlays : []),
      querySelector: () => (ui.secretPart ? {} : null),
      getElementById: () => ({
        querySelector: (sel) => (sel === '[data-back]' ? ui.layer : sel === '.topbar button[data-nav="back"]' ? backButton() : sel.includes('aria-busy') ? (ui.loading ? {} : null) : null),
      }),
    },
    MutationObserver: class {
      constructor(f) {
        this.f = f;
      }
      observe() {
        observers.push(this.f);
      }
    },
    requestAnimationFrame: (f) => frames.push(f),
    setTimeout: (f, ms) => (ms ? setTimeout(f, ms) : afterPaint.push(f)),
    addEventListener: (t, f) => (on[t] = on[t] || []).push(f),
    removeEventListener: (t, f) => (on[t] = (on[t] || []).filter((x) => x !== f)),
  };
  const w = {
    app,
    ui,
    win,
    fire,
    mutate,
    /** Traversals the page asked for arrive, one after another, then a frame is painted; until all is still. */
    settle() {
      for (let i = 0; i < 60; i++) {
        while (queue.length && !left) {
          const d = queue.shift();
          const to = idx + d;
          if (to >= 0 && to < entries.length) arrive(to);
        }
        const f = frames;
        frames = [];
        f.forEach((x) => x());
        painted = shown();
        // Something that happens after a frame was painted and before what waited for it.
        if (between) {
          const b = between;
          between = null;
          b();
        }
        const a = afterPaint;
        afterPaint = [];
        a.forEach((x) => x());
        if (!queue.length && !frames.length && !afterPaint.length) return;
      }
      throw new Error('never still');
    },
    /** A tap (or key), as the browsers count them: when the finger lifts. */
    tap() {
      lastTap = clock;
      gesture = true;
      fire('pointerup');
      w.settle();
    },
    /** Runs `f` in the next settle, after a frame is painted and before what waited for that frame. */
    between(f) {
      between = f;
    },
    /** Time passes with no tap. */
    idle(ms) {
      clock += ms;
    },
    /** The person's Back: the picture the swipe showed, and the screen it ended on. */
    swipe() {
      let to = idx - 1;
      if (engine === 'chrome') while (to >= 0 && entries[to].marked) to--;
      else if (entries[idx].marked) to--;
      gesture = false;
      const picture = to >= 0 ? entries[to].picture : null;
      arrive(to);
      w.settle();
      return { picture, landed: shown() };
    },
    /** The person's Forward (Safari: a swipe from the right edge): the picture it showed. */
    forward() {
      if (idx + 1 >= entries.length) return null;
      const picture = entries[idx + 1].picture;
      gesture = false;
      arrive(idx + 1);
      w.settle();
      return picture;
    },
    go(name, params, opts) {
      app.go(name, params, opts);
      w.settle();
    },
    sheet(dismissable = true) {
      const s = { dataset: { dismissable: dismissable ? '1' : '0' }, events: [] };
      s.dispatchEvent = (e) => {
        s.events.push(e.type);
        if (e.type === 'campfire:dismiss') {
          ui.overlays = ui.overlays.filter((o) => o !== s);
          mutate();
        }
      };
      ui.overlays = [...ui.overlays, s];
      mutate();
      w.settle();
      return s;
    },
    /** The entry on show, counted from the page's own, and how many lie ahead of it. */
    at: () => (entries[idx] && entries[idx].state ? entries[idx].state.n : null),
    ahead: () => entries.length - 1 - idx,
    left: () => left,
    /** Every picture the history keeps, but the one of the entry on show (it is not shown). */
    pictures: () => entries.filter((e, i) => i !== idx && e.picture).map((e) => e.picture),
    marked: () => entries.some((e) => e.page === 'app' && e.marked),
    /** The traversals asked for are lost. */
    drop: () => queue.splice(0),
  };
  installBack(app, win);
  return w;
}

const FALLBACK = { send: 'home', review: 'send', about: 'settings', nodeSettings: 'settings', ownNode: 'nodeSettings', backup: 'settings', confirmWords: 'backup', restore: 'welcome', setPassword: 'confirmWords' };
const secretIn = (pictures) => pictures.filter((p) => SECRET_SCREENS.has(p.split('+')[0]) || p.includes('+words'));

for (const engine of ['chrome', 'webkit']) {
  test(`${engine}: nothing is added before the first tap; then one entry for each step a Back can take`, () => {
    const w = world({ engine, fallback: FALLBACK });
    w.go('home');
    w.go('settings');
    assert.equal(w.at(), null, 'no entry before a tap: it would be skipped');
    w.tap();
    assert.equal(w.at(), 1, 'Settings: one step, back to Wallet');
    w.go('about');
    assert.equal(w.at(), 2);
    w.go('home');
    assert.equal(w.at(), 0, 'the Wallet tab goes back over the entries');
    w.tap();
    w.go('send');
    assert.equal(w.at(), 1);
    assert.equal(w.ahead(), 0, 'nothing ahead for Forward');
    assert.equal(w.marked(), false);
  });

  test(`${engine}: each swipe shows the screen it opens, and ends on it`, () => {
    const w = world({ engine, fallback: FALLBACK });
    w.go('unlock');
    w.tap(); // the first tap: on Unlock
    w.go('home', {}, { reset: true });
    for (const s of ['settings', 'nodeSettings', 'ownNode']) {
      w.tap();
      w.go(s);
    }
    assert.equal(w.at(), 3);
    for (const want of ['nodeSettings', 'settings', 'home']) assert.deepEqual(w.swipe(), { picture: want, landed: want });
    assert.equal(w.left(), false);
    w.swipe();
    assert.equal(w.left(), true, 'a Back on Wallet leaves, in a browser tab');
  });

  test(`${engine}: the app's own Back goes back over the entries too, so a later swipe still shows the right screen`, () => {
    const w = world({ engine, fallback: FALLBACK });
    w.go('home');
    for (const s of ['settings', 'nodeSettings', 'ownNode']) {
      w.tap();
      w.go(s);
    }
    w.tap();
    w.app.back('nodeSettings'); // the top bar's Back
    w.settle();
    assert.equal(w.at(), 2);
    assert.deepEqual(w.swipe(), { picture: 'settings', landed: 'settings' });
    w.tap();
    w.go('about');
    assert.equal(w.ahead(), 0);
    assert.deepEqual(w.swipe(), { picture: 'settings', landed: 'settings' });
  });

  test(`${engine}: a sheet has its own entry: a swipe closes it and shows the screen under it`, () => {
    const w = world({ engine, fallback: FALLBACK });
    w.go('home');
    w.tap();
    w.go('send');
    w.tap();
    const s = w.sheet();
    assert.equal(w.at(), 2);
    assert.deepEqual(w.swipe(), { picture: 'send', landed: 'send' });
    assert.deepEqual(s.events, ['campfire:dismiss']);
    assert.equal(w.at(), 1);
    // Closed by its own button: the entry goes too.
    w.tap();
    w.sheet();
    w.ui.overlays = [];
    w.mutate();
    w.settle();
    assert.equal(w.at(), 1);
    assert.deepEqual(w.swipe(), { picture: 'home', landed: 'home' });
  });

  test(`${engine}: on a sheet that holds a payment, Back after Back (no tap) is asked of the sheet and never leaves the app`, () => {
    const w = world({ engine, before: 2, standalone: true, fallback: FALLBACK });
    w.go('home');
    w.tap();
    w.go('send');
    w.tap();
    const s = w.sheet(false);
    for (let i = 0; i < 5; i++) w.swipe();
    assert.deepEqual(s.events, Array(5).fill('campfire:beside'), 'the sheet decides (its way out, or nothing while it signs)');
    assert.equal(w.app.currentName, 'send', 'the screen underneath did not move');
    assert.equal(w.left(), false, 'the page is still there: the payment is not cut off');
    assert.equal(w.marked(), false);
  });

  test(`${engine}: a layer closes before the screen goes back; a tab goes to Wallet; a screen with no Back stays, its own picture under it`, () => {
    const w = world({ engine, fallback: FALLBACK });
    w.go('home');
    w.tap();
    w.go('send');
    let closed = 0;
    w.tap();
    w.ui.layer = {
      click: () => {
        closed++;
        w.ui.layer = null;
        w.mutate();
      },
    };
    w.mutate();
    w.settle();
    assert.equal(w.at(), 2);
    assert.deepEqual(w.swipe(), { picture: 'send', landed: 'send' });
    assert.equal(closed, 1);
    w.tap();
    w.go('home');
    w.go('activity');
    assert.deepEqual(w.swipe(), { picture: 'home', landed: 'home' });
    w.tap();
    w.go('send');
    w.tap();
    w.go('review');
    w.go('txStatus', {}, { replace: true });
    for (let i = 0; i < 3; i++) assert.deepEqual(w.swipe(), { picture: 'txStatus', landed: 'txStatus' }, 'a payment status stays: not the filled Send form');
    assert.equal(w.left(), false);
  });

  test(`${engine}: in a Home Screen app with no earlier page under it, Wallet is the first entry: nothing to go back to`, () => {
    const w = world({ engine, before: 0, standalone: true, fallback: FALLBACK });
    w.go('home');
    w.tap();
    assert.equal(w.at(), 0);
    w.go('settings');
    assert.deepEqual(w.swipe(), { picture: 'home', landed: 'home' });
    assert.equal(w.left(), false);
  });

  test(`${engine}: after a reload (an earlier page under it), Back after Back on Wallet stays, with Wallet's picture, also after a long unlock and a long look`, () => {
    for (const unlockMs of [0, 15000]) {
      // The earlier page of the app lies under this one.
      const w = world({ engine, before: 2, standalone: true, fallback: FALLBACK });
      w.go('unlock');
      w.tap(); // Face ID on Unlock
      assert.equal(w.at(), 1, 'one entry kept under the first screen');
      w.idle(unlockMs);
      w.go('home', {}, { reset: true });
      for (let i = 0; i < 4; i++) assert.deepEqual(w.swipe(), { picture: 'home', landed: 'home' }, `unlock ${unlockMs} ms, swipe ${i}`);
      w.idle(15000); // looking at Wallet
      for (let i = 0; i < 4; i++) assert.deepEqual(w.swipe(), { picture: 'home', landed: 'home' });
      assert.equal(w.left(), false, 'never reaches the earlier page, which started the app again at Unlock');
      w.tap();
      w.go('settings');
      w.tap();
      w.go('about');
      for (const want of ['settings', 'home', 'home', 'home']) assert.deepEqual(w.swipe(), { picture: want, landed: want });
      assert.equal(w.left(), false);
      assert.equal(w.marked(), false);
    }
  });

  test(`${engine}: a screen the app opens by itself long after the last tap gets its entry (no Back since), and Back from it goes back`, () => {
    const w = world({ engine, before: 2, standalone: true, fallback: FALLBACK });
    w.go('home');
    w.tap();
    w.idle(30000);
    w.go('activity'); // "Payment received", tapped in the notification while the wallet is open
    assert.equal(w.at(), 2, 'its entry: no Back since the tap');
    assert.equal(w.swipe().landed, 'home');
    assert.equal(w.left(), false);
    w.tap();
    w.go('send');
    w.idle(30000);
    w.go('review'); // opened by itself (a slow step)
    assert.equal(w.at(), 3);
    assert.equal(w.swipe().landed, 'send', 'one screen back (Safari skips one more entry; the app steps up again)');
    assert.equal(w.left(), false);
    assert.equal(w.swipe().landed, 'home');
    assert.equal(w.left(), false);
  });

  test(`${engine}: words that appear just after a frame was noted are still never kept in a picture`, () => {
    const w = world({ engine, before: 0, standalone: true, fallback: FALLBACK });
    w.go('home');
    w.tap();
    w.go('settings');
    w.tap();
    w.mutate(); // a change: a frame is noted...
    w.between(() => w.app.go('backup')); // ...and Backup opens before what waited for it
    w.settle();
    w.ui.secretPart = true; // "Show the words": a class changes, no element comes or goes
    w.settle();
    w.tap();
    w.app.back('settings');
    w.settle();
    w.tap();
    w.settle();
    assert.equal(w.app.currentName, 'settings');
    assert.deepEqual(secretIn(w.pictures()), [], 'the picture taken while the words were up was taken anew');
    assert.equal(w.forward(), 'settings', 'Forward shows no words');
  });

  test(`${engine}: a screen still loading is not one that stays: the picture under it stays the screen before`, () => {
    const w = world({ engine, fallback: FALLBACK });
    w.go('home');
    w.tap();
    w.go('settings');
    w.tap();
    w.ui.loading = true;
    w.go('about');
    w.ui.loading = false;
    w.mutate();
    w.settle();
    assert.deepEqual(w.swipe(), { picture: 'settings', landed: 'settings' });
  });

  test(`${engine}: no picture of recovery words stays in the history: making a wallet, Settings → Backup, a swipe, a lock`, () => {
    const w = world({ engine, before: 0, standalone: true, fallback: FALLBACK });
    w.go('welcome');
    w.tap();
    w.go('backup');
    w.tap(); // shows the words
    w.ui.secretPart = true;
    w.mutate();
    w.settle();
    w.tap();
    w.go('confirmWords');
    w.tap();
    w.go('setPassword');
    w.tap();
    w.idle(3000);
    w.go('home', {}, { reset: true });
    assert.deepEqual(secretIn(w.pictures()), [], 'after making a wallet');
    const seen = [];
    for (let i = 0; i < 5; i++) seen.push(w.forward()); // Forward shows what lies ahead; the app steps back
    assert.deepEqual(secretIn(seen.filter(Boolean)), [], 'Forward never shows the words');
    assert.deepEqual(secretIn(w.pictures()), []);
    // Settings → Backup → the words in a sheet → the person swipes back twice.
    w.tap();
    w.go('home');
    w.tap();
    w.go('settings');
    w.tap();
    w.go('backup');
    w.tap();
    w.sheet();
    w.ui.secretPart = true;
    w.mutate();
    w.settle();
    w.swipe();
    w.ui.secretPart = false;
    w.mutate();
    w.settle();
    w.swipe();
    assert.equal(w.app.currentName, 'settings');
    assert.deepEqual(secretIn(w.pictures()), [], 'after swiping away from the words');
    // A lock while the words are on show.
    w.tap();
    w.go('backup');
    w.ui.secretPart = true;
    w.mutate();
    w.settle();
    w.app.nav.clear();
    w.go('unlock');
    assert.deepEqual(secretIn(w.pictures()), [], 'after a lock');
  });

  test(`${engine}: rapid Backs step one screen at a time, even two the page has not handled yet`, () => {
    const w = world({ engine, fallback: FALLBACK });
    w.go('home');
    for (const s of ['settings', 'nodeSettings', 'ownNode']) {
      w.tap();
      w.go(s);
    }
    // Two Backs before the page handled the first: not the app's own traversals.
    w.win.history.go(-1);
    w.win.history.go(-1);
    w.settle();
    assert.equal(w.app.currentName, 'settings', 'two screens back, one at a time');
    assert.equal(w.at(), 1);
    assert.equal(w.left(), false);
  });

  test(`${engine}: random use never leaves the app, never strays from the screens, never keeps words`, () => {
    let seed = engine === 'chrome' ? 7 : 11;
    const rnd = (n) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let run = 0; run < 600; run++) {
      const w = world({ engine, before: 2, standalone: true, fallback: FALLBACK });
      w.go('unlock');
      w.tap();
      w.go('home', {}, { reset: true });
      for (let step = 0; step < 40; step++) {
        const k = rnd(9);
        if (k === 0) w.tap();
        else if (k === 1) w.idle(12000);
        else if (k === 2) w.swipe();
        else if (k === 3 && w.app.currentName !== 'txStatus') w.go(['settings', 'send', 'about', 'nodeSettings', 'backup', 'activity'][rnd(6)]);
        else if (k === 4) w.go('home');
        else if (k === 5 && !w.ui.overlays.length) w.sheet(rnd(2) === 0);
        else if (k === 6 && w.app.currentName === 'send') w.go('txStatus', {}, { replace: true });
        else if (k === 7 && w.app.currentName === 'backup') {
          w.ui.secretPart = !w.ui.secretPart;
          w.mutate();
          w.settle();
        } else if (k === 8) w.forward();
        assert.equal(w.left(), false, `run ${run} step ${step}: left the app`);
      }
      // Once the words are off the screen, no picture of them is left.
      w.tap();
      if (SECRET_SCREENS.has(w.app.currentName)) w.go('settings');
      w.settle();
      assert.deepEqual(secretIn(w.pictures()), [], `run ${run}: words kept`);
    }
  });
}

test('on a screen still loading, Back waits for its Back; more Backs meanwhile count once', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const w = world({ fallback: FALLBACK });
  w.go('home');
  w.tap();
  w.go('settings');
  w.tap();
  w.go('about');
  w.ui.loading = true;
  w.swipe();
  w.swipe();
  await sleep(120);
  assert.equal(w.app.currentName, 'about', 'nothing while it loads');
  w.ui.loading = false;
  await sleep(120);
  w.settle();
  assert.equal(w.app.currentName, 'settings', 'its Back, once');
  assert.equal(w.at(), 1);
  assert.equal(w.left(), false);
});

test('a traversal the browser dropped does not stop the entries following the screens', async () => {
  const w = world({ fallback: FALLBACK });
  w.go('home');
  w.tap();
  w.go('settings');
  w.tap();
  w.go('about');
  w.tap();
  w.app.back('settings'); // the app asks to go back over About's entry...
  w.drop(); // ...and the browser drops it
  await new Promise((r) => setTimeout(r, 2100));
  w.settle();
  assert.equal(w.at(), 1, 'read back and followed again');
  w.tap();
  w.go('about');
  assert.equal(w.at(), 2);
  assert.deepEqual(w.swipe(), { picture: 'settings', landed: 'settings' });
});

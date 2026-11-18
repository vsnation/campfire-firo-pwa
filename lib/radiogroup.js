// Keyboard for every segmented choice drawn as role="radiogroup" with role="radio" buttons (Receive's
// address type, Restore's number of words, Privatize / Make public, …): arrow keys move the choice,
// as for native radio buttons, and the chosen button keeps the focus when its screen redraws it
// (outside audit 2026-11-18, #16: Right Arrow did nothing, and a choice dropped focus to the page).
//
// One listener on the document, so a screen needs nothing but the roles. A redrawn button is found
// again by its data-testid, or by its place in the group.

const NEXT = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

const radiosOf = (group) => [...group.querySelectorAll('[role="radio"]')].filter((r) => r.closest('[role="radiogroup"]') === group && !r.disabled);

/** After a choice redraws its group: focus the chosen button again, unless focus moved on by itself. */
function keepFocus(group, radio, index) {
  const id = radio.getAttribute('data-testid');
  const label = group.getAttribute('aria-label') || group.getAttribute('aria-labelledby');
  setTimeout(() => {
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    let again = id ? document.querySelector(`[role="radio"][data-testid="${CSS.escape(id)}"]`) : null;
    if (!again && label) {
      const g = [...document.querySelectorAll('[role="radiogroup"]')].find((x) => (x.getAttribute('aria-label') || x.getAttribute('aria-labelledby')) === label);
      if (g) again = radiosOf(g)[index] || null;
    }
    if (again && again.isConnected) again.focus({ preventScroll: true });
  }, 0);
}

export function installRadioKeys(doc = document) {
  doc.addEventListener('keydown', (e) => {
    const step = NEXT[e.key];
    if (!step || e.altKey || e.ctrlKey || e.metaKey) return;
    const radio = e.target && e.target.closest ? e.target.closest('[role="radio"]') : null;
    const group = radio && radio.closest('[role="radiogroup"]');
    if (!group) return;
    const radios = radiosOf(group);
    const i = radios.indexOf(radio);
    if (i < 0 || radios.length < 2) return;
    e.preventDefault();
    const dir = getComputedStyle(group).direction === 'rtl' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') ? -step : step;
    const j = (i + dir + radios.length) % radios.length;
    const to = radios[j];
    to.focus({ preventScroll: true });
    to.click();
    keepFocus(group, to, j);
  });
  doc.addEventListener('click', (e) => {
    const radio = e.target && e.target.closest ? e.target.closest('[role="radio"]') : null;
    const group = radio && radio.closest('[role="radiogroup"]');
    if (!group || e.detail > 0) return; // a pointer tap does not move keyboard focus anywhere
    keepFocus(group, radio, radiosOf(group).indexOf(radio));
  });
}

// The one place "synced" is decided, from the engine's state (WALLET_API.md getState()).
//
// "Synced" - and with it, permission to send - needs all of:
//   1. a server connection now (connected), after the engine said so in this session;
//   2. the engine's sync phase is 'done' (transparent history, Spark coin sets, spent tags and
//      this wallet's own Spark coins all read);
//   3. the tip the server gave is under MAX_TIP_AGE old by this device's clock. Firo makes a
//      block about every 5 minutes; a tip older than this means the server is stuck or behind;
//   4. no other Firo server shows a different chain (the engine's serverCheck, audit D-11), or
//      other coins spent (serverCheck.about 'spent', audit D-12).
// No second server to ask at all for RULES.noSecondSyncs syncs (serverCheck.noSecondSyncs) is said
// on the sync line, sending still allowed: payments to this wallet wait to be proven meanwhile.
// Anything else says what is happening, how far along, and that sending waits. No height
// constant ever grants "synced". Pure: same inputs, same answer.
import { nodeName } from './node_names.js';
import { t, tk, lazyWords, tn, lang } from './i18n.js';

export const RULES = Object.freeze({
  // Long gaps between Firo blocks happen; over 90 minutes they are rare enough to say so.
  maxTipAgeSec: 90 * 60,
  // A connection lost for longer than this is "offline", not "reconnecting".
  reconnectGraceSec: 20,
  // Firo's block time since its stage 3 (2022): 2.5 minutes (P18).
  blockSec: 150,
  // Syncs in a row with no second Firo node to ask before the sync line says so (release re-audit 3
  // RE3-2: incoming public payments are proven with a second node, and wait for one meanwhile).
  noSecondSyncs: 3,
  // No Firo node has answered yet this long after the wallet opened: said as such, with the way to
  // another node (audit F11: "Connecting…" for as long as the page was open).
  firstConnectSec: 30,
});

/** The sync line's words while no second Firo node can be reached (sending stays allowed). */
export const NO_SECOND_WORDS = tk('No second Firo node could be reached: incoming public payments wait until one can.');
// The same, the Campfire way (0.1.20: raw.oneNodeReceipts): payments count on the node in use's proof.
export const NO_SECOND_COUNTED_WORDS = tk('No second Firo node could be reached: public payments received count on this node\'s word until one can confirm them.');

// How far along each phase is, as a share of the whole sync (the Spark coin sets are most of it).
const PHASES = Object.freeze({
  connecting: lazyWords({ from: 0, to: 0, words: tk('Connecting to a Firo node') }),
  transparent: lazyWords({ from: 0, to: 20, words: tk('Reading your public payments') }),
  'spark-sets': lazyWords({ from: 20, to: 70, words: tk('Downloading private coin sets') }),
  'spark-tags': lazyWords({ from: 70, to: 85, words: tk('Checking which private coins are spent') }),
  'spark-identify': lazyWords({ from: 85, to: 100, words: tk('Finding your private payments') }),
});

/** "Finding your private payments": what a phase is doing, in words. */
export function phaseWords(phase) {
  return (PHASES[phase] && PHASES[phase].words) || t('Catching up with the network');
}

/** 0-100 over the whole sync, or null when nothing can be said yet. */
export function syncPercent(sync) {
  const p = sync && PHASES[sync.phase];
  if (!p || p.to === 0) return null;
  const frac = sync.total > 0 ? Math.max(0, Math.min(1, sync.done / sync.total)) : 0;
  return Math.floor(p.from + (p.to - p.from) * frac);
}

/** "electrumx01.firo.org" from "wss://electrumx01.firo.org:50004". */
export function serverHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url || '');
  }
}

/**
 * @param {object} p
 * @param {object|null} p.raw            the engine's getState(), or null before it started
 * @param {boolean} p.everConnected      the engine reported a server connection in this session
 * @param {number|null} p.lostAt         unix seconds the connection went away (null: not lost)
 * @param {number|null} p.startedAt      unix seconds the wallet was opened (null: not known)
 * @param {number} p.now                 unix seconds
 */
export function assessSync({ raw, everConnected = false, lostAt = null, startedAt = null, now }) {
  const tip = raw && raw.tip ? raw.tip : null;
  const height = tip ? Number(tip.height) || 0 : 0;
  const tipAge = tip && tip.time ? now - Number(tip.time) : null;
  const base = { height, canSend: false, verified: false, percent: null, tipAgeSec: tipAge, phase: raw && raw.sync ? raw.sync.phase : null, server: raw ? raw.server : null };
  const offline = (detail) => ({ ...base, state: 'offline', title: t("Can't reach the Firo network"), detail: [detail || t('Check your internet connection.'), t('Sending is paused until it is back.')].join(' ') });

  if (!raw) return { ...base, state: 'connecting', title: t('Connecting…'), detail: t('Reaching a Firo node.') };
  const sync = raw.sync || { phase: 'connecting', done: 0, total: 0 };
  const host = nodeName(serverHost(raw.server));
  const paused = t('Sending is paused until your wallet is up to date.');
  // What stopped the sync, said as what it is (audit F6: everything read "Can't reach the Firo
  // network. Check your internet connection", a slow node and a full disk too, and "my country
  // blocks it" became everyone's first guess). Each is asked again by the engine in a moment.
  if (sync.phase === 'error' && sync.kind === 'slow') {
    const said = host ? t('{server} did not answer in time. Firo PWA asks again in a moment; on a slow connection the first sync takes a while.', { server: host }) : t('The Firo node did not answer in time. Firo PWA asks again in a moment; on a slow connection the first sync takes a while.');
    return { ...base, state: 'slow', kind: 'slow', title: t('A Firo node is slow to answer'), detail: [said, paused].join(' ') };
  }
  // The list of spent private coins (24 MB) cannot get through this line before Firo's nodes give up
  // on it (lib/firo/backend.js TAGS_TOO_SLOW_MS): no node or app setting fixes that, a faster network does.
  if (sync.phase === 'error' && sync.kind === 'slow-link') {
    return { ...base, state: 'slow', kind: 'slow-link', slowLink: true, title: t('Connection too slow for the private sync'), detail: [t("Firo's nodes stop sending the list of spent private coins (about 25 MB) when it takes more than a minute, so the private balance cannot be read yet. On Wi-Fi or a faster network, Firo PWA tries again within 10 minutes; choosing another Firo node tries at once. What was downloaded is kept."), paused].join(' ') };
  }
  if (sync.phase === 'error' && sync.kind === 'storage') {
    return { ...base, state: 'error', kind: 'storage', title: t('Firo PWA could not save to this device'), detail: [sync.error, t('Free some space on this device, then open Firo PWA again.'), paused].filter(Boolean).join(' ') };
  }
  if (sync.phase === 'error' && sync.kind === 'spark') {
    return { ...base, state: 'error', kind: 'spark', title: t('The private part of Firo PWA stopped'), detail: [sync.error, t('Reload Firo PWA. If this stays, update the browser or use another one.'), paused].filter(Boolean).join(' ') };
  }
  if (sync.phase === 'error' && (sync.kind === 'server' || sync.kind === 'other')) {
    return { ...base, state: 'error', kind: sync.kind, title: t('Something stopped the sync'), detail: [sync.error, t('Firo PWA asks again in a moment, or choose another Firo node.'), paused].filter(Boolean).join(' ') };
  }
  if (sync.phase === 'error') return offline(sync.error);
  if (!raw.connected) {
    if (everConnected && lostAt != null && now - lostAt > RULES.reconnectGraceSec) return offline(t('The Firo node stopped answering. The app keeps trying.'));
    if (everConnected) return { ...base, state: 'connecting', reconnecting: true, title: t('Reconnecting…'), detail: t('The Firo node went quiet; trying another. Sending is paused for a moment.') };
    if (startedAt != null && now - startedAt > RULES.firstConnectSec) return offline(t('No Firo node has answered yet. The app keeps trying; if this lasts, this network may block them.'));
    return { ...base, state: 'connecting', title: t('Connecting…'), detail: t('Reaching a Firo node.') };
  }
  // Done, but some public addresses or payments were not answered (asked again in a moment): not up
  // to date, so sending waits, as when the whole sync failed. Said how many and by which node (F7).
  if (sync.phase === 'done' && sync.partial > 0) {
    return { ...base, state: 'syncing', partial: sync.partial, percent: null, title: t('Catching up with the network'), detail: [tn({ one: '{n} public address was not answered by {server}; asked again in a moment.', other: '{n} public addresses were not answered by {server}; asked again in a moment.' }, sync.partial, { n: sync.partial.toLocaleString('en-US'), server: host }), paused].join(' ') };
  }
  // Reading only a new block or three after a full sync on the same node: still "Synced" (F10).
  if (sync.phase !== 'done' && !sync.refresh) {
    const percent = syncPercent(sync);
    return { ...base, state: 'syncing', percent, title: t('Catching up with the network'), detail: t('{phase}. Sending is paused until your wallet is up to date.', { phase: phaseWords(sync.phase) }) };
  }
  // Another Firo server tells a different chain (or is well ahead): this one is not believed.
  // Or the same chain, but not the same coins spent (audit D-12).
  if (raw.serverCheck && raw.serverCheck.state === 'disagree' && raw.serverCheck.about === 'spent') {
    return { ...base, state: 'disagree', title: t('Another Firo node disagrees with yours'), detail: t('Your node ({server}) and another Firo node do not agree on which private coins are already spent. Sending is paused; choose another Firo node.', { server: nodeName(serverHost(raw.server)) }) };
  }
  if (raw.serverCheck && raw.serverCheck.state === 'disagree') {
    return { ...base, state: 'disagree', title: t('Another Firo node disagrees with yours'), detail: t('Your node ({server}) does not show the same newest blocks as another Firo node. Sending is paused; choose another Firo node.', { server: nodeName(serverHost(raw.server)) }) };
  }
  if (tipAge != null && tipAge > RULES.maxTipAgeSec) {
    const behind = Math.round(tipAge / RULES.blockSec);
    return { ...base, state: 'behind', behindBlocks: behind, title: tn({ one: 'About {n} block behind', other: 'About {n} blocks behind' }, behind, { n: behind.toLocaleString('en-US') }), detail: t('The node\'s newest block is {amount}. Sending is paused; if this lasts, choose another Firo node.', { amount: ageText(tipAge) }) };
  }
  // No second node to ask for a while: payments to this wallet wait unproven (audit FE-1, R1-3), and
  // the line says it is one node's word (audit F4: a green "Synced" over a balance lower than on a
  // device that reaches two nodes).
  const noSecond = Boolean(raw.serverCheck && raw.serverCheck.state === 'unknown' && raw.serverCheck.noSecondSyncs >= RULES.noSecondSyncs);
  // A new block or three read after a full sync (F10): not "Catching up (20%)" with a bar, but not a
  // time to send either (release audit A0119-2: a private payment confirmed while the newest set was
  // still downloading failed and read as "may have left"). Sending waits these few seconds, as it did.
  if (sync.phase !== 'done') {
    return { ...base, state: 'refreshing', ...(raw.sparkOff ? { sparkOff: true } : {}), title: t('Reading the newest block'), detail: t('Up to date until a moment ago; the newest block is being read. Sending waits until it is.'), ...(noSecond ? { noSecond: true } : {}) };
  }
  // The private side could not start in this browser (F2): the public side is read and can be sent
  // from (A0119-6), only where it would be "Synced" (round-2 audit A0119b-1: before the chain checks,
  // it let a payment go through a node on a chain of its own); never the word "Synced" over it.
  if (raw.sparkOff) {
    return { ...base, state: 'synced', sparkOff: true, canSend: !raw.viewOnly, ...(noSecond ? { noSecond: true } : {}), title: t('Private balance not available here'), detail: t('The private part of Firo PWA could not start in this browser ({reason}), so private FIRO and Spark names are not shown. Reload Firo PWA. If this stays, update the browser or use another one.', { reason: raw.sparkOff }) };
  }
  return {
    ...base,
    state: 'synced',
    canSend: !raw.viewOnly,
    title: noSecond ? t('Synced with one Firo node') : t('Synced'),
    ...(noSecond ? { noSecond: true } : {}),
    detail: noSecond ? t(raw.oneNodeReceipts ? NO_SECOND_COUNTED_WORDS : NO_SECOND_WORDS) : t('Block {height}, made {amount} (from {server}).', { height: height.toLocaleString('en-US'), amount: ageText(tipAge), server: nodeName(serverHost(raw.server)) }),
  };
}

/**
 * The sync line's title as the reason in "Sending is paused: {reason}.": in English its first letter
 * small, a name ("Firo PWA", "Firo node") as written (round-3 audit A0119c-5: the whole title was
 * lowercased, "firo pwa could not save to this device").
 */
export function pauseReason(sync) {
  const title = String((sync && sync.title) || '').replace(/[.…。]+$/, '');
  return lang() === 'en' && !/^Firo\b/.test(title) ? title.charAt(0).toLowerCase() + title.slice(1) : title;
}

/** "40 s ago", "3 min ago", "2 h ago": how old the latest block is, by this device's clock. */
export function ageText(sec) {
  if (sec == null || !Number.isFinite(sec) || sec < 15) return t('just now');
  if (sec < 90) return t('{sec} s ago', { sec: Math.round(sec) });
  if (sec < 90 * 60) return t('{n} min ago', { n: Math.round(sec / 60) });
  return t('{n} h ago', { n: Math.round(sec / 3600) });
}

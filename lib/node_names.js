// Names for public Firo nodes whose address says little (an IP address): shown in its place, the
// address beside it on the Firo nodes screen. No imports: the engine's messages use it too.

/** host -> name (owner, 2026-11-07: "Add 94.156.77.196:50004 node as Russian node. Name it like ru-firo-node"). */
export const FIRO_NODE_NAMES = Object.freeze({ '94.156.77.196': 'ru-firo-node' });

/** A node's name, or its host when it has none (own properties only: a host named "constructor" is a host). */
export const nodeName = (host) => (Object.prototype.hasOwnProperty.call(FIRO_NODE_NAMES, host) ? FIRO_NODE_NAMES[host] : host);

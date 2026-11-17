// lib/session.js as the Face ID setup screen sees it: each passkey asked for is recorded; failNext
// makes the next one fail as a cancelled passkey does.
export const added = [];
export const ctl = { failNext: false };
export async function addPasskey(app) {
  if (ctl.failNext) {
    ctl.failNext = false;
    throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
  }
  added.push(app.record && app.record.id);
}

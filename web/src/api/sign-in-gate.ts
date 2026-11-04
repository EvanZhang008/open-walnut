/**
 * Before the console boots: is this browser signed in?
 *
 * A browser on another device (a phone through a tunnel) that holds no token
 * used to mount the whole console, which then fired over a hundred requests that
 * all came back 401 behind the sign-in card (2026-10-13). Now the answer comes
 * first, and an unsigned browser gets the sign-in screen alone.
 *
 *   `#pair=<code>` in the address   trade it, then reload with the token
 *   a token already stored          boot at once (a revoked one still shows the
 *                                   notice when the first request is refused)
 *   anything else                   ask GET /api/devices/browser-session: the
 *                                   server's HttpOnly cookie gives a token back
 *                                   when Safari cleared this page's storage
 *                                   (device-token.ts), then reload with it; a
 *                                   refusal with the primary's code means sign
 *                                   in; an older server's answer falls back to
 *                                   GET /api/v1/me once without a token
 *
 * The computer Walnut runs on takes the probe too (a few ms there): the host
 * name cannot tell it from a tunnel, which may well be a loopback address.
 *
 * A server that answers some other way (a cloud replica's own sign-in) boots
 * the console. One that does not answer at all (a slow cell network, the Mac
 * asleep mid hand-off) gets the sign-in screen with a line that says so and a
 * Try again (spec D5): booting there gave a half drawn console behind a hundred
 * refused requests. main.tsx probes again on its own until one answers.
 */

import { consumePairFragment } from './browser-pair';
import { getDeviceToken, restoreDeviceToken } from './device-token';
import { getUnpairedState, noteAuthRefusal } from './unpaired';

export type SignInGate = 'app' | 'sign-in' | 'probe-failed';

const PROBE_MS = 5_000;
const RESTORED_MARK = '#signed-in-again';

export async function resolveSignInGate(): Promise<SignInGate> {
  const pairing = consumePairFragment();
  if (pairing && !(await pairing)) {
    // A code that failed while an older sign-in still stands (a second scan of
    // a used QR) leaves that sign-in in place; otherwise say why it failed.
    if (getDeviceToken()) return 'app';
    noteAuthRefusal({ code: 'not_paired' });
    return 'sign-in';
  }
  if (pairing) {
    // Start over with the token, as a typed code does: modules that ran at
    // import (slash commands, a mirrored preference) asked without one.
    window.location.reload();
    return new Promise<SignInGate>(() => {});
  }
  // The reload after a restore says so in the address, so a page whose storage does
  // not outlive a reload (some embedded browsers) boots instead of reloading forever.
  const afterRestore = window.location.hash === RESTORED_MARK;
  if (afterRestore) history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}`);
  if (getDeviceToken()) return 'app';
  const kept = await restoreDeviceToken(PROBE_MS);
  if (kept.kind === 'restored' && !afterRestore) {
    // As after a code: modules that ran at import asked without the token.
    window.location.hash = RESTORED_MARK;
    window.location.reload();
    return new Promise<SignInGate>(() => {});
  }
  if (kept.kind === 'restored') return 'app';
  if (kept.kind === 'held') return 'app';
  if (kept.kind === 'no-answer') return 'probe-failed';
  if (kept.kind === 'refused') {
    noteAuthRefusal(kept.body);
    return getUnpairedState() === 'ok' ? 'app' : 'sign-in';
  }
  try {
    const res = await fetch('/api/v1/me', { signal: AbortSignal.timeout(PROBE_MS), cache: 'no-store' });
    if (res.status !== 401) return 'app';
    noteAuthRefusal(await res.json().catch(() => null));
    return getUnpairedState() === 'ok' ? 'app' : 'sign-in';
  } catch {
    return 'probe-failed';
  }
}

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
 *   anything else                   ask GET /api/v1/me once without a token: a
 *                                   refusal with the primary's code means sign in
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
import { getDeviceToken } from './device-token';
import { getUnpairedState, noteAuthRefusal } from './unpaired';

export type SignInGate = 'app' | 'sign-in' | 'probe-failed';

const PROBE_MS = 5_000;

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
  if (getDeviceToken()) return 'app';
  try {
    const res = await fetch('/api/v1/me', { signal: AbortSignal.timeout(PROBE_MS), cache: 'no-store' });
    if (res.status !== 401) return 'app';
    noteAuthRefusal(await res.json().catch(() => null));
    return getUnpairedState() === 'ok' ? 'app' : 'sign-in';
  } catch {
    return 'probe-failed';
  }
}

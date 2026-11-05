/**
 * Before the console boots: is this browser signed in?
 *
 * A browser on another device (a phone through a tunnel) that holds no token
 * used to mount the whole console, which then fired over a hundred requests that
 * all came back 401 behind the sign-in card (2026-10-13). Now the answer comes
 * first, and an unsigned browser gets the sign-in screen alone.
 *
 *   `#pair=<code>` in the address   trade it, then reload with the token
 *   a token that has not run out    boot at once (a revoked one still shows the
 *                                   notice when the first request is refused;
 *                                   one due soon is renewed by the console)
 *   a token that ran out, or        renew first (device-token.ts): the refresh
 *   none but the refresh cookie's   cookie gives a new pair, also when Safari
 *   mark                            cleared this page's storage, and a token from
 *                                   before renewing starts its pair. A new token
 *                                   where there was none reloads the page with it;
 *                                   the route's refusal means sign in; no answer
 *                                   boots on the token held (the Mac away behind a
 *                                   host server, whose copy still knows it), or
 *                                   says so when there is none; anything else falls
 *                                   back to GET /api/v1/me once without a token
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
import { getDeviceToken, hasRefreshMark, renewSignIn, tokenExpired, type RenewResult } from './device-token';
import { getUnpairedState, noteAuthRefusal } from './unpaired';

export type SignInGate = 'app' | 'sign-in' | 'probe-failed';

const PROBE_MS = 5_000;
/** What the builds before marked the address with (read once, for a page reloaded by one). */
const RESTORED_HASH = '#signed-in-again';

/**
 * Set just before the reload after a restore and read once after it, so a page whose
 * storage does not outlive a reload (some embedded browsers) boots instead of reloading
 * forever. A cookie the page writes itself, never the address bar (a reviewer saw the
 * mark flash there): the cookies are what such a page kept. One per port, as the token is.
 */
function restoreMarkName(): string {
  const port = window.location.port;
  return port ? `walnut_restored_${port}` : 'walnut_restored';
}

function restoreMarkAttrs(): string {
  return `; Path=/; SameSite=Strict${window.location.protocol === 'https:' ? '; Secure' : ''}`;
}

function markRestore(): void {
  try { document.cookie = `${restoreMarkName()}=1; Max-Age=60${restoreMarkAttrs()}`; } catch { /* cookies refused */ }
}

function takeRestoreMark(): boolean {
  let found = false;
  try {
    const name = restoreMarkName();
    found = String(document.cookie ?? '').split(';').some((c) => c.trim() === `${name}=1`);
    if (found) document.cookie = `${name}=; Max-Age=0${restoreMarkAttrs()}`;
  } catch { /* cookies refused */ }
  if (window.location.hash === RESTORED_HASH) {
    history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}`);
    return true;
  }
  return found;
}

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
  const afterRestore = takeRestoreMark();
  const held = getDeviceToken();
  // Due soon, or from before renewing: the console renews it once it runs (startSignInRenewal).
  if (held && !tokenExpired()) return 'app';
  // As after a code: modules that ran at import asked without the token.
  const reloadWithToken = (renewed: RenewResult) => renewed.kind === 'renewed' && !held && !afterRestore;
  // A token, or the refresh cookie's mark (Safari cleared this page's storage): renew.
  if (held || hasRefreshMark()) {
    const renewed = await renewSignIn(PROBE_MS);
    if (reloadWithToken(renewed)) {
      markRestore();
      window.location.reload();
      return new Promise<SignInGate>(() => {});
    }
    if (renewed.kind === 'renewed' || renewed.kind === 'held') return 'app';
    if (renewed.kind === 'refused') {
      // The renewal's own code: the page can say why (its cookie gone, used elsewhere).
      noteAuthRefusal(renewed.body);
      return 'sign-in';
    }
    // The token held still answers where renewing does not (a host server's copy while the Mac is away).
    if (held) return 'app';
    if (renewed.kind === 'no-answer') return 'probe-failed';
  }
  try {
    const res = await fetch('/api/v1/me', { signal: AbortSignal.timeout(PROBE_MS), cache: 'no-store' });
    if (res.status !== 401) {
      // A sign-in cookie of a build before (walnut_signin, walnut_device) answered for a page
      // with no token: trade it for a pair, or the console would read and never write.
      const me = res.ok ? await res.json().catch(() => null) as { device?: unknown } | null : null;
      if (!held && me?.device) {
        const renewed = await renewSignIn(PROBE_MS);
        if (reloadWithToken(renewed)) {
          markRestore();
          window.location.reload();
          return new Promise<SignInGate>(() => {});
        }
      }
      return 'app';
    }
    noteAuthRefusal(await res.json().catch(() => null));
    return getUnpairedState() === 'ok' ? 'app' : 'sign-in';
  } catch {
    return 'probe-failed';
  }
}

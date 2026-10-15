/**
 * Signing this browser in with a code (docs/plan/walnut-servers-everywhere.md,
 * "Signing in a browser").
 *
 * The person at the computer Walnut runs on makes a code (Settings > Phones &
 * Cloud). This browser trades it once at POST /api/v1/browser-pair for a device
 * token, stores it (device-token.ts), and reloads so every request and the
 * WebSocket start over with it. A link `<address>/#pair=<code>` does the same on
 * open: the code rides the fragment, which a browser never sends to a server, and
 * it leaves the address bar and is traded before the console mounts.
 *
 * Raw fetch on purpose: client.ts would attach a stale token and report the 401
 * this browser expects.
 */

import { setDeviceToken } from './device-token';
import { log } from '@/utils/log';

export type PairResult = { ok: true } | { ok: false; message: string };

export type FragmentPairState =
  | { phase: 'idle' }
  | { phase: 'pending'; code: string }
  | { phase: 'failed'; code: string; message: string };

const FRAGMENT = /^#pair=([0-9A-Za-z-]{4,20})$/;

export async function exchangeBrowserCode(code: string): Promise<PairResult> {
  let res: Response;
  try {
    res = await fetch('/api/v1/browser-pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A Home Screen app says so: Settings names it "iPhone Home Screen", apart from a Safari tab (D6).
      body: JSON.stringify({ code, ...(isStandaloneDisplay() ? { standalone: true } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, message: 'Walnut did not answer. Check the connection, then try again.' };
  }
  const body = await res.json().catch(() => null) as { token?: unknown; name?: unknown; error?: { message?: unknown } } | null;
  if (res.ok && typeof body?.token === 'string') {
    setDeviceToken(body.token);
    log.info('pairing', 'browser signed in with a code', { name: typeof body.name === 'string' ? body.name : undefined });
    return { ok: true };
  }
  const message = typeof body?.error?.message === 'string' ? body.error.message : `Walnut refused the code (${res.status}).`;
  log.warn('pairing', 'browser code refused', { status: res.status });
  return { ok: false, message };
}

function isStandaloneDisplay(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

let fragmentState: FragmentPairState = { phase: 'idle' };
const listeners = new Set<() => void>();

function setFragmentState(next: FragmentPairState): void {
  fragmentState = next;
  for (const l of listeners) l();
}

/**
 * Called once, before anything else at boot (sign-in-gate.ts): take a `#pair=`
 * code out of the address bar and trade it. Resolves true when this browser now
 * holds a token; the gate then reloads, and the console never mounted without
 * it (2026-10-13: it used to mount beside the exchange, and every request it
 * made in that window came back 401). False on failure: UnpairedNotice shows
 * why, with the code filled in. Null when the address carries no code.
 */
export function consumePairFragment(): Promise<boolean> | null {
  const match = FRAGMENT.exec(window.location.hash);
  if (!match) return null;
  const code = match[1]!;
  try {
    history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}`);
  } catch {
    // A sandboxed frame may refuse; the code is one use either way.
  }
  setFragmentState({ phase: 'pending', code });
  return exchangeBrowserCode(code).then((result) => {
    // A right code stays 'pending' (the sign-in screen keeps saying so) until
    // the gate's reload replaces the page.
    if (result.ok) return true;
    setFragmentState({ phase: 'failed', code, message: result.message });
    return false;
  });
}

export function getFragmentPairState(): FragmentPairState {
  return fragmentState;
}

export function subscribeFragmentPair(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

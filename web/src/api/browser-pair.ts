/**
 * Signing this browser in with a code (docs/plan/walnut-servers-everywhere.md,
 * "Signing in a browser").
 *
 * The person at the computer Walnut runs on makes a code (Settings > Phones &
 * Cloud). This browser trades it once at POST /api/v1/browser-pair for a device
 * token, stores it (device-token.ts), and reloads so every request and the
 * WebSocket start over with it. A link `<address>/#pair=<code>` does the same on
 * open: the code rides the fragment, which a browser never sends to a server, and
 * it leaves the address bar before the app makes its first request.
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
      body: JSON.stringify({ code }),
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

let fragmentState: FragmentPairState = { phase: 'idle' };
const listeners = new Set<() => void>();

function setFragmentState(next: FragmentPairState): void {
  fragmentState = next;
  for (const l of listeners) l();
}

/**
 * Called once, before the app mounts: take a `#pair=` code out of the address bar
 * and trade it. On success the page reloads; on failure UnpairedNotice shows why,
 * with the code filled in.
 */
export function consumePairFragment(): void {
  const match = FRAGMENT.exec(window.location.hash);
  if (!match) return;
  const code = match[1]!;
  try {
    history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}`);
  } catch {
    // A sandboxed frame may refuse; the code is one use either way.
  }
  setFragmentState({ phase: 'pending', code });
  void exchangeBrowserCode(code).then((result) => {
    if (result.ok) {
      window.location.reload();
      return;
    }
    setFragmentState({ phase: 'failed', code, message: result.message });
  });
}

export function getFragmentPairState(): FragmentPairState {
  return fragmentState;
}

export function subscribeFragmentPair(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * "This browser is not paired" signal.
 *
 * A primary server answers without a credential only to its own machine
 * (src/web/middleware/local-trust.ts). A browser on another device gets 401 on
 * every API call, and without this it just shows an empty board, which reads as
 * lost data. client.ts reports the auth middleware's 401s here; UnpairedNotice
 * explains what happened and what to do.
 */

export type UnpairedState = 'ok' | 'unpaired' | 'revoked';

let state: UnpairedState = 'ok';
const listeners = new Set<() => void>();

/**
 * Keyed on the `code` the primary's authMiddleware puts in its two refusals
 * (src/web/middleware/auth.ts). Other 401s (a plugin's expired account, the
 * health contract, a cloud replica's own auth) carry no such code.
 */
/**
 * Why a renewing sign-in ended, from the renewal's own refusal
 * (src/web/routes/browser-sign-in.ts), so the page can say it: its refresh
 * cookie was cleared, its sign-in was used from somewhere else, a year unused.
 * Null: removed on the computer, or a reason this page did not hear.
 */
export type SignedOutReason = 'cookie_gone' | 'used_elsewhere' | 'year_unused' | 'removed';

const REASONS: Record<string, SignedOutReason> = {
  refresh_missing: 'cookie_gone',
  refresh_reused: 'used_elsewhere',
  refresh_expired: 'year_unused',
  // The server closed this page's socket because the device went (ws.ts, 4401), or the renewal
  // route knows its refresh token as one of a browser removed on the computer: removed there,
  // unless a renewal says more (a replay or a lost cookie ends it the same way).
  device_removed: 'removed',
};
/** Said only when nothing more exact was heard. */
const WEAK_REASONS = new Set<SignedOutReason>(['removed']);
const SIGNED_OUT_CODES = new Set(['token_refused', 'refresh_refused', ...Object.keys(REASONS)]);

/** Kept across a reload: the page that loads again only hears a plain refusal. */
const REASON_KEY = 'walnut.signedOutReason';
const KNOWN_REASONS = new Set<string>(Object.values(REASONS));

function keptReason(): SignedOutReason | null {
  try {
    const v = globalThis.localStorage?.getItem(REASON_KEY) ?? null;
    return v && KNOWN_REASONS.has(v) ? v as SignedOutReason : null;
  } catch { return null; }
}

function keepReason(r: SignedOutReason | null): void {
  try {
    if (r) globalThis.localStorage?.setItem(REASON_KEY, r);
    else globalThis.localStorage?.removeItem(REASON_KEY);
  } catch { /* storage refused: the reason lasts this page only */ }
}

let reason: SignedOutReason | null = keptReason();

export function noteAuthRefusal(body: unknown): void {
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  const next: UnpairedState = code === 'not_paired' ? 'unpaired'
    : typeof code === 'string' && SIGNED_OUT_CODES.has(code) ? 'revoked'
    : state;
  // The renewal's word wins over a plain refusal heard after it (the same sign-out).
  const why = typeof code === 'string' ? REASONS[code] ?? null : null;
  if (why && why !== reason && !(reason && WEAK_REASONS.has(why))) {
    reason = why;
    keepReason(why);
    if (next === state) { for (const l of listeners) l(); return; }
  }
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

export function getSignedOutReason(): SignedOutReason | null {
  return state === 'revoked' ? reason : null;
}

/**
 * The sign-in was renewed (api/device-token.ts): this browser is signed in, whatever
 * a refusal said a moment before (a request sent with the token the renewal replaced).
 */
export function noteSignedIn(): void {
  if (reason) keepReason(null);
  reason = null;
  if (state === 'ok') return;
  state = 'ok';
  for (const l of listeners) l();
}

export function getUnpairedState(): UnpairedState {
  return state;
}

export function subscribeUnpaired(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

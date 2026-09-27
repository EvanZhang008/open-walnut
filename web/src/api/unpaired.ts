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
export function noteAuthRefusal(body: unknown): void {
  const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
  const next: UnpairedState = code === 'not_paired' ? 'unpaired'
    : code === 'token_refused' ? 'revoked'
    : state;
  if (next === state) return;
  state = next;
  for (const l of listeners) l();
}

export function getUnpairedState(): UnpairedState {
  return state;
}

export function subscribeUnpaired(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

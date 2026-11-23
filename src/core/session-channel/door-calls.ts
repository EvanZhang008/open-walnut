/**
 * Which host routes a leader's call frame may reach on a host-dialed link (door-wire.ts `call`,
 * answered by host-dialer.ts): a registry of path prefixes, `/host-api/sessions/` from the start;
 * another module of the host's service adds its own (`allowDoorCallPrefix('/host-api/witness/',
 * answer)`). The credential and doors routes are never callable this way, whatever is registered:
 * they configure the link itself and come only over the leader's own daemon link.
 */
import { HOST_CREDENTIAL_PATH, HOST_DOORS_PATH } from './door-wire.js'
import { HOST_SESSIONS_PATH } from './host-api.js'
import type { HostSessionRoutes } from './host-routes.js'

/**
 * Who a call frame comes from: the leader at the other end of this host's dialed socket, which proved
 * it holds the verify key of this machine's credential for `walnutId` (door-wire.ts; the welcome's
 * proof), so these two ids are verified, not claimed by the frame.
 */
export interface DoorPeer { walnutId: string; machineId: string }

export type DoorCallAnswer = (method: string, path: string, body: unknown, from: DoorPeer) => Promise<{ status: number; body: unknown }>

/** Never reached through a call frame (the exact paths and anything under them). */
export const NEVER_CALLABLE = [HOST_CREDENTIAL_PATH, HOST_DOORS_PATH] as const

/** Prefix -> its answer; null: the host's session routes (host-routes.ts call). */
const prefixes = new Map<string, DoorCallAnswer | null>([[HOST_SESSIONS_PATH + '/', null]])

const neverCallable = (p: string): boolean => NEVER_CALLABLE.some((n) => p === n || p.startsWith(n + '/'))

/**
 * Let call frames reach paths under `prefix` (`/host-api/<name>/`), answered by `answer` (left out:
 * the host's session routes). Returns the undo. Throws on a prefix that is not one, or that would
 * cover a route that is never callable.
 */
export function allowDoorCallPrefix(prefix: string, answer?: DoorCallAnswer): () => void {
  if (!/^\/host-api\/[a-z0-9-]+\/$/.test(prefix)) throw new Error(`not a door call prefix: ${prefix}`)
  if (NEVER_CALLABLE.some((n) => (n + '/').startsWith(prefix))) throw new Error(`${prefix} covers a route that is never callable through a door`)
  const entry = answer ?? null
  prefixes.set(prefix, entry)
  return () => { if (prefixes.get(prefix) === entry) prefixes.delete(prefix) }
}

/** The answer of one call frame: refused unless its path is plain and under an allowed prefix. */
export async function answerDoorCall(method: string, path: string, body: unknown, sessions: HostSessionRoutes | null, from: DoorPeer): Promise<{ status: number; body: unknown }> {
  // A plain absolute path only: no query, fragment, dot segment, empty segment or escape.
  const plain = typeof path === 'string' && path.length <= 512 && /^\/[A-Za-z0-9/_.-]*$/.test(path) && !/\/\.{1,2}(\/|$)|\/\//.test(path)
  if (!plain || neverCallable(path)) return { status: 403, body: { ok: false, error: 'not_callable' } }
  let best: string | null = null
  for (const p of prefixes.keys()) if (path.startsWith(p) && (!best || p.length > best.length)) best = p
  if (best === null) return { status: 403, body: { ok: false, error: 'not_callable' } }
  const answer = prefixes.get(best)
  if (answer) return answer(method, path, body, from)
  if (!sessions) return { status: 503, body: { ok: false, error: 'host_runs_sessions_off' } }
  return sessions.call(method, path, body)
}

/** Tests: back to the start (only the session routes). */
export function _resetDoorCallPrefixesForTesting(): void {
  prefixes.clear()
  prefixes.set(HOST_SESSIONS_PATH + '/', null)
}

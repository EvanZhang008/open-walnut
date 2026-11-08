/**
 * Which turn ends the endpoint wait (sessions/endpoint-wait.ts) takes over. Its own module so
 * session-auto-continue, which hands those turns to the wait and keeps every other one, reads the same
 * rule without importing the waiter (which imports it back for its send source).
 */
import { classifyTurnError } from '../../providers/daemon-core.js'
import { matchesEndpointUnreachable, matchesEndpointDropped, endpointWaitEnabled } from './endpoint-unreachable.js'

/** The fields of a session:result this rule reads. */
export interface EndpointResultFacts {
  isError?: boolean
  result?: string | null
  teamActive?: boolean
  backgroundActive?: boolean
  detachedBgActive?: boolean
  wakeupPending?: boolean
}

/** The codes that say the connection was never made, whatever wrapper carries them. */
const NEVER_REACHED = /\bECONNREFUSED\b|connection refused|\bENOTFOUND\b|\bEAI_AGAIN\b|getaddrinfo|\bEHOSTUNREACH\b|\bENETUNREACH\b|\bEHOSTDOWN\b|\bENETDOWN\b/i

/** Why the endpoint wait owns this error text: never reached, or dropped mid-request; null when it does not. */
export function endpointWaitCause(text: string | null | undefined): 'unreachable' | 'dropped' | null {
  if (!text || classifyTurnError(text) !== 'retryable') return null
  // A reset inside a loose wrapper ("Unable to connect to API (ECONNRESET)", "fetch failed ...
  // ECONNRESET") is a drop: only a refusal, a name that does not resolve or no route is unreachable.
  if (matchesEndpointDropped(text) && !NEVER_REACHED.test(text)) return 'dropped'
  if (matchesEndpointUnreachable(text)) return 'unreachable'
  return null
}

/** The error text is the endpoint wait's: the endpoint was never reached, or the connection to it dropped (no terminal error). */
export function isEndpointUnreachableError(text: string | null | undefined): boolean {
  return endpointWaitCause(text) !== null
}

/**
 * This result is a turn the endpoint wait takes over: an error that never reached the model, at a
 * real turn end (no team, background work or wakeup carries the session on). Pure and synchronous,
 * so the result handler (web/server.ts), the runner, auto-continue and the hooks decide the same thing
 * as the waiter. A turn it does not take whose text is unreachable stays auto-continue's.
 */
export function endpointWaitTakes(r: EndpointResultFacts): boolean {
  if (!endpointWaitEnabled() || !r.isError) return false
  if (r.teamActive || r.backgroundActive || r.detachedBgActive || r.wakeupPending) return false
  return isEndpointUnreachableError(r.result)
}

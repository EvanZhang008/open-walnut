/**
 * Which turn ends the endpoint wait (sessions/endpoint-wait.ts) takes over. Its own module so
 * session-auto-continue, which hands those turns to the wait and keeps every other one, reads the same
 * rule without importing the waiter (which imports it back for its send source).
 */
import { classifyTurnError } from '../../providers/daemon-core.js'
import { matchesEndpointUnreachable, endpointWaitEnabled } from './endpoint-unreachable.js'

/** The fields of a session:result this rule reads. */
export interface EndpointResultFacts {
  isError?: boolean
  result?: string | null
  teamActive?: boolean
  backgroundActive?: boolean
  detachedBgActive?: boolean
  wakeupPending?: boolean
}

/** The error text says the endpoint was never reached (and it is no terminal error). */
export function isEndpointUnreachableError(text: string | null | undefined): boolean {
  return !!text && classifyTurnError(text) === 'retryable' && matchesEndpointUnreachable(text)
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

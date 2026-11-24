/**
 * Is the work running now a person's own call (web/routes/person-caller.ts isPersonCaller: no
 * session id, no automation mark, from this computer or a paired device)? The server marks each
 * such request (server.ts, after its auth), and the mark follows the request's async work. Read by
 * the command gate (providers/ephemeral-session-gate.ts) for a revoked host only: a command that
 * runs a process there or hands it this Walnut's data goes only for a person's own call, never for a
 * session, a routine, a trigger or a peer (R2-S3 of the C7 review; revoked-reach.ts `person` rows).
 * Work with no mark (a timer, a queue, an op run in process) is not a person's.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const store = new AsyncLocalStorage<true>()

/** Run `fn` as a person's own call. */
export function asPersonCall<T>(fn: () => T): T {
  return store.run(true, fn)
}

/** Is the work running now a person's own call? */
export function inPersonCall(): boolean {
  return store.getStore() === true
}

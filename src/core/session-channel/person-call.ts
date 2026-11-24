/**
 * Is the work running now a person's own call (web/routes/person-caller.ts isPersonCaller: no
 * session id, no automation mark, from this computer or a paired device)? Read by the command gate
 * (providers/ephemeral-session-gate.ts) and an ACP permission answer for a revoked host only: a
 * command that runs a process there or hands it this Walnut's data, or a tool allowed there, goes
 * only for a person's own call, never for a session, a routine, a trigger or a peer (revoked-reach.ts
 * `person` rows). Work with no mark (a timer, a queue, an op run in process) is not a person's.
 *
 * The mark lives only as long as its call (R3-S1 of the C7 review): an AsyncLocalStorage store
 * follows every socket, child process and timer made inside it, so the store is an object whose
 * `live` goes false when the request's response ends (markPersonRequest) or the wrapped work settles
 * (asPersonCall). What outlives the call reads "not a person". A link or loop that serves later callers
 * too (a daemon link and its reconnects, the stream lane, a shared port forward) is made outside any
 * mark (outsidePersonCall), so its events never carry one, not even while the request still runs.
 * Every creator of such a thing in the modules that send what only a person may is classified in
 * tests/core/session-channel/person-mark-long-lived-ratchet.test.ts.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

interface Mark { live: boolean }
const store = new AsyncLocalStorage<Mark>()

/** Run `fn` as a person's own call; the mark ends when it settles. */
export function asPersonCall<T>(fn: () => T): T {
  const mark: Mark = { live: true }
  const out = store.run(mark, fn)
  if (out instanceof Promise) void out.finally(() => { mark.live = false }).catch(() => undefined)
  else mark.live = false
  return out
}

/** Mark a person's request for the work it runs (server.ts): the mark ends with its response. */
export function markPersonRequest(res: { once(ev: 'finish' | 'close', fn: () => void): unknown }, next: () => void): void {
  const mark: Mark = { live: true }
  const end = () => { mark.live = false }
  res.once('finish', end)
  res.once('close', end)
  store.run(mark, next)
}

/** Run `fn`, and everything it creates, with no person mark (a daemon link's dial). */
export function outsidePersonCall<T>(fn: () => T): T {
  return store.exit(fn)
}

/** Is the work running now a person's own call that is still running? */
export function inPersonCall(): boolean {
  return store.getStore()?.live === true
}

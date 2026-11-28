/**
 * Whether the socket a running RPC came from is the person's own: `client.person`, which the upgrade
 * decided with the one rule (routes/person-caller.ts isPersonCaller, ws/handler.ts). The dispatcher
 * (handler.ts) runs every socket call inside this scope, so a handler that frames words as the
 * person's (session-chat.ts `session:send`, `session:start`) asks here instead of assuming it: a
 * local process that opened `/ws` with no proof of the person's client is no person, as its HTTP
 * request is not.
 *
 * Outside any socket call (a handler run in process, a unit test calling it) there is no socket to
 * judge, and the handler keeps its own default (the person). Every call from a socket goes through
 * the dispatcher, which always sets it (tests/web/routes/no-sid-is-not-person-ratchet.test.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { localProofMode } from '../routes/local-person-proof.js'

const store = new AsyncLocalStorage<{ person: boolean }>()

/** Run a socket call as its socket's: `person` is `client.person` (handler.ts). */
export function withRpcCaller<T>(person: boolean, fn: () => T): T {
  return store.run({ person }, fn)
}

/**
 * Is the socket call running now the person's own (see the file comment)? Only in enforce: outside
 * it every socket send keeps the old reading, the person (local-person-proof.ts noSessionStands).
 */
export function rpcCallerIsPerson(): boolean {
  return (store.getStore()?.person ?? true) || localProofMode() !== 'enforce'
}

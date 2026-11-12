/**
 * A long transfer waits out a dropped link instead of failing on it (2026-11-12: the link to a dev
 * host dropped every few minutes while a task move uploaded, once for 9 minutes, and each drop
 * failed the whole move with "Walnut is not connected to <host> right now").
 *
 * Inside withLinkWait, a daemon command of the transfer client (daemon-transfer-client.ts) that
 * finds no link to its host waits for it to come back, up to the wait's bound, then goes on from
 * that step; a relay resumes from the bytes the receiver already holds, and a link lost under a
 * chunk is not counted as a failed chunk. Outside it nothing changes: one dial, then offline.
 * This server's own stop ends every wait at once (server-stopping.ts). The members that run
 * under it are pinned by tests/core/server-stop-interrupt-ratchet.test.ts.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { log } from '../../logging/index.js'
import { isServerStopping } from '../server-stopping.js'

/** How long a task move waits for a dropped link (the longest drop seen was about 9 minutes). */
export const MOVE_LINK_WAIT_MS = 10 * 60_000

const store = new AsyncLocalStorage<{ ms: number }>()
let pollMs = 2_000

/** Test-only: how often a wait looks again (null: the default). */
export function __setLinkWaitPollForTesting(ms: number | null): void { pollMs = ms ?? 2_000 }

export function linkPollMs(): number { return pollMs }

/** Run `fn` with each transfer command in it waiting up to `ms` for a dropped link to come back. */
export function withLinkWait<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  return store.run({ ms }, fn)
}

/**
 * Run `fn` outside any link wait: a step with its own deadline keeps it inside a long run (a
 * start's placement, a model endpoint probe), offline at once as before.
 */
export function noLinkWait<T>(fn: () => Promise<T>): Promise<T> {
  return store.run({ ms: 0 }, fn)
}

/** The wait the calling code runs under, or null. */
export function currentLinkWait(): { ms: number } | null {
  const w = store.getStore()
  return w && w.ms > 0 ? w : null
}

/**
 * The host's links once one is back, or none at the bound. `stopping` makes the error thrown
 * when this server begins its own stop meanwhile.
 */
export async function awaitLink<C>(host: string, ms: number, resolve: (host: string) => Promise<C[]>, stopping: () => Error): Promise<C[]> {
  const started = Date.now()
  log.session.info('transfer: no link to the host; waiting for it to come back', { host, waitMs: ms })
  while (Date.now() - started < ms) {
    if (isServerStopping()) throw stopping()
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, ms - (Date.now() - started)))))
    if (isServerStopping()) throw stopping()
    const conns = await resolve(host)
    if (conns.length > 0) {
      log.session.info('transfer: the link to the host is back; the step goes on', { host, waitedMs: Date.now() - started })
      return conns
    }
  }
  log.session.warn('transfer: the link to the host did not come back in time', { host, waitedMs: Date.now() - started })
  return []
}

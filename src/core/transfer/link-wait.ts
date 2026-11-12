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
import { sleptBetween } from '../../lib/sleep-ledger.js'

/** How long a task move waits for a dropped link (the longest drop seen was about 9 minutes). */
export const MOVE_LINK_WAIT_MS = 10 * 60_000

const store = new AsyncLocalStorage<{ ms: number }>()
let pollMs = 2_000
let wallNow: () => number = () => Date.now()

/** Test-only: the wall clock the bounds read (null: Date.now). Drive lib/sleep-ledger.ts with the same one. */
export function __setLinkWaitClockForTesting(now: (() => number) | null): void { wallNow = now ?? (() => Date.now()) }

/**
 * How long a wait has run while the machine was awake: its bound never runs out in a sleep
 * (2026-11-12: the Mac slept 41 minutes, and on wake both moves in flight failed at once, their
 * 10 minute bounds read on Date.now long gone). Sleep is what lib/sleep-ledger.ts saw: process.hrtime
 * stops while this Mac sleeps under Bun (the server's runtime), so wall minus hrtime is sleep. Where
 * that clock counts sleep too (Node's hrtime on macOS does), a look that comes `jumpMs` or more after
 * the one before counts only `jumpCountMs` (what one look takes at most): a poll that late was
 * asleep, or frozen, and a wait whose every look is that slow still ends.
 */
export function awakeStopwatch(jumpMs = Infinity, jumpCountMs = 0): { ms(): number } {
  let last = wallNow()
  let awake = 0
  return {
    ms() {
      const now = wallNow()
      const span = Math.max(0, now - last)
      const up = span - sleptBetween(last, now)
      awake += up < jumpMs ? Math.max(0, up) : Math.min(up, jumpCountMs)
      last = now
      return awake
    },
  }
}

/** A poll of awaitLink later than this (a poll is pollMs, then one dial) was a sleep: it counts as one poll and one dial. */
const POLL_JUMP_MS = 2 * 60_000
/** The longest the transport (daemon-transfer-client.ts) waits for one dial of a link; defined here, where both read it. */
export const DIAL_WAIT_MS = 20_000

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
  const waited = awakeStopwatch(POLL_JUMP_MS, pollMs + DIAL_WAIT_MS)
  log.session.info('transfer: no link to the host; waiting for it to come back', { host, waitMs: ms })
  while (waited.ms() < ms) {
    if (isServerStopping()) throw stopping()
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, ms - waited.ms()))))
    if (isServerStopping()) throw stopping()
    const conns = await resolve(host)
    if (conns.length > 0) {
      log.session.info('transfer: the link to the host is back; the step goes on', { host, waitedMs: waited.ms() })
      return conns
    }
  }
  log.session.warn('transfer: the link to the host did not come back in time', { host, waitedMs: waited.ms() })
  return []
}

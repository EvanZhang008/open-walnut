/**
 * When a daemon that refused its update as busy is asked again, on every path that asks: an SSH
 * host (daemon-connection.ts), a host network machine (daemon-net-update.ts) and this Mac
 * (local-daemon.ts). Ratchet: tests/providers/daemon-busy-retry.test.ts.
 *
 * 2026-11-25: clouddev's daemon, reached under two names (newdev over SSH, clouddev over the host
 * network), refused 266 tries of its update in 38 minutes after the leader woke, and about 8,500
 * in the two days before. Each try is one `walnut daemon update` on the host that asks the daemon
 * every 2 s for 30 s (the host network's runner runs up to 8 of them). The SSH path counted its
 * busy refusals in the connection's memory, so every deploy of the leader (every 10 to 20 minutes)
 * started the count over at "ask again in a minute", and each new server tried again at once on
 * connect; this Mac asked every minute for good.
 *
 * So the clock is on disk beside the other hold clocks (acp-upgrade-hold.ts), per host name and the
 * build that runs there, and the wait grows with how long the refusals have lasted
 * (BUSY_RETRY_STEPS, at most DAEMON_BUSY_RETRY_MAX_MS). A path starts no try while the clock says
 * wait (busyRetryLeftMs), a new server included. It ends by itself once the host runs another build
 * (an update went through) or after BUSY_RETRY_STALE_MS with no refusal. Overdue
 * (daemon-update-behind.ts) the wait is at most BUSY_RETRY_OVERDUE_MAX_MS: the forced swap should
 * not be refused, and if it is, it is asked again within minutes.
 */
import { dropHoldClocks, readHoldClock, upgradeHoldClock } from './acp-upgrade-hold.js'
import { DAEMON_UPDATE_BEHIND_MAX_MS } from './daemon-update-behind.js'

/** [refusals lasted less than this, wait this long before the next try]; past the last row, DAEMON_BUSY_RETRY_MAX_MS. */
export const BUSY_RETRY_STEPS: ReadonlyArray<readonly [number, number]> = [
  [3 * 60_000, 60_000],
  [10 * 60_000, 2 * 60_000],
  [30 * 60_000, 5 * 60_000],
  [60 * 60_000, 10 * 60_000],
]
export const DAEMON_BUSY_RETRY_MAX_MS = 15 * 60_000
/** Overdue, a refused forced swap is asked again at most this long after. */
export const BUSY_RETRY_OVERDUE_MAX_MS = 5 * 60_000
/**
 * A refusal row not seen again for this long is over: longer than the longest wait, a host network
 * runner's tries (about 6 min) and an upload.
 */
export const BUSY_RETRY_STALE_MS = 45 * 60_000

/**
 * `overdue`: the update is past its bound (daemon-update-behind.ts). `behindMs`: how long the host has
 * been behind, so a wait does not end past the moment the update becomes overdue.
 */
export interface BusyRetryOpts { overdue?: boolean; behindMs?: number }

const PREFIX = 'busy:'
// The host name encoded: a name with a ':' in it never reads as another name's prefix.
const hostPrefix = (host: string) => `${PREFIX}${encodeURIComponent(host)}:`
const keyOf = (host: string, running: string) => `${hostPrefix(host)}${running}`

/** The wait after a refusal, for refusals that have lasted `heldMs`. */
export function busyRetryWaitMs(heldMs: number, opts: BusyRetryOpts = {}): number {
  const step = BUSY_RETRY_STEPS.find(([under]) => heldMs < under)?.[1] ?? DAEMON_BUSY_RETRY_MAX_MS
  if (opts.overdue) return Math.min(step, BUSY_RETRY_OVERDUE_MAX_MS)
  if (opts.behindMs === undefined) return step
  // Not past the moment the update turns overdue (at least the first step, so a try is never asked at once).
  return Math.min(step, Math.max(DAEMON_UPDATE_BEHIND_MAX_MS - opts.behindMs, BUSY_RETRY_STEPS[0][1]))
}

/**
 * The daemon `host` reaches, running `running`, refused its update as busy now: the wait before the
 * next try. The row of a build that no longer runs there is dropped.
 */
export function noteBusyRefusal(host: string, running: string, opts: BusyRetryOpts = {}, now: number = Date.now()): number {
  const key = keyOf(host, running)
  dropHoldClocks(hostPrefix(host), key)
  const { heldMs } = upgradeHoldClock(key, true, Number.POSITIVE_INFINITY, now, BUSY_RETRY_STALE_MS)
  return busyRetryWaitMs(heldMs, opts)
}

/** How long before a try of `host`'s update may start (0: now); the clock is left as it is. */
export function busyRetryLeftMs(host: string, running: string, opts: BusyRetryOpts = {}, now: number = Date.now()): number {
  const key = keyOf(host, running)
  dropHoldClocks(hostPrefix(host), key)
  const row = readHoldClock(key, now, BUSY_RETRY_STALE_MS)
  if (!row) return 0
  const wait = busyRetryWaitMs(row.seen - row.since, opts)
  // Never more than one wait from now, whatever the clock did since the row was written.
  return Math.min(wait, Math.max(0, row.seen + wait - now))
}

/** The refusal row of `host` is over (its daemon runs the build this server would put there). */
export function endBusyRefusals(host: string): void {
  dropHoldClocks(hostPrefix(host), '')
}

/** The one wording of a try not started because the last one was refused as busy. */
export function busyRetryWhy(leftMs: number): string {
  return `the host's daemon refused the last try as busy; asked again in ${Math.ceil(leftMs / 1000)} s`
}

/**
 * Every file that reads a daemon's busy refusal of an update (its words, DAEMON_BUSY_WORDS, or the
 * readers of them), and how a refusal is asked again there. tests/providers/daemon-busy-retry.test.ts
 * fails on a reader not listed here, and on a 'clock' path that does not note each refusal or does
 * not check the clock before a try.
 *  - clock: an update path; each refusal is noted (noteBusyRefusal) and no try starts while the clock waits.
 *  - pauses: asks within one try, at most UPDATE_BUSY_WAIT_MS / HANDOVER_BUSY_WAIT_MS, pauses growing (busyPauses).
 *  - runner: the detached runner's tries within one update, at most RUNNER_TRIES and UPDATE_WAIT_MS.
 *  - passes: hands the refusal to a path that does the asking.
 *  - words: where the words are said or defined.
 */
export const BUSY_REFUSAL_READERS: Readonly<Record<string, { asks: 'clock' | 'pauses' | 'runner' | 'passes' | 'words'; why: string }>> = {
  'src/providers/daemon-connection.ts': { asks: 'clock', why: 'an SSH host: updateManagedDaemon notes a busy refusal and checks the clock before a try' },
  'src/providers/daemon-net-update.ts': { asks: 'clock', why: 'a host network machine: attempt notes a busy refusal and checks the clock before an automatic try' },
  'src/providers/local-daemon.ts': { asks: 'clock', why: 'this Mac: startManagedUpdate notes a busy outcome and checks the clock before a try' },
  'src/providers/local-daemon-service.ts': { asks: 'passes', why: "answers 'busy' to local-daemon.ts, which notes it" },
  'src/providers/daemon-service-cli.ts': { asks: 'pauses', why: 'the CLI asks the daemon again within one try (handoverBusy), with busyPauses' },
  'src/providers/daemon-net-update-io.ts': { asks: 'runner', why: 'the detached runner runs walnut daemon update again while the daemon refuses as busy, RUNNER_TRIES times at most' },
  'src/providers/daemon-update-readback.ts': { asks: 'passes', why: 'judges a record read back after the wait ended: nothing done, and the path asks again through its gate' },
  'src/providers/exec-runs-hold.ts': { asks: 'words', why: 'daemonBusyRefusal, the one test of an answer' },
  'src/providers/daemon-busy-words.ts': { asks: 'words', why: 'DAEMON_BUSY_WORDS' },
  'src/providers/daemon-command-drain.ts': { asks: 'words', why: 'the daemon says it (has active operations)' },
  'src/providers/daemon-standalone.ts': { asks: 'words', why: 'the daemon says it (must finish first)' },
  'src/providers/daemon-update-behind.ts': { asks: 'words', why: 'its history, in a comment' },
}

/** Tests only: forget every refusal row. */
export function resetBusyRetryForTest(): void {
  dropHoldClocks(PREFIX, '')
}

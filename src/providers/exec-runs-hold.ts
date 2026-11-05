/**
 * A daemon update waits for the host_exec runs on that host. 2026-11-03: a deploy
 * updated a Mac's daemon while a task on a Linux box ran the iOS tests there through
 * host_exec; the run wrote to the old daemon's pipes, so it ended with that daemon,
 * four minutes into five, and the new daemon knew no such job.
 *
 * The daemon says how many runs it has in its hello (`execRunning`) and lists them
 * (exec.list, which every daemon with host-exec-v1 answers); every path that replaces a
 * daemon asks first (local-daemon.ts; the SSH path, its boot-start install and the host
 * network path in daemon-connection.ts / daemon-net-update.ts), and a service daemon
 * refuses the handover itself while one runs.
 *
 * The wait has an end: each run ends by its own deadline (host-exec-core.ts: 10 min in
 * the foreground, 2 h in the background), and a host that kept runs going for
 * EXEC_UPGRADE_HOLD_MAX_MS (one after another, or one stuck past its kill) gets its
 * update anyway, on the per-host clock acp-upgrade-hold.ts keeps on disk.
 */
import { upgradeHoldClock } from './acp-upgrade-hold.js'
import { log } from '../logging/index.js'

export const EXEC_UPGRADE_HOLD_MAX_MS = 3 * 60 * 60_000

/** Why the daemon must not stop now, or null: `n` host_exec runs are going on there. */
export function execRunsReason(n: unknown): string | null {
  const count = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : 0
  return count > 0 ? `${count} host_exec run${count === 1 ? '' : 's'} on the host would end with the daemon` : null
}

/**
 * A daemon's refusal of a handover or update before it changed anything: work of its own
 * (a host_exec run, a relay, a command) must finish first. The same words
 * daemon-service-cli.ts handoverBusy waits out; asked again, it is not a failure. Its drain
 * that ran out (a session command still going after 15 s) is the same: it resumed and changed
 * nothing, and taking it for a failed update left the update to the next reconnect.
 */
export function daemonBusyRefusal(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error)
  return /must finish first|has active operations; retry after they finish|Service preparation timed out/.test(text)
}

/** How many jobs an exec.list reply names as running. */
export function runningJobs(reply: unknown): number {
  const jobs = (reply as { jobs?: unknown } | null)?.jobs
  return Array.isArray(jobs) ? jobs.filter((j) => (j as { running?: unknown } | null)?.running === true).length : 0
}

/**
 * `reason` while `host`'s wait for its runs is under EXEC_UPGRADE_HOLD_MAX_MS, else null
 * (the update goes ahead, said once in the log). A null reason ends the wait's clock.
 */
export function execRunsWait(host: string, reason: string | null, now: number = Date.now()): string | null {
  const { holds, heldMs } = upgradeHoldClock(`exec:${host}`, reason !== null, EXEC_UPGRADE_HOLD_MAX_MS, now)
  if (reason && !holds) {
    log.session.warn('daemon update goes ahead over host_exec runs that kept going too long', { host, heldMs, reason })
    return null
  }
  return reason
}

export interface ExecRunsLink {
  readonly connected: boolean
  hasCapability(cap: string): boolean
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

/**
 * Ask a live daemon whether host_exec runs are going on there (exec.list), through the
 * wait's limit. Null when none runs, the daemon has no host_exec, or the ask fails: the
 * update is not held on a guess, and a service daemon still refuses its own handover
 * while one runs.
 */
export async function execRunsHold(link: ExecRunsLink, host: string, timeoutMs = 10_000): Promise<string | null> {
  if (!link.connected || !link.hasCapability('host-exec-v1')) return null
  let n = 0
  try {
    n = runningJobs(await link.send('exec.list', {}, timeoutMs))
  } catch {
    return null
  }
  return execRunsWait(host, execRunsReason(n))
}

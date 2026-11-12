/**
 * A death the host's own shutdown caused is a restart loss, never a hand-back.
 *
 * 2026-11-03: the Mac rebooted with four sessions mid-turn. While the user
 * session was torn down, the server was still running: each CLI's death reached
 * it (the daemon's snapshot push, the runner's dead-pid turn end, the health
 * monitor's local branch) and was written as a plain stop, the task handed back
 * as NEED_ACTION. The next boot's reconciler found nothing dead (it looks only
 * at records still marked live), so restart recovery resumed none of them.
 * restart-death.ts covers a death reported AFTER a host came back; this covers
 * the one reported while the shutdown is still under way.
 *
 * Every death edge a session sends (phase.ts restartRecoveryHolds) that comes
 * from no stop Walnut or a person asked for is held for a short check. The
 * shutdown shows itself within it: this server begins its own stop (a logout or
 * shutdown signals every process together), or the host's daemon link goes
 * down. Then the death is a restart loss and restart recovery classifies it;
 * its stamp is on disk, so a server that dies first leaves it to the next boot.
 * With neither, the process died on its own (a crash) and is handed back.
 * WALNUT_SHUTDOWN_CHECK=0 turns the check off (the test setup's default).
 */
import type { SessionRecord } from '../types.js'
import { classifySessionError } from '../session-error-kind.js'
import { LOCAL_HOST, isLocalHost } from './auto-recover-env.js'
import { isServerStopping } from '../server-stopping.js'

/** How long a death waits for its host's shutdown to show (a crash is handed back this much later). */
export function shutdownCheckMs(): number {
  const n = Number(process.env.WALNUT_SHUTDOWN_CHECK_MS)
  return process.env.WALNUT_SHUTDOWN_CHECK_MS && Number.isFinite(n) && n >= 0 ? n : 15_000
}

// The flag lives in server-stopping.ts, read by every long operation a stop can cut short.
export { markServerStopping, resetServerStopping } from '../server-stopping.js'

export type ShutdownWitness = 'server_stopping' | 'host_link_down'

/** What a runner writes for a turn's end; with an edge that reports the death itself, no one ended it. */
const TURN_END_REASONS: ReadonlySet<string> = new Set(['normal_completion', 'turn_completed'])

/**
 * Whether a death edge of this record is one to check: a session of a task,
 * not archived, that no person and no Walnut teardown stopped. `processDied`:
 * the edge itself reports the process gone (the runner's liveness tick ends the
 * turn with no result and labels the record as a turn's end).
 */
export function shutdownCheckApplies(record: SessionRecord, processDied = false): boolean {
  if (process.env.WALNUT_SHUTDOWN_CHECK === '0') return false
  if (record.archived || record.stopRequest || !record.taskId) return false
  if (record.type && record.type !== 'interactive') return false
  if (record.status_changed_by === 'user') return false
  const reason: string = record.status_reason ?? ''
  // A host already out of reach: restart-death.ts takes that death on when the host is back.
  if (reason === 'remote_unreachable') return false
  if (reason === 'expected_teardown' || reason === 'idle_timeout'
    || reason === 'user_stopped' || reason === 'user_terminated') return false
  if (processDied && TURN_END_REASONS.has(reason) && record.errorKind !== 'terminal') return true
  if (classifySessionError(record) === 'terminal') return false
  return true
}

/** A link that went down this long before the session's last sign of life still went down with it. */
const LINK_LOST_SLACK_MS = 60_000

/** The fact that says this host is going down now, or null. */
export async function shutdownWitness(record: Pick<SessionRecord, 'host' | 'lastActiveAt'>): Promise<ShutdownWitness | null> {
  // This server's own stop takes down only this computer's processes.
  if (isLocalHost(record.host) && isServerStopping()) return 'server_stopping'
  try {
    const { daemonLinkLostSince } = await import('../../providers/daemon-connection.js')
    // The host's daemon went away with its CLI: a host going down (or out of
    // reach), never a crash of one process. A host never linked says nothing.
    // A link down since before the session last did anything (a host away for
    // hours) says nothing about this death.
    const lost = daemonLinkLostSince(record.host ?? LOCAL_HOST)
    const active = Date.parse(record.lastActiveAt ?? '')
    if (lost != null && Number.isFinite(active) && lost >= active - LINK_LOST_SLACK_MS) return 'host_link_down'
  } catch { /* no daemon layer (a test, a replica) */ }
  return null
}

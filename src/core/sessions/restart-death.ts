/**
 * A daemon reports a CLI dead after a restart: take the loss on before anything
 * writes the death or hands the task back.
 *
 * 2026-11-04: a remote host rebooted with 8 sessions running on it. When it came
 * back, the reconnect pull applied each dead snapshot, and the same apply handed
 * the task back as NEED_ACTION ("task handed back after out-of-band session
 * end"). Restart recovery was only asked a moment later, read NEED_ACTION and
 * resumed nothing ("task was NEED_ACTION"). holdsHandBack could not stop that
 * hand-back: nothing had stamped the loss yet, and its unstamped rule covers
 * only the startup reconciler's own 'server_restart' mark.
 *
 * So the place that first learns of the death (a snapshot apply, the legacy
 * reconnect relabel) notes the loss FIRST: noteLoss marks the session as being
 * classified synchronously, every hand-back path asks holdsHandBack, and the
 * classification reads the task's phase while it is still the phase the work
 * died in. A death is a restart's only with a witness: the host was out of
 * contact (the reconnect pull), its daemon started after the session was last
 * seen, or the record already says the connection or the daemon lost it. A CLI
 * that exits on a host Walnut never lost (a crash, the daemon's idle reap) keeps
 * its usual hand-back.
 */
import type { SessionRecord } from '../types.js'
import { RESCUABLE_STOPPED_WINDOW_MS, classifySessionError } from '../session-error-kind.js'
import { isLocalHost } from './auto-recover-env.js'
import { log } from '../../logging/index.js'

/** How recent a death the record already shows may still be taken for a restart's. */
const FRESH_DEATH_MS = 10 * 60_000
/** Slack for a remote host's clock against this one. */
const CLOCK_MARGIN_MS = 60_000
/** Reasons a record carries only while its host was out of contact. */
const REACHABILITY_REASONS: ReadonlySet<string> = new Set(['remote_unreachable'])

export type RestartWitness = 'reconnect' | 'daemon_restarted' | 'connection_lost'

const isLive = (r: Pick<SessionRecord, 'process_status'>): boolean =>
  r.process_status === 'running' || r.process_status === 'idle'

/**
 * Why this death is a restart's, or null. `record` is the session as it stood
 * before the death was written; `daemonStartedAt` is when the host's daemon
 * started (ms, null when unknown).
 */
export function restartWitness(
  record: SessionRecord,
  how: 'reconnect' | 'report',
  daemonStartedAt: number | null,
  now = Date.now(),
): RestartWitness | null {
  if (record.archived || record.stopRequest) return null
  // A stop someone asked for, or one Walnut meant (idle reap, completion teardown).
  if (record.status_changed_by === 'user') return null
  if (record.status_reason === 'expected_teardown') return null
  if (classifySessionError(record) === 'terminal') return null
  const seen = Date.parse(record.lastActiveAt ?? record.last_status_change ?? '')
  if (isLive(record)) {
    // Seen alive within a day: a record stuck at running for longer is no work in flight.
    if (!Number.isFinite(seen) || now - seen > RESCUABLE_STOPPED_WINDOW_MS) return null
    if (how === 'reconnect') return 'reconnect'
    // A daemon that started after the session was last seen, and lately (a
    // daemon swap leaves CLIs alive, so an old start says nothing about a death
    // now); a minute's margin for the host's clock.
    if (daemonStartedAt != null && daemonStartedAt > seen + CLOCK_MARGIN_MS
      && now - daemonStartedAt < FRESH_DEATH_MS) return 'daemon_restarted'
    return null
  }
  // A death already written counts only when the record says the host was out
  // of contact (a crash written as daemon_reported_exit on a working link is
  // none), and only a recent one, so an old dead record is never resumed. Across
  // a reconnect the outage itself may have lasted long (a host that takes half
  // an hour to boot): its first contact within a day still counts.
  if (!REACHABILITY_REASONS.has(record.status_reason ?? '')) return null
  const changed = Date.parse(record.last_status_change ?? '')
  const window = how === 'reconnect' ? RESCUABLE_STOPPED_WINDOW_MS : FRESH_DEATH_MS
  if (!Number.isFinite(changed) || now - changed > window) return null
  return 'connection_lost'
}

/**
 * Note the loss when the death has a witness. Returns true when restart
 * recovery took the session on (its hand-backs are held from here). Never throws.
 */
export async function noteRestartDeath(
  record: SessionRecord,
  how: 'reconnect' | 'report',
  source: string,
  daemonStartedAt: number | null = null,
): Promise<boolean> {
  try {
    const witness = restartWitness(record, how, daemonStartedAt)
    if (!witness) return false
    const { getSessionAutoRecover } = await import('../session-auto-recover.js')
    const recovery = getSessionAutoRecover()
    if (!recovery) return false
    const cause = isLocalHost(record.host) ? 'server_restart' : 'host_restart'
    // The witness is the infrastructure fact; `record` is the life before the death.
    const taken = recovery.noteLoss(record, cause, record, { requireInfra: false })
    if (taken) {
      log.session.info('restart recovery: death noted before its write', {
        sessionId: record.claudeSessionId, taskId: record.taskId ?? null, host: record.host ?? null,
        witness, source, priorStatus: record.process_status,
      })
    }
    return taken
  } catch (err) {
    log.session.warn('restart recovery: noting a death failed', {
      sessionId: record.claudeSessionId, source, error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

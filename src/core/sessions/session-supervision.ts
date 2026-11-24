import { SessionControlError } from './session-controls.js'
import { isSessionStopSuperseded, sessionStops } from './session-stop.js'
import { linkFailureKind } from '../../providers/link-failure.js'
import { withDeadline } from '../../lib/with-deadline.js'
import { cliHostOf } from './session-row-owner.js'

/**
 * The last state each session's host confirmed, so a read whose host did not
 * answer (a daemon swap, a tunnel reconnecting, a host under load) answers that
 * state marked `stale` instead of failing (2026-11-03: every open panel polls this
 * every 15 s, and each 5 s timeout was a 500 and a red card). Bounded, in memory:
 * a read with nothing kept answers the host unavailable, as a disconnected host does.
 */
const LAST_KNOWN_MAX = 256
const LAST_KNOWN_MS = 30 * 60_000
const lastKnown = new Map<string, { startup: unknown; supervision: unknown; at: number }>()

function keep(sid: string, startup: unknown, supervision: unknown): void {
  lastKnown.delete(sid)
  lastKnown.set(sid, { startup, supervision, at: Date.now() })
  if (lastKnown.size > LAST_KNOWN_MAX) lastKnown.delete(lastKnown.keys().next().value as string)
}

export function _resetSupervisionLastKnownForTesting(): void { lastKnown.clear() }

/**
 * The longest a read waits before it answers the kept state (or unavailable). Under the page's
 * 8 s timeout and the usage watch's 5 s slow read: the host's own 5 s RPC plus the link's waits
 * around it went past 8 s on a loaded host (2026-11-23, 12 page timeouts in 6 h). The RPC goes on
 * behind, and a late answer is kept for the next poll.
 */
export const SUPERVISION_READ_DEADLINE_MS = 4_500
let readDeadlineMs = SUPERVISION_READ_DEADLINE_MS
export function _setSupervisionReadDeadlineForTesting(ms?: number): void { readDeadlineMs = ms ?? SUPERVISION_READ_DEADLINE_MS }

type SupervisionAnswer = { stopRequest: unknown; available: boolean; startup: unknown; supervision: unknown; stale?: boolean }

/** What a read whose host did not answer in time says: the kept state marked stale, else unavailable. */
function keptOrUnavailable(sid: string, stopRequest: unknown): SupervisionAnswer {
  const kept = lastKnown.get(sid)
  if (kept && Date.now() - kept.at < LAST_KNOWN_MS) return { stopRequest, available: true, startup: kept.startup, supervision: kept.supervision, stale: true }
  return { stopRequest, available: false, startup: 'unavailable', supervision: null }
}

function validSupervision(value: unknown): boolean {
  if (value === null) return true
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.enabled === 'boolean'
    && ['watching', 'restarting', 'checking', 'disabled', 'inactive', 'blocked'].includes(String(record.state))
    && Number.isSafeInteger(record.generation) && Number(record.generation) >= 1
    && Number.isFinite(record.updatedAt)
    && (record.retryAt === null || Number.isFinite(record.retryAt))
    && (record.reason === null || typeof record.reason === 'string')
}

export async function readSessionSupervision(sid: string, enabled?: boolean): Promise<SupervisionAnswer> {
  // A session its host runs and judges: its host reads or sets it on its own daemon (host-lifecycle.ts).
  const { sessionCommandTarget } = await import('./session-command-gate.js')
  if (sessionCommandTarget(sid).to === 'host') return onJudgingHostSupervision(sid, enabled)
  if (enabled !== undefined) return askSupervision(sid, enabled)
  const { getSessionByClaudeIdSync } = await import('../session-tracker.js')
  return withDeadline(askSupervision(sid), readDeadlineMs, () => keptOrUnavailable(sid, getSessionByClaudeIdSync(sid)?.stopRequest ?? null))
}

/** The host's own answer for its session: a change it did not confirm is an error, a read it did not answer the kept state. */
async function onJudgingHostSupervision(sid: string, enabled?: boolean): Promise<SupervisionAnswer> {
  const { onJudgingHost } = await import('./host-judged-controls.js')
  const asked = onJudgingHost(sid, 'readSessionSupervision', enabled === undefined ? [] : [enabled]) as Promise<SupervisionAnswer>
  if (enabled !== undefined) {
    try { return await asked } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'host_needs_update') {
        throw new SessionControlError(`Automatic recovery was not changed: ${(error as Error).message}`, 409, { code: 'host_needs_update' })
      }
      lastKnown.delete(sid)
      throw new SessionControlError(`The session's host did not confirm the automatic recovery change: ${error instanceof Error ? error.message : String(error)}`, 503, { code: 'host_no_answer' })
    }
  }
  const { getSessionByClaudeIdSync } = await import('../session-tracker.js')
  const answer = await withDeadline(asked.then((a) => { keep(sid, a.startup, a.supervision); return a }, () => keptOrUnavailable(sid, getSessionByClaudeIdSync(sid)?.stopRequest ?? null)),
    readDeadlineMs, () => keptOrUnavailable(sid, getSessionByClaudeIdSync(sid)?.stopRequest ?? null))
  return answer
}

async function askSupervision(sid: string, enabled?: boolean): Promise<SupervisionAnswer> {
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  const record = await getSessionByClaudeId(sid)
  if (!record) throw new SessionControlError('Session not found', 404)
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
  // A host's own session is on its own daemon (session-row-owner.ts cliHostOf).
  const conn = getConnectedDaemonConnection(cliHostOf(record))
  if (enabled === true && record.archived) throw new SessionControlError('Unarchive the session before enabling automatic recovery', 409)
  const base = { stopRequest: record.stopRequest ?? null }
  if (!conn?.connected || !conn.capabilitiesKnown) {
    if (enabled !== undefined) throw new SessionControlError('Host unavailable; automatic recovery was not changed', 503, { code: 'host_reconnecting' })
    return { ...base, available: false, startup: 'unavailable', supervision: null }
  }
  if (!conn.hasCapability('cron-supervision-v1')) {
    if (enabled !== undefined) throw new SessionControlError('Automatic recovery requires a managed daemon service on this host', 409)
    return { ...base, available: false, startup: 'on-demand', supervision: null }
  }
  let reply: Record<string, unknown>
  try {
    if (enabled === undefined) reply = await conn.send('cron.supervision', { sid }, 5000)
    else {
      const stopFence = await sessionStops.fence(sid)
      reply = await sessionStops.dispatch(sid, stopFence, () => conn.send('cron.supervision', { sid, enabled, stopFence }, 5000))
    }
  } catch (error) {
    if (isSessionStopSuperseded(error)) throw new SessionControlError(error.message, 409, { code: 'stop_pending' })
    const link = linkFailureKind(error)
    if (!link) throw error
    if (enabled !== undefined) {
      if (link === 'no-link') throw new SessionControlError('Host unavailable; automatic recovery was not changed', 503, { code: 'host_reconnecting' })
      // The command went out and may have run there: what is kept is no longer known, and the next read shows which.
      lastKnown.delete(sid)
      throw new SessionControlError('Host did not answer; automatic recovery may have changed. Check again in a moment.', 504, { code: 'host_no_answer' })
    }
    const current = await getSessionByClaudeId(sid)
    return keptOrUnavailable(sid, current?.stopRequest ?? null)
  }
  if (reply.ok !== true) throw new SessionControlError(typeof reply.error === 'string' ? reply.error : 'Host did not confirm automatic recovery settings', 503)
  if (!validSupervision(reply.cronSupervision)) throw new SessionControlError('Host returned invalid automatic recovery state', 503)
  if (enabled !== undefined && (reply.cronSupervision as { enabled?: unknown } | null)?.enabled !== enabled) {
    throw new SessionControlError('Host did not apply the requested automatic recovery setting', 503)
  }
  keep(sid, conn.daemonStartup, reply.cronSupervision ?? null)
  const current = await getSessionByClaudeId(sid)
  return { stopRequest: current?.stopRequest ?? null, available: true, startup: conn.daemonStartup, supervision: reply.cronSupervision ?? null }
}

import { SessionControlError } from './session-controls.js'
import { isSessionStopSuperseded, sessionStops } from './session-stop.js'

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

export async function readSessionSupervision(sid: string, enabled?: boolean) {
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  const record = await getSessionByClaudeId(sid)
  if (!record) throw new SessionControlError('Session not found', 404)
  const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js')
  const conn = getConnectedDaemonConnection(record.host ?? '__local__')
  if (enabled === true && record.archived) throw new SessionControlError('Unarchive the session before enabling automatic recovery', 409)
  const base = { stopRequest: record.stopRequest ?? null }
  if (!conn?.connected || !conn.capabilitiesKnown) {
    if (enabled !== undefined) throw new SessionControlError('Host unavailable; automatic recovery was not changed', 503)
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
    throw error
  }
  if (reply.ok !== true) throw new SessionControlError(typeof reply.error === 'string' ? reply.error : 'Host did not confirm automatic recovery settings', 503)
  if (!validSupervision(reply.cronSupervision)) throw new SessionControlError('Host returned invalid automatic recovery state', 503)
  if (enabled !== undefined && (reply.cronSupervision as { enabled?: unknown } | null)?.enabled !== enabled) {
    throw new SessionControlError('Host did not apply the requested automatic recovery setting', 503)
  }
  const current = await getSessionByClaudeId(sid)
  return { stopRequest: current?.stopRequest ?? null, available: true, startup: conn.daemonStartup, supervision: reply.cronSupervision ?? null }
}

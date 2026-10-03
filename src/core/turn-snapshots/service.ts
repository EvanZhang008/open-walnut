/**
 * Server side of the per-turn snapshots and the rewind guard: a thin relay to
 * the session's daemon (capability 'turn-snapshot-v1'). The git work and the
 * guard's verdict run host-local in the daemon (src/providers/turn-snapshot-core.ts,
 * src/providers/turn-guard-core.ts); only small answers cross the tunnel.
 *
 * Every call has a deadline: dialing a host that is not connected waits at
 * most DIAL_WAIT_MS (then 503 `host_connecting`; the dial goes on in the pool),
 * and every daemon command carries its own timeout (then 504).
 */

import { SessionControlError } from '../sessions/session-controls.js'
import { log } from '../../logging/index.js'
import type { SessionRecord } from '../types.js'
import type {
  TurnSnapshotListResult, TurnSnapshotDiffResult, TurnSnapshotRestoreResult,
} from '../../providers/turn-snapshot-core.js'
import type { TurnGuardResult, TurnGuardSibling } from '../../providers/turn-guard-core.js'

export const TURN_SNAPSHOT_CAPABILITY = 'turn-snapshot-v1'

const LIST_TIMEOUT_MS = 20_000
const DIFF_TIMEOUT_MS = 20_000
const RESTORE_TIMEOUT_MS = 75_000
const GUARD_TIMEOUT_MS = 10_000
const DIAL_WAIT_MS = 10_000
const MAX_SIBLINGS = 12
const SIBLING_SCAN = 200
const SIBLING_MAX_AGE_MS = 14 * 24 * 3600_000

interface Conn {
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<{ ok: boolean; error?: string; [k: string]: unknown }>
  hasCapability(cap: string): boolean
  connected?: boolean
}

/** Why there is no Turns view for this session (null: there is one). */
export type TurnsUnavailableReason = 'no_cwd' | 'no_daemon' | 'daemon_upgrade'

export interface SessionTurnsResponse extends Partial<TurnSnapshotListResult> {
  supported: boolean
  reason?: TurnsUnavailableReason
  host?: string
  cwd?: string
}

async function sessionRecord(sessionId: string): Promise<SessionRecord> {
  const { getSessionByClaudeId } = await import('../session-tracker.js')
  const record = await getSessionByClaudeId(sessionId)
  if (!record) throw new SessionControlError('Session not found', 404, { code: 'not_found' })
  return record
}

/**
 * The session host's daemon that speaks 'turn-snapshot-v1'. A host can hold
 * more than one live connection (the local daemon has a pooled and a direct
 * one), and only those whose handshake listed the capability can answer, so
 * pick among all of them. Nobody connected yet: dial once, with a bounded wait.
 */
async function capableConnection(record: SessionRecord): Promise<{ conn: Conn | null; reason?: TurnsUnavailableReason }> {
  const dc = await import('../../providers/daemon-connection.js')
  const key = isRemoteHost(record.host) ? record.host : '__local__'
  const pick = (): Conn[] => (dc.listConnectedDaemonsByHost().get(key) ?? []) as unknown as Conn[]
  let conns = pick()
  if (conns.length === 0) {
    const dialed = await dial(key)
    conns = pick()
    if (conns.length === 0 && dialed && dialed.connected !== false) conns = [dialed]
  }
  if (conns.length === 0) return { conn: null, reason: 'no_daemon' }
  const able = conns.find((c) => c.hasCapability(TURN_SNAPSHOT_CAPABILITY))
  return able ? { conn: able } : { conn: null, reason: 'daemon_upgrade' }
}

async function dial(key: string): Promise<Conn | null> {
  const dc = await import('../../providers/daemon-connection.js')
  let target: { hostname: string; user?: string; port?: number } | null = null
  if (key === '__local__') {
    target = { hostname: '__local__' }
  } else {
    const { getConfig } = await import('../config-manager.js')
    const def = (await getConfig()).hosts?.[key] as { hostname?: string; user?: string; port?: number } | undefined
    if (def) target = { hostname: def.hostname ?? key, user: def.user, port: def.port }
  }
  if (!target) return null
  const t = target
  // A dial that fails is "no daemon"; one still going past the wait is a 503
  // the caller can retry (the pool keeps dialing; this request does not wait).
  return new Promise<Conn | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SessionControlError(
      `Still connecting to ${key === '__local__' ? 'this Mac' : key}; try again in a moment`, 503, { code: 'host_connecting', host: key },
    )), DIAL_WAIT_MS)
    dc.getDaemonConnection(key, t).then(
      (c) => { clearTimeout(timer); resolve(c as unknown as Conn) },
      () => { clearTimeout(timer); resolve(null) },
    )
  })
}

/** A host key naming a remote host ('' and '__local__' are this machine). */
function isRemoteHost(host: string | null | undefined): host is string {
  return typeof host === 'string' && host !== '' && host !== '__local__'
}

/** A daemon answer as a route error: the core's error codes keep their meaning. */
function daemonError(res: { error?: string; code?: unknown }, what: string): SessionControlError {
  const code = typeof res.code === 'string' ? res.code : ''
  const message = String(res.error ?? what + ' failed').replace(/^turns\.\w+ failed: /, '')
  if (code === 'turn-running') return new SessionControlError(message, 409, { code: 'turn_running' })
  if (code === 'not-found') return new SessionControlError(message, 404, { code: 'not_found' })
  if (code === 'bad-request') return new SessionControlError(message, 400, { code: 'bad_request' })
  if (code === 'not-a-repo') return new SessionControlError(message, 409, { code: 'not_a_repo' })
  if (code === 'not-allowed') return new SessionControlError(message, 403, { code: 'not_allowed' })
  if (/^(index-locked|merge|rebase|cherry-pick|revert)/.test(code)) return new SessionControlError(message, 409, { code: 'repo_busy', reason: code })
  if (code === 'timeout') return new SessionControlError(message, 504, { code: 'timeout' })
  return new SessionControlError(message, 502, { code: 'daemon_error' })
}

/** The daemon's answer without the envelope fields. */
function body<T>(res: Record<string, unknown>): T {
  const { ok: _ok, id: _id, traceId: _t, ...rest } = res
  return rest as unknown as T
}

async function send(conn: Conn, cmd: string, params: Record<string, unknown>, timeoutMs: number) {
  try {
    return await conn.send(cmd, params, timeoutMs)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new SessionControlError(/timeout/i.test(message) ? 'The host took too long to answer' : message, 504, { code: 'timeout' })
  }
}

export async function listSessionTurns(sessionId: string): Promise<SessionTurnsResponse> {
  const record = await sessionRecord(sessionId)
  if (!record.cwd) return { supported: false, reason: 'no_cwd' }
  const { conn, reason } = await capableConnection(record)
  if (!conn) return { supported: false, reason, ...(record.host ? { host: record.host } : {}), cwd: record.cwd }
  const res = await send(conn, 'turns.list', { sid: sessionId, cwd: record.cwd }, LIST_TIMEOUT_MS)
  if (!res.ok) throw daemonError(res, 'turns.list')
  return { supported: true, ...body<TurnSnapshotListResult>(res), ...(record.host ? { host: record.host } : {}), cwd: record.cwd }
}

export async function sessionTurnDiff(
  sessionId: string, n: number, path: string, against: 'previous' | 'worktree',
): Promise<TurnSnapshotDiffResult> {
  const record = await sessionRecord(sessionId)
  if (!record.cwd) throw new SessionControlError('This session has no working directory', 409, { code: 'no_cwd' })
  const { conn, reason } = await capableConnection(record)
  if (!conn) throw new SessionControlError('Turn snapshots are not available on this host', 409, { code: reason })
  const res = await send(conn, 'turns.diff', { sid: sessionId, cwd: record.cwd, n, path, against }, DIFF_TIMEOUT_MS)
  if (!res.ok) throw daemonError(res, 'turns.diff')
  return body<TurnSnapshotDiffResult>(res)
}

export async function restoreSessionTurn(
  sessionId: string, n: number, opts: { paths?: string[]; dryRun?: boolean },
): Promise<TurnSnapshotRestoreResult> {
  const record = await sessionRecord(sessionId)
  if (!record.cwd) throw new SessionControlError('This session has no working directory', 409, { code: 'no_cwd' })
  const { conn, reason } = await capableConnection(record)
  if (!conn) throw new SessionControlError('Turn snapshots are not available on this host', 409, { code: reason })
  const res = await send(conn, 'turns.restore', {
    sid: sessionId, cwd: record.cwd, n,
    ...(opts.paths && opts.paths.length ? { paths: opts.paths } : {}),
    ...(opts.dryRun ? { dryRun: true } : {}),
  }, RESTORE_TIMEOUT_MS)
  if (!res.ok) throw daemonError(res, 'turns.restore')
  if (!opts.dryRun) {
    log.session.info('turn snapshot restore', {
      sessionId, n, backupN: res.backupN, afterN: res.afterN,
      write: Array.isArray(res.write) ? res.write.length : 0, delete: Array.isArray(res.delete) ? res.delete.length : 0,
    })
  }
  return body<TurnSnapshotRestoreResult>(res)
}

/** How many leading path segments two directories share. */
function sharedSegments(a: string, b: string): number {
  const x = a.split('/').filter(Boolean)
  const y = b.split('/').filter(Boolean)
  let n = 0
  while (n < x.length && n < y.length && x[n] === y[n]) n++
  return n
}

/**
 * Other sessions on the same host that may have written the same repository:
 * the daemon checks the repository for each, so this only ranks (closest cwd
 * first, then the most recent) and bounds the list.
 */
export async function siblingSessions(record: SessionRecord, now = Date.now()): Promise<TurnGuardSibling[]> {
  const { listRecentSessionRecords } = await import('../session-tracker.js')
  const host = isRemoteHost(record.host) ? record.host : '__local__'
  const cwd = record.cwd ?? ''
  const rows = await listRecentSessionRecords(SIBLING_SCAN)
  const out: Array<TurnGuardSibling & { score: number; at: number }> = []
  for (const r of rows) {
    if (r.claudeSessionId === record.claudeSessionId || !r.cwd) continue
    if ((isRemoteHost(r.host) ? r.host : '__local__') !== host) continue
    // Only Claude Code transcripts carry the ops the daemon reads.
    if (r.provider && r.provider !== 'cli') continue
    if (r.engine && r.engine !== 'claude') continue
    const at = Date.parse(r.lastActiveAt ?? '') || 0
    if (now - at > SIBLING_MAX_AGE_MS) continue
    const score = sharedSegments(r.cwd, cwd)
    if (score < 2 && r.cwd !== cwd) continue
    out.push({ sid: r.claudeSessionId, cwd: r.cwd, ...(r.title ? { title: r.title } : {}), score, at })
  }
  out.sort((a, b) => (b.score - a.score) || (b.at - a.at))
  return out.slice(0, MAX_SIBLINGS).map(({ sid, cwd: c, title }) => ({ sid, cwd: c, ...(title ? { title } : {}) }))
}

export interface RewindGuardResponse {
  guard: TurnGuardResult | null
  reason?: TurnsUnavailableReason | 'timeout' | 'error'
}

/**
 * For files a rewind would restore: which ones someone else changed after this
 * session last wrote them, and who. Never throws for a host problem: the
 * dialog then behaves as it did before the guard (`guard: null`).
 */
export async function rewindGuard(sessionId: string, files: unknown): Promise<RewindGuardResponse> {
  const record = await sessionRecord(sessionId)
  const list = Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string' && f.startsWith('/')).slice(0, 200) : []
  if (!record.cwd) return { guard: null, reason: 'no_cwd' }
  try {
    const { conn, reason } = await capableConnection(record)
    if (!conn) return { guard: null, ...(reason ? { reason } : {}) }
    const siblings = await siblingSessions(record)
    const res = await conn.send('turns.guard', { sid: sessionId, cwd: record.cwd, files: list, siblings }, GUARD_TIMEOUT_MS)
    if (!res.ok) {
      log.session.warn('rewind guard failed on the daemon', { sessionId, error: res.error })
      return { guard: null, reason: 'error' }
    }
    return { guard: body<TurnGuardResult>(res) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.session.warn('rewind guard unavailable', { sessionId, error: message })
    return { guard: null, reason: /timeout/i.test(message) ? 'timeout' : 'error' }
  }
}

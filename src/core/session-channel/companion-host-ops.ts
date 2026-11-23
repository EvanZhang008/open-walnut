/**
 * What the cloud companion's phone routes do with a session its host judges, from what that host's
 * listener link told (companion-listener.ts):
 *
 *   list / detail   the host's rows join the phone's session list (joinListenedRows) and answer its
 *                   detail with the pending prompts of the `live` state (listenedDetail)
 *   operate         only while the Mac is away (macAway): a send, an interrupt and a prompt's answer
 *                   go to the host's own routes as call frames on the listener link (listener-wire.ts
 *                   LISTENER_CALLS), answered by the same route table and checks the leader's calls
 *                   go through. While the Mac answers, each route relays to it as before: one path
 *                   at a time. Every answer of this path carries `viaHost: true` (additive).
 *
 * The Mac is away when its own bridge is gone, or its heartbeat has been quiet for the takeover
 * window (backup-leader.ts status): the same silence the backup leader judges by.
 */
import { listenedRow, listenedRows, listenerLinked, callListenedHost, ListenerNotLinked } from './companion-listener.js'
import type { LiveState } from './host-api.js'
import type { SessionRecord } from '../types.js'

const MAC_ALIAS = '__local__'

/** Is the Mac away now (see the header)? */
export async function macAway(now = Date.now()): Promise<boolean> {
  const [{ bridgeForHost }, { getBackupLeader }] = await Promise.all([import('../../web/ws/bridge-registry.js'), import('../leader/backup-leader.js')])
  if (!bridgeForHost(MAC_ALIAS).connected) return true
  const s = (await getBackupLeader())?.status()
  return !!s && now - s.primaryLastSeenAt >= s.takeoverMs
}

export interface OperatedSession { alias: string; row: SessionRecord; live: LiveState | null }

/** The host-judged session `sid` this companion operates now: told by a linked host, the Mac away. Else null. */
export async function hostOperated(sid: string): Promise<OperatedSession | null> {
  const t = listenedRow(sid)
  if (!t || !listenerLinked(t.alias)) return null
  return (await macAway()) ? t : null
}

/** Has any host's listener link told rows (the list answers from them when the copy has none yet)? */
export function anyListenedRows(): boolean {
  return listenedRows().length > 0
}

/** Does a host's listener link stand for `sid` (its rows name it)? The daemon-level paths leave such a session alone. */
export function listenedSession(sid: string): boolean {
  return listenedRow(sid) !== null
}

/**
 * The phone's session list with the host-judged rows the listeners told joined in: a row the copy
 * lacks (born while the Mac was away) is added; one the copy also has is the host's while the Mac
 * is away, with the copy's own fields (the task's title, the host's label) kept.
 */
export async function joinListenedRows<P extends { id: string }>(projected: P[]): Promise<Array<P | Record<string, unknown> & { id: string }>> {
  const told = listenedRows()
  if (told.length === 0) return projected
  const { projectSession } = await import('../session-projection.js')
  const away = await macAway()
  const byId = new Map(told.map((t) => [t.row.claudeSessionId, t]))
  const out: Array<P | Record<string, unknown> & { id: string }> = projected.map((p) => {
    const t = byId.get(p.id)
    if (!t) return p
    byId.delete(p.id)
    return away ? { ...p, ...projectSession(t.row, undefined) } : p
  })
  for (const t of byId.values()) out.push(projectSession(t.row, undefined) as unknown as Record<string, unknown> & { id: string })
  return out
}

/** GET /sessions/:id from the host's word: its row and the prompts it waits on now. */
export function listenedDetail(t: OperatedSession): Record<string, unknown> {
  const pending = Array.isArray(t.live?.pendingPermissionRequests) ? t.live!.pendingPermissionRequests : []
  return { session: t.row, pendingPermissions: pending, viaHost: true }
}

/** A host answer as the phone's route gives it. */
export interface HostAnswer { status: number; body: Record<string, unknown> }

const v1Error = (status: number, code: string, message: string): HostAnswer => ({ status, body: { error: { code, message } } })

async function call(t: OperatedSession, path: string, body: unknown, timeoutMs: number): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; answer: HostAnswer }> {
  try {
    const r = await callListenedHost(t.alias, path, body, timeoutMs)
    const b = (r.body && typeof r.body === 'object' ? r.body : {}) as Record<string, unknown>
    if (r.status === 200 && b.ok === true) return { ok: true, body: b }
    const why = typeof b.error === 'string' ? b.error : `the host answered ${r.status}`
    if (why === 'not_own_session') return { ok: false, answer: v1Error(404, 'not_found', 'The session\'s host does not run this session') }
    return { ok: false, answer: v1Error(r.status >= 400 && r.status < 500 ? r.status : 503, r.status >= 400 && r.status < 500 ? 'bad_request' : 'bridge_offline', why) }
  } catch (err) {
    // Not linked: nothing was sent. A timeout or a dropped link: the host may have taken it, and a
    // retry with the same message id is queued once there (the host's queue keys it by that id).
    const message = err instanceof ListenerNotLinked ? 'The session\'s host is not linked to the companion right now; retrying automatically'
      : 'The session\'s host did not answer in time; retrying automatically'
    return { ok: false, answer: v1Error(503, 'bridge_offline', message) }
  }
}

/** A phone's text send, queued on the host under the phone's message id (a retry is queued once). */
export async function sendViaHost(t: OperatedSession, o: { text: string; messageId: string; timeoutMs: number }): Promise<HostAnswer> {
  const sid = t.row.claudeSessionId
  const body = {
    sessionId: sid, message: o.text, ...(t.row.taskId ? { taskId: t.row.taskId } : {}),
    queued: [{ id: o.messageId, message: o.text, sentBy: 'person' as const }], busSource: 'mobile',
  }
  const r = await call(t, '/host-api/sessions/send', body, o.timeoutMs)
  return r.ok ? { status: 202, body: { messageId: o.messageId, viaHost: true } } : r.answer
}

/** The phone's Stop: the running turn only. */
export async function interruptViaHost(t: OperatedSession, timeoutMs = 15_000): Promise<HostAnswer> {
  const sid = t.row.claudeSessionId
  const wasRunning = t.live?.turnRunning ?? t.live?.inTurn ?? t.row.process_status === 'running'
  const r = await call(t, '/host-api/sessions/interrupt', { sessionId: sid, busSource: 'mobile' }, timeoutMs)
  return r.ok ? { status: 200, body: { status: 'interrupted', sessionId: sid, wasRunning: wasRunning === true, viaHost: true } } : r.answer
}

/**
 * The phone's answer to a prompt: checked as the Mac's route checks it, then the session's own
 * `resolvePermissionRequest` on the host (which first proves the request is pending on that session).
 * Pictures are not carried this way: an answer with pictures is refused, so the phone can send it
 * once the Mac is back.
 */
export async function permissionViaHost(t: OperatedSession, b: Record<string, unknown>, timeoutMs = 20_000): Promise<HostAnswer> {
  const { requestId, allow, message, optionId, answers } = b
  if (typeof requestId !== 'string' || !requestId || typeof allow !== 'boolean') return v1Error(400, 'bad_request', 'requestId (string) and allow (boolean) are required')
  if (message !== undefined && typeof message !== 'string') return v1Error(400, 'bad_request', 'message must be a string')
  if (optionId !== undefined && typeof optionId !== 'string') return v1Error(400, 'bad_request', 'optionId must be a string')
  if (answers !== undefined && (typeof answers !== 'object' || answers === null || Array.isArray(answers) || Object.values(answers).some((v) => typeof v !== 'string'))) {
    return v1Error(400, 'bad_request', 'answers must be an object mapping question to answer string')
  }
  if (b.images !== undefined || b.imageRefs !== undefined) return v1Error(409, 'conflict', 'An answer with pictures waits for your Mac')
  const { isAcpEngine } = await import('../agents/engine-registry.js')
  const acp = isAcpEngine(t.row.engine)
  const patch = answers !== undefined && Object.keys(answers as object).length > 0 ? { answers } : undefined
  // The session's own parameters (claude-code-session.ts, acp-session.ts); a trailing one left out is
  // absent there, an inner one null (JSON carries no undefined).
  const raw: unknown[] = acp ? [requestId, allow, optionId] : [requestId, allow, message, patch, optionId]
  while (raw.length > 0 && raw[raw.length - 1] === undefined) raw.pop()
  const args = raw.map((v) => (v === undefined ? null : v))
  const sid = t.row.claudeSessionId
  const r = await call(t, '/host-api/sessions/call', { sid, target: acp ? 'acp' : 'session', member: 'resolvePermissionRequest', args }, timeoutMs)
  if (!r.ok) {
    const e = (r.answer.body.error as { message?: string } | undefined)?.message
    if (e === 'not_pending' || e === 'no_live_session') return v1Error(404, 'not_found', 'Permission request not found or already resolved')
    return r.answer
  }
  if (r.body.value !== true) return v1Error(503, 'bridge_offline', 'Permission answer was not confirmed by the session host; retry the same request')
  return { status: 200, body: { status: 'resolved', requestId, allow, viaHost: true } }
}

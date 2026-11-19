/**
 * Is a completed task's work really over, so its workspace may be torn down?
 * Every path that ends in a teardown script or a removal asks this first
 * (cleanup.ts): the completion, a session's stop, the boot pass, a script that
 * ended, a deletion.
 *
 * A session record is not enough. 2026-11-19: a task completed itself while its
 * turn went on (its session stops at turn end, a wait held in memory); a restart
 * lost that wait, the boot migration marked the session stopped although its stop
 * never reached the host, and the cleanup read "no live session" and ran the
 * teardown, which deleted the running session's node_modules. So the host's daemon
 * is asked about each recent session, whatever its record says, and a host that
 * cannot answer counts as "maybe alive". The sessions are the task's and any whose
 * folder is inside the workspace (a deleted task's sessions are unlinked from it
 * before its cleanup runs), each asked about on its own host.
 *
 * Also not over: a request to the task nobody answered yet, unless its asker's task
 * is complete (nobody waits) or the task handed it on (another task answers).
 */

import type { SessionRecord, Task } from '../types.js'
import type { TaskWorkspace } from './types.js'
import { engineCaps } from '../agents/engine-registry.js'

/** At most this many of the task's sessions are asked about, the most recently active first. */
const MAX_PROBED = 12

/** One host's answer may take this long; longer counts as "cannot say". */
export const PROBE_DEADLINE_MS = 3_000

export interface StillWorkingIo {
  /** The task's sessions, and any session whose folder is `root` or inside it. */
  sessions(taskId: string, root: string | undefined): Promise<SessionRecord[]>
  /** The host's answer for one session process: alive or not, null when it cannot say. */
  probe(host: string, sessionId: string): Promise<{ alive: boolean } | null>
  /** Whether the record's engine can be asked by session id (an ACP worker cannot). */
  probeable(session: SessionRecord): boolean
  /** Pending requests addressed to the task or to one of its sessions. */
  pendingRequests(taskId: string, sessionIds: string[]): Promise<Array<{ id: string; fromSessionId: string; carriedBy?: unknown[] }>>
  /** The task the asking session belongs to, and its phase; null when unknown. */
  askerTask(sessionId: string): Promise<{ id: string; phase: string } | null>
}

const hostOf = (h: string | null | undefined) => (h && h !== 'local' ? h : '__local__')

/**
 * Why the task's work is not over (a sentence for the log), or null when it is.
 * `opts.requests: false` skips the request check (a deleted task owes nobody).
 */
export async function stillWorking(
  task: Pick<Task, 'id'>,
  ws: Pick<TaskWorkspace, 'root'>,
  io: StillWorkingIo,
  opts: { requests?: boolean } = {},
): Promise<string | null> {
  const all = (await io.sessions(task.id, ws.root)).filter((s) => !s.archived)
  const recordLive = all.find((s) => s.process_status === 'running' || s.process_status === 'idle')
  if (recordLive) return `session ${recordLive.claudeSessionId.slice(0, 8)} is ${recordLive.process_status}`
  const asked = all
    .filter((s) => s.provider !== 'embedded' && s.provider !== 'sdk' && io.probeable(s))
    .sort((a, b) => String(b.lastActiveAt ?? '').localeCompare(String(a.lastActiveAt ?? '')))
    .slice(0, MAX_PROBED)
  for (const s of asked) {
    const answer = await io.probe(hostOf(s.host), s.claudeSessionId).catch(() => null)
    if (answer === null) return `the host could not say whether session ${s.claudeSessionId.slice(0, 8)} still runs`
    if (answer.alive) return `session ${s.claudeSessionId.slice(0, 8)} still runs on the host (its record says ${s.process_status ?? 'nothing'})`
  }
  if (opts.requests === false) return null
  const owed: string[] = []
  for (const r of await io.pendingRequests(task.id, all.map((s) => s.claudeSessionId))) {
    if ((r.carriedBy?.length ?? 0) > 0) continue
    const asker = await io.askerTask(r.fromSessionId).catch(() => null)
    if (asker?.id === task.id || asker?.phase === 'COMPLETE') continue
    owed.push(r.id)
  }
  return owed.length ? `it owes an answer to ${owed.join(', ')}` : null
}

export const realStillWorkingIo: StillWorkingIo = {
  async sessions(taskId, root) {
    const { getSessionsForTask, getSessionsInFolder } = await import('../session-tracker.js')
    const found = new Map<string, SessionRecord>()
    for (const s of [...await getSessionsForTask(taskId), ...(root ? await getSessionsInFolder(root) : [])]) found.set(s.claudeSessionId, s)
    return [...found.values()]
  },
  async probe(host, sessionId) {
    const { probeDaemonSession } = await import('../../providers/daemon-connection.js')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        probeDaemonSession(host, sessionId),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), PROBE_DEADLINE_MS) }),
      ])
    } finally {
      clearTimeout(timer)
    }
  },
  probeable(session) {
    // Engines whose record cannot be checked by session id (ACP workers) are read by their record only.
    return !!session.claudeSessionId && engineCaps(session.engine).sidLivenessProbe !== false
  },
  async pendingRequests(taskId, sessionIds) {
    const { pendingRequestsForTarget } = await import('../session-requests.js')
    const found = new Map<string, Awaited<ReturnType<typeof pendingRequestsForTarget>>[number]>()
    for (const r of await pendingRequestsForTarget({ taskId })) found.set(r.id, r)
    for (const sid of sessionIds) for (const r of await pendingRequestsForTarget({ sessionId: sid })) found.set(r.id, r)
    return [...found.values()]
  },
  async askerTask(sessionId) {
    const { getSessionByClaudeId } = await import('../session-tracker.js')
    const taskId = (await getSessionByClaudeId(sessionId))?.taskId
    if (!taskId) return null
    const { getTask } = await import('../task-manager.js')
    const t = await getTask(taskId).catch(() => null)
    return t ? { id: t.id, phase: t.phase } : null
  },
}

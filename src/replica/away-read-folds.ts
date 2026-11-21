/**
 * What a host replica adds to three reads it answers from its copies while the Mac is away
 * (away-reads.ts mounts them), so a session's call there answers at least what the host
 * daemon's own away answer did (offline-host-core.ts opSessionList, opSearch, walnut_status):
 *
 *   session_list   this host's sessions with the state its daemon reads now (follower.sessions),
 *                  and the title of a task made here
 *   search         the tasks made here that match the words asked, first (the search copy holds
 *                  only what the Mac indexed)
 *   walnut_status  the leader is away, what waits for it in this host's journal, and the ops
 *                  answered here (away-op-decisions.ts)
 */
import type { Overlay } from './overlay.js'
import { opsAnsweredHere } from './away-op-decisions.js'
import { hostSessionStatus } from './ask-launch.js'

type Row = Record<string, unknown> & { id: string }
type LiveSessions = ReadonlyMap<string, { state: string; lastActiveAt?: string }>

/** What walnut_status adds for this host's own call while the leader is away. */
export function awayStatus(deps: { overlay: Pick<Overlay, 'entries'>; hostKey?: string | null }): Record<string, unknown> {
  const queued = deps.overlay.entries().filter((e) => e.state === 'pending').length
  return {
    leader: 'away',
    ...(deps.hostKey ? { host: deps.hostKey } : {}),
    queuedForLeader: queued,
    answersHere: opsAnsweredHere(),
    note: 'Your Mac is away: this host\'s Walnut answers the ops in answersHere (writes are kept and reach the Mac when it is back); any other op answers needs_leader.',
  }
}

/**
 * The session list with this host's sessions as they are now: the process status the daemon reads
 * (the copy holds the Mac's last word, which may be minutes old), the newer last write, and the
 * task title of a task made here (the task copy does not hold it). A session the copy says ended
 * in an error keeps it.
 */
export function withHostSessions(body: unknown, live: LiveSessions | null, deps: { overlay: Pick<Overlay, 'taskForReaders'>; hostKey?: string | null }): unknown {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { sessions?: unknown }).sessions)) return body
  const rows = (body as { sessions: Array<Record<string, unknown>> }).sessions
  const sessions = rows.map((r) => {
    if (!r || typeof r !== 'object') return r
    let out = r
    const now = deps.hostKey && r.host === deps.hostKey && typeof r.id === 'string' ? live?.get(r.id) : undefined
    if (now && r.process_status !== 'error') {
      out = { ...out, process_status: hostSessionStatus(now.state) }
      if (now.lastActiveAt && (typeof r.last_active_at !== 'string' || now.lastActiveAt > r.last_active_at)) out.last_active_at = now.lastActiveAt
    }
    if (typeof r.task_id === 'string' && !r.task_title) {
      const made = deps.overlay.taskForReaders(r.task_id, null) as Row | null
      if (made && typeof made.title === 'string' && made.title) out = { ...out, task_title: made.title }
    }
    return out
  })
  return { ...(body as Record<string, unknown>), sessions }
}

/**
 * A search answer with the tasks made here whose title or description holds every word asked
 * (as the daemon's keyword search matched them), first, unless the answer has them already or
 * the search asked for no tasks.
 */
export function withTasksMadeHere(body: unknown, query: Record<string, unknown>, overlay: Pick<Overlay, 'createdTaskIds' | 'taskForReaders'>): unknown {
  if (!body || typeof body !== 'object' || !Array.isArray((body as { results?: unknown }).results)) return body
  const q = typeof query.q === 'string' ? query.q : ''
  const rawTypes = query.types ?? query.type
  if (typeof rawTypes === 'string' && rawTypes && !rawTypes.split(',').includes('task')) return body
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return body
  const results = (body as { results: Array<Record<string, unknown>> }).results
  // Only a task result counts: a session result of the same task (its session is in the copy) is not it.
  const have = new Set(results.filter((r) => r?.type === 'task').map((r) => r.taskId).filter((id): id is string => typeof id === 'string'))
  const made: Array<Record<string, unknown>> = []
  for (const id of overlay.createdTaskIds()) {
    if (have.has(id)) continue
    const row = overlay.taskForReaders(id, null) as Row | null
    if (!row || row.plugin_only) continue
    const title = typeof row.title === 'string' ? row.title : ''
    const description = typeof row.description === 'string' ? row.description : ''
    const text = `${title}\n${description}`.toLowerCase()
    if (!words.every((w) => text.includes(w))) continue
    const inTitle = words.every((w) => title.toLowerCase().includes(w))
    made.push({
      type: 'task', title, taskId: id, score: 1, matchField: inTitle ? 'title' : 'description',
      snippet: (inTitle ? description || title : description).slice(0, 200),
      ...(typeof row.parent_task_id === 'string' && row.parent_task_id ? { parentTaskId: row.parent_task_id } : {}),
    })
  }
  return made.length ? { ...(body as Record<string, unknown>), results: [...made, ...results] } : body
}

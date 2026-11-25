/**
 * The leader's rows of a start's task, carried with every start and resume a leader hands a host
 * (docs/plan/one-service-every-host.md, phase 2).
 *
 * A host judges a start against its own store: a task has one active session at a time
 * (sessions/one-session-per-task.ts), counted over the task's rows there. Part of what decides that
 * is the leader's to write (an engine switch's or a move's `engine_switched:` archive of the old
 * session: sessions/session-row-owner.ts), and a host's store hears of it only with the next round
 * of the `sessions` copy, seconds or minutes later. A switch or a move retires the old session and
 * starts the new one at once, so the host judged with the old word and refused it "already has its
 * active session" (2026-11-25: Claude to Antigravity on a host; that host's last sessions round was
 * 2.5 minutes before). So the start says the leader's word on those rows itself, as a resume already
 * carries the leader's row of the session it resumes, and the host takes them as a copy round would
 * (replication/kinds/sessions.ts applyLeaderSessionRows) before it judges.
 *
 *   leader  withTaskRows: to a host that names SESSION_TASK_ROWS_CAP (an older host would pass the
 *           field on to its runner), the task's rows (its own and the ones unlinked from it) the
 *           host may hold (rowsForHost: a task kept local only where a session of it runs, and then
 *           only its rows of that host, by any of its names), projected as the copy sends them, and
 *           the leader's clock when it read them
 *           (`taskRowsAt`), on the body; the start's own row is not one of them
 *   host    taskRowsOf: the rows a body carried that name its task, at most TASK_ROWS_MAX
 */
import type { SessionRecord } from '../types.js'
import { keptOffHost, type HostPrivacy } from '../replication/host-private.js'

/** The most rows a start carries (a task holds one session plus the ones its switches replaced). */
export const TASK_ROWS_MAX = 50

interface StartLike {
  taskId?: unknown
  preassignedSessionId?: unknown
  resumeSessionId?: unknown
  taskRows?: unknown
  taskRowsAt?: unknown
}

/** The ids a start names for itself: its own row is the start's, never the leader's word on the task. */
function ownIdsOf(body: StartLike): Set<string> {
  const ids = new Set<string>()
  for (const v of [body.preassignedSessionId, body.resumeSessionId]) if (typeof v === 'string' && v) ids.add(v)
  return ids
}

const namesTask = (r: Partial<SessionRecord>, taskId: string): boolean => r.taskId === taskId || r.legacyTaskId === taskId

// --- which hosts take the rows (their reports, leader-boot.ts) ---

const takers = new Set<string>()

/** A host's last report named SESSION_TASK_ROWS_CAP, or not (leader-boot.ts look). */
export function noteHostTakesTaskRows(hostKey: string, takes: boolean): void {
  if (takes) takers.add(hostKey)
  else takers.delete(hostKey)
}

export function hostTakesTaskRows(hostKey: string): boolean {
  return takers.has(hostKey)
}

/** Tests only. */
export function _resetTaskRowTakersForTesting(): void { takers.clear() }

// --- leader ---

/**
 * The rows a host may hold of them (host-private.ts). A task kept local reaches a host only where a
 * session of it runs (keptOffHost: that host's CLI and transcript are there anyway), and then only
 * its rows of that host: its sessions elsewhere (the Mac's, with their titles, summaries and folders)
 * stay off it. The start is judged by the rows of that host alone, so nothing it needs is left out.
 */
export function rowsForHost(
  rows: readonly SessionRecord[], p: HostPrivacy, ownHere: ReadonlySet<string>, onHost: (host: string | undefined) => boolean,
): SessionRecord[] {
  return rows.filter((r) => {
    const ids = [r.taskId, r.legacyTaskId]
    if (!ids.some((id) => !!id && p.tasks.has(id)) && !p.sessions.has(r.claudeSessionId)) return true
    if (ids.some((id) => keptOffHost(id, p, ownHere))) return false
    return onHost(r.host)
  })
}

/** Every name the leader reaches `hostKey`'s machine by: the key and its aliases (revoked-hosts.ts hostAliasesNow). */
export async function hostNamesOf(hostKey: string): Promise<string[]> {
  const [{ hostAliasesNow }, { normalizeHostKey }] = await Promise.all([import('./revoked-hosts.js'), import('../host-slice.js')])
  return [...new Set([hostKey, ...hostAliasesNow(hostKey).aliases].map(normalizeHostKey))]
}

/** The leader's rows of `taskId` that `hostKey` may hold, projected as the sessions copy sends them, newest first. */
export async function leaderTaskRows(taskId: string, hostKey: string, except: ReadonlySet<string> = new Set()): Promise<SessionRecord[]> {
  if (!taskId) return []
  const [{ getSessionsForTask, getSessionByClaudeId }, { getTask }, { projectSession }, { hostPrivacyNow, tasksRunningOn }, { normalizeHostKey }] = await Promise.all([
    import('../session-tracker.js'), import('../task-manager.js'), import('../replication/kinds/sessions.js'),
    import('../replication/host-private.js'), import('../host-slice.js'),
  ])
  const rows = new Map<string, SessionRecord>()
  for (const r of await getSessionsForTask(taskId)) rows.set(r.claudeSessionId, r)
  // Rows unlinked from the task (task-session-claim.ts detachTaskSession): a host's copy may still name them under it.
  const legacy = (await getTask(taskId).catch(() => null))?.legacy_session_ids ?? []
  for (const sid of legacy.slice(-TASK_ROWS_MAX)) {
    if (rows.has(sid)) continue
    const r = await getSessionByClaudeId(sid).catch(() => null)
    if (r && namesTask(r, taskId)) rows.set(sid, r)
  }
  const names = await hostNamesOf(hostKey)
  const privacy = await hostPrivacyNow()
  const ownHere = privacy.tasks.size > 0 ? await tasksRunningOn(names) : new Set<string>()
  const here = new Set(names)
  return rowsForHost([...rows.values()], privacy, ownHere, (h) => here.has(normalizeHostKey(h)))
    .filter((r) => !except.has(r.claudeSessionId))
    .sort((a, b) => (b.lastActiveAt ?? '').localeCompare(a.lastActiveAt ?? ''))
    .slice(0, TASK_ROWS_MAX)
    .map(projectSession)
}

export type TaskRowsReader = (taskId: string, hostKey: string, except: ReadonlySet<string>) => Promise<SessionRecord[]>

/**
 * `payload` with the leader's rows of its task read now (`taskRows`, `taskRowsAt`), or as it was:
 * a host that does not take them, no task, a resume of no task, none to carry, or a store that could
 * not say (the start goes as before; the copy brings them). Rows a payload already carries are read again.
 */
export async function withTaskRows<T>(payload: T, hostKey: string, o: { rowsOf?: TaskRowsReader; takes?: (hostKey: string) => boolean } = {}): Promise<T> {
  const body = payload as StartLike | null
  if (!body || typeof body !== 'object') return payload
  const { taskRows: _old, taskRowsAt: _oldAt, ...rest } = body as StartLike & Record<string, unknown>
  const bare = (body.taskRows === undefined && body.taskRowsAt === undefined ? payload : rest) as T
  if (typeof body.taskId !== 'string' || !body.taskId || !(o.takes ?? hostTakesTaskRows)(hostKey)) return bare
  const at = Date.now()
  const rows = await (o.rowsOf ?? leaderTaskRows)(body.taskId, hostKey, ownIdsOf(body)).catch(() => [] as SessionRecord[])
  return rows.length > 0 ? { ...(bare as object), taskRows: rows, taskRowsAt: at } as T : bare
}

// --- host ---

/** The rows a start body carried that the host takes, and when the leader read them (0: unknown). */
export function taskRowsOf(body: StartLike): { rows: SessionRecord[]; at: number } {
  const taskId = body.taskId
  const at = typeof body.taskRowsAt === 'number' && Number.isFinite(body.taskRowsAt) ? body.taskRowsAt : 0
  if (typeof taskId !== 'string' || !taskId || !Array.isArray(body.taskRows)) return { rows: [], at }
  const own = ownIdsOf(body)
  const out: SessionRecord[] = []
  for (const r of body.taskRows as unknown[]) {
    if (out.length >= TASK_ROWS_MAX) break
    const row = r as Partial<SessionRecord> | null
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    if (typeof row.claudeSessionId !== 'string' || !row.claudeSessionId || row.claudeSessionId.length > 200) continue
    if (own.has(row.claudeSessionId) || !namesTask(row, taskId)) continue
    out.push(row as SessionRecord)
  }
  return { rows: out, at }
}

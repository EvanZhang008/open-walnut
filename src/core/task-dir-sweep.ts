/**
 * Cleanup of task directories (src/lib/task-dir.ts), split by who knows what:
 * this server knows which tasks are done, each host's daemon knows what is in
 * its directories. Every few hours, for every connected daemon with
 * task-dir-v1 (the local one included), the server lists that host's task
 * directories, picks the ones whose task is done with them, and asks the host
 * to remove those; the host keeps any that hold unmerged work or a live
 * session (src/providers/task-dir-core.ts removeTaskDirs).
 *
 * Done with = the task completed at least the keep days ago (default 7,
 * WALNUT_TASK_DIR_KEEP_DAYS) and no session used the directory since then; or
 * the task is gone from this Walnut, the directory was made by this Walnut
 * (its marker names this data home) and nobody used it for 30 days. A reopened
 * task is not complete, so its directory stays.
 *
 * Primary only: a replica (the cloud companion) holds a copy of the tasks and
 * must not decide over host files. An ephemeral server sweeps only its own
 * local daemon, whose root sits in its temp dir.
 */
import { log } from '../logging/index.js'
import { taskDirKeepDays } from '../lib/task-dir.js'
import type { TaskDirEntry, RemoveResult } from '../providers/task-dir-core.js'

const DAY_MS = 86_400_000
const FIRST_SWEEP_MS = 15 * 60_000
const SWEEP_EVERY_MS = 6 * 60 * 60_000
const ABSENT_TASK_DAYS = 30

export interface TaskStateForSweep { id: string; phase: string; completed_at?: string; phase_changed_at?: string; updated_at?: string }

const ms = (iso: string | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}

/** The task ids whose directories may go (the host still checks each for unmerged work). */
export function pickRemovable(
  dirs: TaskDirEntry[],
  tasks: Map<string, TaskStateForSweep>,
  opts: { now: number; keepDays: number; home: string },
): string[] {
  const out: string[] = []
  for (const d of dirs) {
    const lastUsed = Math.max(ms(d.lastUsedAt), ms(d.createdAt), d.mtimeMs || 0)
    const task = tasks.get(d.taskId)
    if (task) {
      if (task.phase !== 'COMPLETE') continue
      const doneAt = ms(task.completed_at) || ms(task.phase_changed_at) || ms(task.updated_at)
      if (!doneAt) continue
      const keepMs = opts.keepDays * DAY_MS
      if (opts.now - doneAt >= keepMs && opts.now - lastUsed >= keepMs) out.push(d.taskId)
    } else if (d.home && d.home === opts.home && opts.now - lastUsed >= ABSENT_TASK_DAYS * DAY_MS) {
      out.push(d.taskId)
    }
  }
  return out
}

type SweepConn = { host: string; hasCapability?: (c: string) => boolean; send: (cmd: string, p?: Record<string, unknown>, t?: number) => Promise<unknown> }

/** One round over every connected host. Returns per-host results (tests read them). */
export async function sweepTaskDirsOnce(deps?: {
  conns?: SweepConn[]
  loadTasks?: (ids: string[]) => Promise<TaskStateForSweep[]>
  now?: number
}): Promise<Array<{ host: string } & Partial<RemoveResult>>> {
  const { WALNUT_HOME, IS_EPHEMERAL } = await import('../constants.js')
  let conns = deps?.conns
  if (!conns) {
    const { listConnectedDaemonsByHost } = await import('../providers/daemon-connection.js')
    conns = [...listConnectedDaemonsByHost().values()].map((list) => list[0]).filter(Boolean) as unknown as SweepConn[]
  }
  const loadTasks = deps?.loadTasks ?? (async (ids: string[]) => {
    const { listTasksByIds } = await import('./task-manager.js')
    return await listTasksByIds(ids) as TaskStateForSweep[]
  })
  const keepDays = taskDirKeepDays(process.env)
  const results: Array<{ host: string } & Partial<RemoveResult>> = []
  for (const conn of conns) {
    if (IS_EPHEMERAL && conn.host !== '__local__') continue
    if (!conn.hasCapability?.('task-dir-v1')) continue
    try {
      const listed = await conn.send('taskdir.list', {}) as { ok?: boolean; error?: string; dirs?: TaskDirEntry[] }
      if (listed?.ok === false) throw new Error(listed.error || 'taskdir.list refused')
      const dirs = Array.isArray(listed?.dirs) ? listed.dirs : []
      if (dirs.length === 0) continue
      const tasks = new Map((await loadTasks(dirs.map((d) => d.taskId))).map((t) => [t.id, t]))
      const removable = pickRemovable(dirs, tasks, { now: deps?.now ?? Date.now(), keepDays, home: WALNUT_HOME })
      if (removable.length === 0) continue
      // Each with the last use this list saw: the host keeps one a session used since.
      const items = removable.map((taskId) => {
        const d = dirs.find((x) => x.taskId === taskId)!
        return { taskId, usedBefore: Math.max(ms(d.lastUsedAt), ms(d.createdAt)) }
      })
      const res = await conn.send('taskdir.remove', { taskIds: items }, 120_000) as RemoveResult & { ok?: boolean; error?: string }
      if (res?.ok === false) throw new Error(res.error || 'taskdir.remove refused')
      results.push({ host: conn.host, removed: res?.removed ?? [], kept: res?.kept ?? [], missing: res?.missing ?? [] })
      log.session.info('task dirs swept', { host: conn.host, removed: res?.removed?.length ?? 0, kept: res?.kept ?? [] })
    } catch (err) {
      log.session.warn('task dir sweep failed', { host: conn.host, error: (err as Error).message })
    }
  }
  return results
}

export function startTaskDirSweep(): { stop: () => void } {
  let stopped = false
  let running = false
  const run = (): void => {
    if (stopped || running) return
    running = true
    void sweepTaskDirsOnce().catch(() => { /* next round */ }).finally(() => { running = false })
  }
  const first = setTimeout(run, FIRST_SWEEP_MS)
  first.unref?.()
  const every = setInterval(run, SWEEP_EVERY_MS)
  every.unref?.()
  return { stop: () => { stopped = true; clearTimeout(first); clearInterval(every) } }
}

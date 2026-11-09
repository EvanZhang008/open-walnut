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
 * Before that, a day after completion (WALNUT_TASK_DIR_PRUNE_DAYS, 0 = off),
 * a host with task-dir-prune-v1 prunes it: its clean, pushed clones and its
 * untracked build output go, the rest waits for the whole-directory rule
 * (task-dir-core.ts pruneTaskDirs). Once per use: a directory pruned since its
 * last use is not asked again.
 *
 * And whatever the phase, running or not, a directory loses the build output
 * nobody touched for 2 days (WALNUT_TASK_DIR_BUILD_IDLE_DAYS, 0 = off; 6 hours
 * while this machine's disk is low) on a host with task-dir-prune-builds-v1:
 * node_modules, Xcode's rebuildable folders, ignored dist, never a repo, a file
 * of its own, or what lies on the way of a live session (task-dir-core.ts
 * pruneTaskBuilds). 2026-11-08: open tasks held 70 of the 74
 * GB of task directories on the Mac, which filled to 99%, because only a
 * finished task was ever pruned. Once per use too (`buildsPrunedAt`).
 *
 * While the disk is low, an open task whose own directory is over a limit is
 * told to clear it (task-dir-size-notice.ts): run folders and data copies are
 * the task's to judge, so nothing of them is deleted here.
 *
 * Primary only: a replica (the cloud companion) holds a copy of the tasks and
 * must not decide over host files. An ephemeral server sweeps only its own
 * local daemon, whose root sits in its temp dir.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { log } from '../logging/index.js'
import { taskDirBuildIdleDays, taskDirKeepDays, taskDirLowDiskFloorBytes, taskDirPruneDays } from '../lib/task-dir.js'
import type { TaskDirEntry, RemoveResult, PruneResult } from '../providers/task-dir-core.js'

const DAY_MS = 86_400_000
const FIRST_SWEEP_MS = 15 * 60_000
const SWEEP_EVERY_MS = 6 * 60 * 60_000
const ABSENT_TASK_DAYS = 30
const LOW_DISK_CHECK_MS = 5 * 60_000
const LOW_DISK_SWEEP_MS = 60 * 60_000

export interface TaskStateForSweep { id: string; phase: string; completed_at?: string; phase_changed_at?: string; updated_at?: string; session_id?: string; org_role?: string }

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

/** The task ids whose directories may be pruned now: done a day, unused a day, not pruned since that use, not removed this round (one the removal kept for its work is pruned). */
export function pickPrunable(
  dirs: TaskDirEntry[],
  tasks: Map<string, TaskStateForSweep>,
  opts: { now: number; pruneDays: number; removed: ReadonlySet<string> },
): string[] {
  if (!(opts.pruneDays > 0)) return []
  const waitMs = opts.pruneDays * DAY_MS
  const out: string[] = []
  for (const d of dirs) {
    if (opts.removed.has(d.taskId)) continue
    const task = tasks.get(d.taskId)
    if (!task || task.phase !== 'COMPLETE') continue
    const doneAt = ms(task.completed_at) || ms(task.phase_changed_at) || ms(task.updated_at)
    const lastUsed = Math.max(ms(d.lastUsedAt), ms(d.createdAt), d.mtimeMs || 0)
    if (!doneAt || opts.now - doneAt < waitMs || opts.now - lastUsed < waitMs) continue
    if (ms(d.prunedAt) >= lastUsed) continue
    out.push(d.taskId)
  }
  return out
}

/**
 * The task ids whose build output alone the host should look at now: not
 * build-pruned since their last use, not removed or fully pruned this round.
 * Every phase counts, a running task's too (an open task rebuilds what it
 * needs); the host keeps any build folder changed within the idle time and
 * whatever lies on the way of a live session (`idleBefore`, pruneTaskBuilds).
 * A directory of a task this Walnut does not know counts only when this
 * Walnut made it.
 */
export function pickBuildPrunable(
  dirs: TaskDirEntry[],
  tasks: Map<string, TaskStateForSweep>,
  opts: { now: number; idleDays: number; home: string; skip: ReadonlySet<string> },
): string[] {
  if (!(opts.idleDays > 0)) return []
  const out: string[] = []
  for (const d of dirs) {
    if (opts.skip.has(d.taskId)) continue
    if (!tasks.has(d.taskId) && !(d.home && d.home === opts.home)) continue
    const lastUsed = Math.max(ms(d.lastUsedAt), ms(d.createdAt), d.mtimeMs || 0)
    if (ms(d.buildsPrunedAt) >= lastUsed) continue
    out.push(d.taskId)
  }
  return out
}

type SweepConn = { host: string; hasCapability?: (c: string) => boolean; send: (cmd: string, p?: Record<string, unknown>, t?: number) => Promise<unknown> }

type SweepRow = { host: string } & Partial<RemoveResult> & { pruned?: PruneResult['pruned']; buildsPruned?: PruneResult['pruned']; toldSize?: string[] }

/** True while the disk Walnut's data lives on is low (disk-watermark.ts warn or critical). */
/** This machine's disk is low: free space under the floor new work already moves away at, or the watermark says so. */
export async function localDiskLow(statfs: (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }> = (d) => fsp.statfs(d)): Promise<boolean> {
  try {
    const { getDiskWatermarkState } = await import('./disk-watermark.js')
    if (getDiskWatermarkState().level !== 'ok') return true
  } catch { /* not measured yet */ }
  try {
    const { WALNUT_HOME } = await import('../constants.js')
    const f = await statfs(WALNUT_HOME)
    return Number(f.bavail) * Number(f.bsize) < taskDirLowDiskFloorBytes(process.env)
  } catch { return false }
}

/** One round over every connected host. Returns per-host results (tests read them). */
export async function sweepTaskDirsOnce(deps?: {
  conns?: SweepConn[]
  loadTasks?: (ids: string[]) => Promise<TaskStateForSweep[]>
  now?: number
  /** This machine's disk is low: the local host's idle wait shortens (default: the disk watermark). */
  lowDisk?: boolean
  /** Delivers a size notice to a task (tests); default its session (task-dir-size-notice.ts). */
  tellTask?: (task: TaskStateForSweep, text: string, messageId: string) => Promise<void>
  noticeFile?: string
  orgOn?: boolean
}): Promise<SweepRow[]> {
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
  const lowDisk = deps?.lowDisk ?? await localDiskLow()
  const results: SweepRow[] = []
  for (const conn of conns) {
    if (IS_EPHEMERAL && conn.host !== '__local__') continue
    if (!conn.hasCapability?.('task-dir-v1')) continue
    try {
      const listed = await conn.send('taskdir.list', {}) as { ok?: boolean; error?: string; dirs?: TaskDirEntry[] }
      if (listed?.ok === false) throw new Error(listed.error || 'taskdir.list refused')
      const dirs = Array.isArray(listed?.dirs) ? listed.dirs : []
      if (dirs.length === 0) continue
      const tasks = new Map((await loadTasks(dirs.map((d) => d.taskId))).map((t) => [t.id, t]))
      const now = deps?.now ?? Date.now()
      const removable = pickRemovable(dirs, tasks, { now, keepDays, home: WALNUT_HOME })
      // Each with the last use this list saw: the host keeps one a session used since.
      const itemsFor = (ids: string[]) => ids.map((taskId) => {
        const d = dirs.find((x) => x.taskId === taskId)!
        return { taskId, usedBefore: Math.max(ms(d.lastUsedAt), ms(d.createdAt)) }
      })
      const row: SweepRow = { host: conn.host }
      const removed = new Set<string>()
      // Each step stands alone: one that fails or times out (a slow host, 2026-11-08) never skips the next.
      const step = async (name: string, fn: () => Promise<void>): Promise<void> => {
        try { await fn() } catch (err) { log.session.warn('task dir sweep failed', { host: conn.host, step: name, error: (err as Error).message }) }
      }
      const local = conn.host === '__local__'
      if (removable.length > 0) await step('remove', async () => {
        const res = await conn.send('taskdir.remove', { taskIds: itemsFor(removable) }, 120_000) as RemoveResult & { ok?: boolean; error?: string }
        if (res?.ok === false) throw new Error(res.error || 'taskdir.remove refused')
        Object.assign(row, { removed: res?.removed ?? [], kept: res?.kept ?? [], missing: res?.missing ?? [] })
        for (const id of [...(res?.removed ?? []), ...(res?.missing ?? [])]) removed.add(id)
        log.session.info('task dirs swept', { host: conn.host, removed: res?.removed?.length ?? 0, kept: res?.kept ?? [] })
      })
      // A finished task's clean clones go an hour after it completed while this machine's disk is low, else a day.
      const prunable = conn.hasCapability?.('task-dir-prune-v1')
        ? pickPrunable(dirs, tasks, { now, pruneDays: taskDirPruneDays(process.env, lowDisk && local), removed })
        : []
      if (prunable.length > 0) await step('prune', async () => {
        const res = await conn.send('taskdir.prune', { taskIds: itemsFor(prunable) }, 300_000) as PruneResult & { ok?: boolean; error?: string }
        if (res?.ok === false) throw new Error(res.error || 'taskdir.prune refused')
        row.pruned = res?.pruned ?? []
        log.session.info('task dirs pruned', { host: conn.host, pruned: row.pruned, kept: res?.kept ?? [] })
      })
      // The disk the watermark measures is this machine's, so only the local host hurries.
      const idleDays = taskDirBuildIdleDays(process.env, lowDisk && conn.host === '__local__')
      const buildPrunable = conn.hasCapability?.('task-dir-prune-builds-v1')
        ? pickBuildPrunable(dirs, tasks, { now, idleDays, home: WALNUT_HOME, skip: new Set([...removed, ...prunable]) })
        : []
      if (buildPrunable.length > 0) await step('pruneBuilds', async () => {
        // A low disk here also prunes this machine's directories in use (`live`): build output idle 6 hours
        // that no process has open, the refill that a sweep of idle directories alone never stops.
        const live = lowDisk && local
        const res = await conn.send('taskdir.pruneBuilds', { taskIds: itemsFor(buildPrunable), idleBefore: now - idleDays * DAY_MS, ...(live ? { live: true } : {}) }, 300_000) as PruneResult & { ok?: boolean; error?: string }
        if (res?.ok === false) throw new Error(res.error || 'taskdir.pruneBuilds refused')
        row.buildsPruned = (res?.pruned ?? []).filter((p) => p.builds.length > 0)
        log.session.info('task dir builds pruned', { host: conn.host, pruned: row.buildsPruned, kept: res?.kept ?? [] })
      })
      if (lowDisk && conn.host === '__local__' && conn.hasCapability?.('task-dir-sizes-v1')) {
        const { tellOversizeTasks } = await import('./task-dir-size-notice.js')
        const free = await fsp.statfs(WALNUT_HOME).then((f) => Number(f.bavail) * Number(f.bsize)).catch(() => null)
        const live = dirs.filter((d) => !removed.has(d.taskId))
        row.toldSize = await tellOversizeTasks(conn, live, tasks, {
          now, freeBytes: free, file: deps?.noticeFile ?? path.join(WALNUT_HOME, 'cache', 'task-dir-size-notices.json'),
          ...(deps?.tellTask ? { deliver: deps.tellTask } : {}),
          ...(deps?.orgOn !== undefined ? { orgOn: deps.orgOn } : {}),
        }).catch((err) => { log.session.warn('task dir size check failed', { host: conn.host, error: (err as Error).message }); return [] })
      }
      if (removable.length > 0 || prunable.length > 0 || buildPrunable.length > 0 || (row.toldSize?.length ?? 0) > 0) results.push(row)
    } catch (err) {
      log.session.warn('task dir sweep failed', { host: conn.host, error: (err as Error).message })
    }
  }
  return results
}

export function startTaskDirSweep(): { stop: () => void } {
  let stopped = false
  let running = false
  let lastRun = 0
  const run = (): void => {
    if (stopped || running) return
    running = true
    lastRun = Date.now()
    void sweepTaskDirsOnce().catch(() => { /* next round */ }).finally(() => { running = false })
  }
  const first = setTimeout(run, FIRST_SWEEP_MS)
  first.unref?.()
  const every = setInterval(run, SWEEP_EVERY_MS)
  every.unref?.()
  // A low disk does not wait out the 6 hours: one round an hour while it lasts.
  const low = setInterval(() => {
    if (Date.now() - lastRun < LOW_DISK_SWEEP_MS) return
    void localDiskLow().then((isLow) => { if (isLow) run() })
  }, LOW_DISK_CHECK_MS)
  low.unref?.()
  return { stop: () => { stopped = true; clearTimeout(first); clearInterval(every); clearInterval(low) } }
}

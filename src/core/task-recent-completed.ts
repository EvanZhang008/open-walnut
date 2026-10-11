/**
 * The recent-completed window of a task list.
 *
 * A board that hides completed rows by default still asked for every one of
 * them: on a live board of 6,578 tasks, 6,400 were completed, and each page
 * load serialized, sent and parsed a 6.8MB list for 77 rendered rows. With
 * `completedWithinDays`, `GET /api/tasks?fields=list` leaves completed tasks
 * older than the window on the server and reports how many it left out, so a
 * client that later shows the archive knows to ask for the whole list.
 *
 * Kept, whatever their age: open tasks, pinned and tiered tasks (the pinned
 * area is small and is rendered as cards, so a card must never go missing),
 * asks, and a completed task without a usable timestamp.
 *
 * Asks, because the Mac's Ask drawer lists every ask over this same store,
 * as `GET /api/v1/asks` does for the phone (sessions/ask-list.ts). Every phone
 * chat is an ask, and an old one is a completed task: the window left the
 * drawer 23 of the phone's 153 (2026-10-11), so a migrated chat could not be
 * found on the Mac at all. They cost little: 190 asks, about 25 KB gzipped.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export interface CompletedWindowTask {
  status?: string
  phase?: string
  completed_at?: string
  updated_at?: string
  pinned?: boolean
  focus_tier?: string
  walnut_agent?: boolean
  project?: string
}

export interface CompletedWindow<T> {
  tasks: T[]
  /** Completed tasks older than the window that were left out. */
  completedHidden: number
}

export function isCompletedTask(task: CompletedWindowTask): boolean {
  return task.status === 'done' || task.phase === 'COMPLETE'
}

/**
 * An ask of any agent: born one, or filed under an `Ask <name>` project (every
 * agent's project has that shape, askProjectFor). A project of the user's that
 * merely starts with "Ask " is kept too, which only loads a few more rows.
 */
function isAnyAsk(task: CompletedWindowTask): boolean {
  return task.walnut_agent === true || /^ask\s/i.test((task.project ?? '').trim())
}

/**
 * Drop completed tasks that finished more than `withinDays` days before `now`.
 * The completion time is `completed_at`, else `updated_at` (a finished task
 * was last written no earlier than it finished; the phone projection uses the
 * same rule).
 */
export function recentCompletedWindow<T extends CompletedWindowTask>(
  tasks: T[],
  withinDays: number,
  now: number = Date.now(),
): CompletedWindow<T> {
  const cutoff = now - withinDays * DAY_MS
  const kept: T[] = []
  let completedHidden = 0
  for (const task of tasks) {
    if (!isCompletedTask(task) || task.pinned || task.focus_tier || isAnyAsk(task)) {
      kept.push(task)
      continue
    }
    const doneAt = Date.parse(task.completed_at ?? task.updated_at ?? '')
    if (!Number.isFinite(doneAt) || doneAt >= cutoff) {
      kept.push(task)
      continue
    }
    completedHidden += 1
  }
  return { tasks: kept, completedHidden }
}

/** Parse the `completedWithinDays` query value; undefined means no window. */
export function parseCompletedWithinDays(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined
  const value = typeof raw === 'number' ? raw : Number(String(raw))
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('completedWithinDays must be a non-negative number of days')
  }
  return value
}

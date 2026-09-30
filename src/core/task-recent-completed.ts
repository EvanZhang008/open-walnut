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
 * and a completed task without a usable timestamp.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export interface CompletedWindowTask {
  status?: string
  phase?: string
  completed_at?: string
  updated_at?: string
  pinned?: boolean
  focus_tier?: string
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
    if (!isCompletedTask(task) || task.pinned || task.focus_tier) {
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

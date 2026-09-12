/**
 * Which failed pushes a plugin's sync tick retries this time.
 *
 * The tick used to take the first N rows of "tasks with sync_error" in table order and
 * push them again every minute. Two things were wrong with that: a handful of tasks
 * whose push can never succeed (content the remote rejects, a reference it cannot
 * resolve) occupied the whole batch forever, so every task behind them starved; and
 * each of them cost one remote call per minute for nothing.
 *
 * One instance per plugin: `pick` prunes entries for ids that are not among the
 * candidates it is handed, so an instance shared across plugins would have each plugin's
 * tick erase the others' backoff.
 *
 * This schedule is per process and in memory on purpose. It holds no truth (the truth
 * is `sync_error` on the task), it only spreads attempts out: a task that just failed
 * waits before it is tried again, doubling each time up to `maxMs`, and the batch is
 * filled with the tasks whose turn came longest ago. A restart forgets the backoff,
 * which is exactly the moment a retry is welcome (a deploy may have fixed the cause).
 */
export interface SyncRetryScheduleOptions {
  /** Wait after the first failure; doubles per consecutive failure. Default 1 minute. */
  baseMs?: number
  /** Ceiling for the wait. Default 6 hours. */
  maxMs?: number
}

interface RetryEntry {
  attempts: number
  nextAt: number
}

export class SyncRetrySchedule {
  private readonly entries = new Map<string, RetryEntry>()
  private readonly baseMs: number
  private readonly maxMs: number

  constructor(options: SyncRetryScheduleOptions = {}) {
    this.baseMs = Math.max(1, options.baseMs ?? 60_000)
    this.maxMs = Math.max(this.baseMs, options.maxMs ?? 6 * 60 * 60_000)
  }

  /**
   * The tasks to retry now: those whose wait has elapsed (never-tried tasks first,
   * then the ones due longest ago), at most `limit`. Entries for ids no longer among
   * the candidates are dropped, so a task whose error cleared by other means (the user
   * edited it and that push succeeded) does not keep a stale row here.
   */
  pick<T extends { id: string }>(candidates: readonly T[], limit: number, now = Date.now()): T[] {
    const live = new Set(candidates.map((c) => c.id))
    for (const id of this.entries.keys()) if (!live.has(id)) this.entries.delete(id)
    return candidates
      .filter((c) => (this.entries.get(c.id)?.nextAt ?? 0) <= now)
      .sort((a, b) => (this.entries.get(a.id)?.nextAt ?? 0) - (this.entries.get(b.id)?.nextAt ?? 0))
      .slice(0, Math.max(0, limit))
  }

  noteFailure(id: string, now = Date.now()): void {
    const attempts = (this.entries.get(id)?.attempts ?? 0) + 1
    const wait = Math.min(this.maxMs, this.baseMs * 2 ** (attempts - 1))
    this.entries.set(id, { attempts, nextAt: now + wait })
  }

  noteSuccess(id: string): void {
    this.entries.delete(id)
  }

  /** How many consecutive failures this process has seen for `id` (diagnostics/tests). */
  attemptsOf(id: string): number {
    return this.entries.get(id)?.attempts ?? 0
  }

  /**
   * The ids currently carrying a backoff entry.
   *
   * Read BEFORE `pick` (which prunes the ones that left the candidate set) to notice a
   * task that stopped being a candidate: its operation succeeded by another route, and
   * whoever told the user about the failures needs that to close the story.
   */
  trackedIds(): string[] {
    return [...this.entries.keys()]
  }
}

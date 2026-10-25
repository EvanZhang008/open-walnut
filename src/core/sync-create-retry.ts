/**
 * Step 1 of a plugin's sync tick: creating the remote twin of a task that has none yet.
 *
 * The loop used to call `createTask` for EVERY unsynced task on EVERY tick (~30s) with no
 * backoff, and said nothing beyond one warn per attempt. A task the remote will never
 * accept (a title it rejects outright, a project it cannot resolve) therefore cost a
 * network call and two log lines a minute forever, and the person who owned that task
 * never learned why it stayed local.
 *
 * Same shape as Step 1.5 (`SyncRetrySchedule`): pick a small batch, space repeat failures
 * out with exponential backoff, and after a short streak turn the failure into ONE
 * notification a person can act on (log.error is bridged into the notification centre, see
 * src/core/notifications/log-error-bridge.ts). Never-tried tasks are always due, so a
 * brand new task still gets its create on the first tick after it was added.
 *
 * The schedule instance belongs to the caller (one per plugin, kept across ticks): `pick`
 * prunes ids that are not among the candidates it is handed, so a shared instance would
 * have each plugin's tick erase the others' backoff. Creates and pushes need SEPARATE
 * instances too, because they schedule different rows (no remote twin yet vs. a twin whose
 * later edit failed).
 */
import type { SyncRetrySchedule } from './sync-retry-schedule.js'

/** How many creates one tick may attempt. Matches Step 1.5's batch size. */
export const MAX_CREATE_RETRIES_PER_CYCLE = 5

/**
 * Consecutive failures before the error reaches the human as a notification card.
 * Below this the failure is a warn in the log: the first two attempts are routinely a
 * token refresh or a network blip, and a card for those is the noise this file avoids.
 */
export const CREATE_ATTEMPTS_BEFORE_NOTICE = 3

/**
 * The FIXED text of that error. The log-error bridge fingerprints the message plus the
 * stable meta (pluginId, taskId, error), so this string must not interpolate anything:
 * the varying parts ride in the meta, which is what folds a repeat into one card instead
 * of a new one per attempt.
 */
export const CREATE_REFUSED_MESSAGE = 'sync: the tracker keeps refusing to create a task'

/**
 * The condition ONE task's create belongs to, so the card retires when that create
 * finally lands. Deliberately narrower than the plugin-wide `plugin:<id>` key the bridge
 * would derive on its own: a create refusal survives a healthy sync tick (the tick catches
 * these failures and carries on), so the plugin's own recovery signal would retire a card
 * whose cause is still there.
 */
export function createRecoveryKey(pluginId: string, taskId: string): string {
  return `plugin:${pluginId}:create:${taskId}`
}

/**
 * Tasks whose create card an EARLIER process wrote and no recovery has retired yet, per
 * plugin. The schedule is per process, so after a restart it holds no streak for them, and
 * both of the loop's retirements below read the streak: a create that landed after the
 * restart (or while the server was down) retired nothing, and the card sat red for days
 * over a task that was long since in the tracker (three such cards, 2026-10-17 to 10-23).
 * Seeded at boot from the notification store, like every other recovery tracker.
 */
const cardedCreates = new Map<string, Set<string>>()

const CREATE_KEY_RE = /^plugin:([^:]+):create:(.+)$/

/** Seed from the unresolved cards' recovery keys; returns how many create cards it took. */
export function seedCardedCreates(keys: readonly string[]): number {
  let n = 0
  for (const key of keys) {
    const m = CREATE_KEY_RE.exec(key)
    if (!m) continue
    cardedCreatesOf(m[1]).add(m[2])
    n++
  }
  return n
}

/** The live set for one plugin (the loop deletes the ids it retires). */
export function cardedCreatesOf(pluginId: string): Set<string> {
  let set = cardedCreates.get(pluginId)
  if (!set) cardedCreates.set(pluginId, (set = new Set()))
  return set
}

/** The little a create needs from a task: an id to schedule by, a title for the card. */
export interface UnsyncedCreateTask {
  id: string
  title?: string
  ext?: Record<string, unknown>
}

/** The subset of a subsystem logger this loop uses. */
export interface CreateRetryLogger {
  info(message: string, meta?: Record<string, unknown>): void
  warn(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

export interface RetryUnsyncedCreatesOptions<T extends UnsyncedCreateTask> {
  pluginId: string
  /** Everything still missing a remote twin (listUnsyncedTasks). */
  unsynced: readonly T[]
  /** Per-plugin, kept across ticks by the caller. */
  schedule: SyncRetrySchedule
  /** The plugin's create call. Resolving to null/undefined means "no twin was made". */
  createTask: (task: T) => Promise<Record<string, unknown> | null | undefined>
  log: CreateRetryLogger
  /** Awaited every `yieldEvery` creates so HTTP/WS handlers don't starve. */
  onYield?: () => Promise<void>
  yieldEvery?: number
  limit?: number
  /** Retires the notification card for a task whose create finally succeeded. */
  publishRecovery?: (keys: string[]) => void
  /** Tasks holding a card from an earlier process (cardedCreatesOf); retired ids are removed. */
  carded?: Set<string>
}

export interface RetryUnsyncedCreatesResult {
  /** How many creates this tick actually attempted (the batch, not the backlog). */
  attempted: number
  succeeded: number
  failed: number
  /** Tasks the remote created a twin for, ready for ONE bulk DB write by the caller. */
  extUpdates: Array<{ id: string; patch: { ext: Record<string, unknown> } }>
}

/**
 * Attempt the due creates for one plugin. The caller owns the DB write and the bus
 * events; this function owns the network calls, the backoff and the human-facing error.
 */
export async function retryUnsyncedCreates<T extends UnsyncedCreateTask>(
  options: RetryUnsyncedCreatesOptions<T>,
): Promise<RetryUnsyncedCreatesResult> {
  const { pluginId, unsynced, schedule, createTask, log } = options
  const limit = options.limit ?? MAX_CREATE_RETRIES_PER_CYCLE
  const yieldEvery = Math.max(1, options.yieldEvery ?? 5)
  // A create can also land WITHOUT this loop: the likeliest end to a refusal is the user
  // reading the card, fixing the title, and the edit path (autoPushIfConfigured →
  // createTask) creating the twin. The task then simply stops being unsynced, so the only
  // trace is its entry here. Retire its card before `pick` prunes that entry, or the rail
  // stays red after the very fix the card asked for. A deleted task takes the same exit:
  // its condition can never be observed again either.
  const live = new Set(unsynced.map((t) => t.id))
  const carded = options.carded
  for (const id of new Set([...schedule.trackedIds(), ...(carded ?? [])])) {
    if (live.has(id)) continue
    if (!carded?.has(id) && schedule.attemptsOf(id) < CREATE_ATTEMPTS_BEFORE_NOTICE) continue
    log.info('sync: refused create left the queue', { pluginId, taskId: id })
    options.publishRecovery?.([createRecoveryKey(pluginId, id)])
    carded?.delete(id)
  }

  const batch = schedule.pick(unsynced, limit)

  if (unsynced.length > 0) {
    log.info('sync: unsynced tasks pending create', {
      pluginId,
      count: unsynced.length,
      // The batch, not the backlog: the difference between the two is how many rows are
      // sitting in backoff, which is the number to look at when creates stop happening.
      attempting: batch.length,
      sampleTaskIds: batch.slice(0, 5).map((t) => t.id),
    })
  }

  const extUpdates: RetryUnsyncedCreatesResult['extUpdates'] = []
  let succeeded = 0
  let failed = 0
  let counter = 0

  for (const task of batch) {
    // Yield periodically so HTTP/WS handlers don't starve while we await serial
    // remote calls (each ~500ms).
    if (counter > 0 && counter % yieldEvery === 0 && options.onYield) await options.onYield()
    counter++
    // Read BEFORE the attempt: noteSuccess clears the entry, so the streak that a
    // recovery has to answer for is only knowable here.
    const attemptsBefore = schedule.attemptsOf(task.id)
    try {
      const ext = await createTask(task)
      if (ext) {
        // ext is already scoped by the plugin: { 'ms-todo': { id, list_id } }, so spread to merge
        const mergedExt = { ...task.ext, ...(ext as Record<string, unknown>) }
        extUpdates.push({ id: task.id, patch: { ext: mergedExt } })
        Object.assign(task, { ext: mergedExt })
        schedule.noteSuccess(task.id)
        succeeded++
        if (attemptsBefore >= CREATE_ATTEMPTS_BEFORE_NOTICE || carded?.has(task.id)) {
          log.info('sync: create succeeded after repeated refusals', {
            pluginId, taskId: task.id, attempts: attemptsBefore,
          })
          // Only when a card can exist: publishRecovery reads the notification store,
          // and a create that never failed has nothing to retire.
          options.publishRecovery?.([createRecoveryKey(pluginId, task.id)])
          carded?.delete(task.id)
        }
        continue
      }
      // The plugin answered "no twin" without throwing (a task it declines to mirror).
      // Nothing failed, but nothing was created either, so it must back off exactly like
      // a refusal or it is retried every tick forever. No card: the plugin did not
      // report a problem, and a decision it made on purpose is not an error.
      schedule.noteFailure(task.id)
      log.warn(`${pluginId} sync: unsynced retry create returned no remote task`, {
        taskId: task.id, title: task.title, attempts: schedule.attemptsOf(task.id),
      })
    } catch (err) {
      failed++
      schedule.noteFailure(task.id)
      const attempts = schedule.attemptsOf(task.id)
      const error = err instanceof Error ? err.message : String(err)
      // Kept per attempt (the ghost-producing repro reads these), but the schedule
      // means it is now a handful of lines with growing gaps, not two a minute.
      log.warn(`${pluginId} sync: unsynced retry create failed`, {
        taskId: task.id, title: task.title, error, attempts,
      })
      // ONE card per streak: the attempt that reaches the threshold publishes, the
      // ones after it stay in the log. `attempts` only ever grows by one per failure
      // and a success resets it to zero, so the equality is the whole guard: no
      // second bookkeeping map that would have to be pruned.
      if (attempts === CREATE_ATTEMPTS_BEFORE_NOTICE) {
        log.error(CREATE_REFUSED_MESSAGE, {
          pluginId,
          taskId: task.id,
          title: task.title,
          error,
          attempts,
          recoveryKey: createRecoveryKey(pluginId, task.id),
        })
      }
    }
  }

  if (unsynced.length > 0) {
    log.info('sync: unsynced batch done', {
      pluginId, attempted: batch.length, succeeded, failed, backlog: unsynced.length,
    })
  }

  return { attempted: batch.length, succeeded, failed, extUpdates }
}

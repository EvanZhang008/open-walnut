/**
 * A task change that could not reach its sync plugin's remote store.
 *
 * Typed so the HTTP error funnels (task-v1.ts, api-v1.ts) can tell it from an
 * ordinary 500 and log it with the plugin named in meta. That one field is what
 * gives the error card a lifecycle: the log bridge keys a `pluginId` record to
 * `plugin:<id>`, and the sync loop's next good tick publishes recovery for that
 * key, so the card retires by itself. Before this the funnels logged a bare
 * `{error}` under the core `web` subsystem: no key, so the card sat red for 48h
 * after the user had signed in again (2026-10-28), and the two funnels' different
 * titles made the same throw two cards.
 *
 * The message keeps the historical wording (`Sync to <source> failed: <why>`):
 * API clients and tests read it.
 */
export class TaskSyncError extends Error {
  readonly code = 'task_sync_failed'
  constructor(readonly pluginId: string, readonly reason?: string) {
    super(`Sync to ${pluginId} failed: ${reason ?? 'unknown error'}`)
    this.name = 'TaskSyncError'
  }
}

export function isTaskSyncError(err: unknown): err is TaskSyncError {
  return !!err && typeof err === 'object'
    && (err as { code?: unknown }).code === 'task_sync_failed'
    && typeof (err as { pluginId?: unknown }).pluginId === 'string'
}

/** The log title the push's catch site writes, so every entry point is one card. */
export const TASK_SYNC_PUSH_FAILED_LOG = 'task sync push failed'

/**
 * The push card's OWN condition, one step below the plugin's `plugin:<id>`.
 * A push that succeeds again retires this key alone: the plugin-wide key also
 * holds the "needs you to sign in again" card, which a push can succeed past (the
 * access token has an hour left while the refresh token is dead) and must not
 * retire. The sync loop's pull recovery publishes both.
 */
export function taskSyncPushRecoveryKey(pluginId: string): string {
  return `plugin:${pluginId}:push`
}

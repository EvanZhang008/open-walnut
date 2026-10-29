/**
 * The one log line a router's error funnel writes for an unexpected throw.
 *
 * A task change whose sync push failed (TaskSyncError) was already carded at the
 * source (task-manager.ts logs `task sync push failed` with the plugin named, so
 * the card is keyed `plugin:<id>` and retires when that plugin syncs again). The
 * funnel must not card it a second time: it logs at warn, and marks the 500 as a
 * handled failure so the request logger does not mint a `route:` card either
 * (2026-10-28: one expired sign-in showed as two "Api-v1 … error" cards plus an
 * "endpoint failing" card, all red for 48h after the user had signed in again).
 * Everything else keeps the funnel's own title at error.
 */
import type { Response } from 'express'
import { log } from '../../logging/index.js'
import { isTaskSyncError } from '../../core/task-sync-error.js'
import { markHandledFailure } from '../middleware/handled-failure.js'

export function logRouteError(err: unknown, fallbackTitle: string, res?: Response): void {
  const message = err instanceof Error ? err.message : String(err)
  if (isTaskSyncError(err)) {
    if (res && !res.headersSent) markHandledFailure(res)
    log.web.warn(`${fallbackTitle}: task sync push failed`, { pluginId: err.pluginId, error: message })
    return
  }
  log.web.error(fallbackTitle, { error: message })
}

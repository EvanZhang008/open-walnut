/**
 * Plugins whose code on disk moved past what this process runs.
 *
 * A git or npm source update replaces the files of plugins that are ALREADY loaded, and
 * legacy plugin code cannot be swapped live: only a restart runs the new version. Until
 * then the registry still says `active` about the old code, which is a confident wrong
 * answer. This set is the one place that remembers the gap, so the store row (and the
 * Sources card) can read RESTART TO ACTIVATE instead of ON. It is process memory on
 * purpose: the restart that fixes the gap also empties it.
 */

const pending = new Set<string>()

/**
 * A plugin's code can only change with a process restart (a native addon, a link out of
 * its folder): a reload refuses before touching it. Not a version that failed to load, so
 * an update keeps the new files and the plugin waits for the restart (source-update-run.ts).
 */
export class PluginRestartRequiredError extends Error {
  readonly code = 'restart_required'
}

export function isRestartRequiredError(error: unknown): boolean {
  return error instanceof PluginRestartRequiredError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'restart_required')
}

/** The lifecycle state the registry reports for a marked plugin; `storeStatusFor` maps it to `pending-restart`. */
export const RESTART_PENDING_STATE = 'stale-after-update'

export function markRestartPending(ids: Iterable<string>): void {
  for (const id of ids) if (id) pending.add(id)
}

export function isRestartPending(id: string): boolean {
  return pending.has(id)
}

/** A reload or a disable replaced the in-memory version, so the gap this set remembers is closed. */
export function clearRestartPending(id: string): void {
  pending.delete(id)
}

export function restartPendingIds(): string[] {
  return [...pending]
}

/** Tests only. */
export function clearRestartPendingForTesting(): void {
  pending.clear()
}

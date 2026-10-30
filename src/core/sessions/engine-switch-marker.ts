/**
 * The mark an engine switch leaves on a task's earlier session (engine-switch.ts).
 *
 * A task holds several sessions over its life, ONE active at a time
 * (one-session-per-task.ts). Switching engines ends the active session and
 * starts a new one on the other engine; the earlier session keeps its task link
 * (search, cost and reply routing read `taskId`) and is archived with an
 * `archive_reason` of `engine_switched:<new engine>`. That prefix is what every
 * "the task's session" guard skips, exactly as it skips the ACP identity
 * redirect. Pure: no imports, so the store's SQL and every reader agree.
 */

export const ENGINE_SWITCHED_PREFIX = 'engine_switched:';

export interface SupersedableRecord {
  archived?: boolean;
  archive_reason?: string;
}

/** The session an engine switch replaced: history of its task, never its active session. */
export function isSupersededSession(record: SupersedableRecord | null | undefined): boolean {
  return !!record?.archive_reason?.startsWith(ENGINE_SWITCHED_PREFIX);
}

export function engineSwitchedReason(toEngine: string): string {
  return `${ENGINE_SWITCHED_PREFIX}${toEngine || 'claude'}`;
}

/** The engine a superseded session was switched to, or undefined. */
export function switchedToEngine(record: SupersedableRecord | null | undefined): string | undefined {
  return isSupersededSession(record) ? record!.archive_reason!.slice(ENGINE_SWITCHED_PREFIX.length) || undefined : undefined;
}

/**
 * A task's `user_status` is DERIVED by the server (src/core/user-status-sync.ts): the dot, the
 * status pill and every Needs you count read it, and no optimistic write of a phase or a thread
 * set it, so a click showed on the control at once and on every badge only after the server's
 * next pass (2026-11-19: a thread acted on in the Org page kept its node's red dot 20 to 35 s).
 *
 * A prediction is this page's answer for that field until the server's own arrives. It is not
 * a held edit (task-list-merge.ts LocalEdit): a held edit wins over the server until its write
 * is answered, and here the server is the authority the moment it speaks. The rule:
 *
 *   - `base` is the status the server last gave, as text. A server row that still carries it
 *     has not been derived again, so the prediction stays over it.
 *   - a server row carrying anything else IS the answer: the prediction is dropped and never
 *     comes back, whether the answer agrees with it or not.
 *   - no answer within PREDICTION_MS: the caller reads the row again (the prediction was wrong,
 *     or the status truly did not move).
 */
import type { Task } from '@open-walnut/core';
import { fallbackUserState, type UserStatus } from '@open-walnut/user-status';
import { threadCounts } from '@open-walnut/thread-view';

export const PREDICTION_MS = 10_000;

export interface StatusPrediction {
  /** The server's status when the prediction was made (statusKey). */
  base: string;
  predicted: UserStatus | undefined;
}

export const statusKey = (s: UserStatus | null | undefined): string => JSON.stringify(s ?? null);

/**
 * A row from the server (an event, a list answer) as this page draws it: the row itself once
 * the server has derived the status again (`answered`: drop the prediction), else the row with
 * the prediction laid over its status.
 */
export function overPrediction(task: Task, predictions: ReadonlyMap<string, StatusPrediction>): { task: Task; answered: boolean } {
  const p = predictions.get(task.id);
  if (!p) return { task, answered: false };
  if (statusKey(task.user_status) !== p.base) return { task, answered: true };
  return { task: { ...task, user_status: p.predicted } as Task, answered: false };
}

/**
 * The status a phase set by hand reads as before the server derives it, by the server's own
 * rules (src/core/user-status.ts derive), keeping the node's Threads counts:
 *   - a turn running now reads Working whatever the phase, so a hand's phase moves nothing;
 *   - Working is a running turn only, so In progress set by hand reads Waiting (a phase starts
 *     no turn; predicting Working put the row under Working until the server's answer moved it
 *     back a moment later);
 *   - Not started or In progress with no session is Waiting of kind `not-started`.
 * The row itself when it would read the same: nothing to predict.
 */
export function predictedForPhase(row: Pick<Task, 'phase' | 'status' | 'user_status' | 'session_id' | 'session_status' | 'org_role'>, phase: string): UserStatus | undefined {
  if (phase === 'COMPLETE' || row.phase === phase) return row.user_status;
  const live = row.session_status;
  // Where the server's answer does not follow the phase, nothing is predicted (a wrong
  // prediction is a row that jumps and jumps back): a turn running or a prompt waiting, a
  // snoozed row, and Main or a lead, whose status is its Threads and its team.
  if (live?.process_status === 'running' || live?.pendingPermissionTool) return row.user_status;
  if (row.user_status?.snoozed || row.org_role) return row.user_status;
  const fallback = fallbackUserState(phase);
  const state = fallback === 'working' ? 'waiting' : fallback;
  const notStarted = state === 'waiting' && (phase === 'TODO' || phase === 'IN_PROGRESS') && !row.session_id;
  const was = row.user_status;
  if (was && was.state === state && !was.toRead && !was.snoozed && (was.kind === 'not-started') === notStarted) return was;
  return { state, ...(notStarted ? { kind: 'not-started' } : {}), ...(was?.threads ? { threads: was.threads } : {}) } as UserStatus;
}

/**
 * The node's status with the counts of the list as drawn: what the server will derive for
 * `user_status.threads` (the same threadCounts, src/core/user-status-sync.ts readNodeThreads),
 * so the node's row, its dot and its number move with the card and not a pass later.
 */
export function statusWithThreads(status: UserStatus | undefined, list: Parameters<typeof threadCounts>[0], counted = !!status?.threads): UserStatus | undefined {
  // Only a status the server counts Threads into is predicted (an Org node's); `counted` says so
  // for a status whose counts a prediction already took away (none left).
  if (!status || !counted) return status;
  const counts = threadCounts(list);
  const { threads: _was, ...rest } = status;
  return (counts.shown > 0 ? { ...rest, threads: counts } : rest) as UserStatus;
}

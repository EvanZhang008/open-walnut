/**
 * The session header's phase write when no shared task store carries the task
 * (TaskQuickActions.tsx, docs/plan/walnut-replica-servers-impl.md section 3,
 * "Op ids"). Every attempt of one pick carries one op id (withWriteRetry), at a
 * flat 2 s apart (5 retries, about 10 s before the header puts the server's copy
 * back, as before op ids). A newer pick for the same task drops the older one's
 * pending retries, so an older phase never lands after a newer one. An answer
 * that says the write may have been kept (504 sent:true, 503 leader_unsure why
 * lost_answer, journal_unwritable) is not retried and is shown, as its message
 * asks.
 */
import type { Task } from '@open-walnut/core';
import { updateTask, type UpdateTaskInput, type WriteOpts } from '@/api/tasks';
import { withWriteRetry, writeRetryable, WriteSuperseded } from '@/api/write-retry';

export const PHASE_WRITE_RETRIES = 5;
export const PHASE_WRITE_DELAY_MS = 2_000;

export interface PhaseWriteHooks {
  /** The server took the pick. */
  done(): void;
  /** The pick failed and no newer pick owns the header: put the server's copy back. */
  resync(): void;
  /** A failure that is not retried (it may have been kept, or the server refused it): its message. */
  showError?(message: string): void;
}

type Update = (id: string, updates: UpdateTaskInput, opts?: WriteOpts) => Promise<Task>;

/** One writer per header: it remembers the latest pick per task. */
export function createPhaseWriter(update: Update = updateTask, delayMs = PHASE_WRITE_DELAY_MS) {
  const generation = new Map<string, number>();
  return function writePhase(id: string, phase: string, hooks: PhaseWriteHooks): Promise<void> {
    const gen = (generation.get(id) ?? 0) + 1;
    generation.set(id, gen);
    const superseded = () => generation.get(id) !== gen;
    return withWriteRetry(
      (opId) => update(id, { phase }, { opId }),
      PHASE_WRITE_RETRIES,
      () => delayMs,
      superseded,
    ).then(() => { hooks.done(); }, (err: unknown) => {
      if (err instanceof WriteSuperseded) return;
      if (!writeRetryable(err)) hooks.showError?.(err instanceof Error ? err.message : String(err));
      if (!superseded()) hooks.resync();
    });
  };
}

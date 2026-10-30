/**
 * A trigger that watches a task's ask of the user, or one of its letters, stands in for the
 * 4-hour re-check of it (needs-recheck.ts, letter-recheck.ts).
 *
 * 2026-10-29: a lead armed a 15-minute trigger on its letter and told the user he would not be
 * asked every 4 hours again; the re-check still woke it three more times, and each time it wrote
 * the same status in the chat the user reads. A session arming such a trigger says what it watches
 * (trigger_create `watches`: "ask", or a letter id), recorded on the task; while that trigger is
 * live (it exists, is enabled, and Walnut did not stop it for failing checks) the re-check of that
 * ask or letter is skipped. A watch whose trigger is gone, paused or stopped counts for nothing,
 * so the re-check comes back by itself.
 */
import type { Task } from '../types.js';

export interface RecheckWatch {
  /** The trigger (routine id). */
  trigger: string;
  /** "ask" = the task's own ask of the user, whatever its words; else a letter id. */
  watches: string;
  /** When it was recorded (ISO). */
  at: string;
}

/** The ids of the triggers polling now ("armed": present and enabled; a stopped one is disabled). */
export async function liveTriggerIds(): Promise<Set<string>> {
  const { listRoutines } = await import('../routines/routines-core.js');
  const { triggerRunState } = await import('../cron/trigger-run-state.js');
  const { jobs } = await listRoutines(true);
  const out = new Set<string>();
  for (const job of jobs as { id?: string; enabled?: boolean; state?: { pausedAtMs?: number; consecutiveErrors?: number } }[]) {
    if (job.id && triggerRunState(job) === 'armed') out.add(job.id);
  }
  return out;
}

/** Whether a live trigger of `task` watches `what` ("ask" or a letter id). Pure. */
export function watchedBy(task: Pick<Task, 'recheck_watch'>, what: string, live: ReadonlySet<string>): RecheckWatch | undefined {
  return (task.recheck_watch ?? []).find((w) => w.watches === what && live.has(w.trigger));
}

/** The record after a trigger was armed to watch `what`; drops entries whose trigger is gone. Pure. */
export function withWatch(current: readonly RecheckWatch[] | null | undefined, add: RecheckWatch, live?: ReadonlySet<string>): RecheckWatch[] {
  const kept = (current ?? []).filter((w) => w.trigger !== add.trigger && (!live || live.has(w.trigger)));
  return [...kept, add].slice(-20);
}

/** What `watches` may name: "ask", or a letter id. */
export function validWatch(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (v === 'ask') return v;
  return /^lt-[a-z0-9-]{4,60}$/i.test(v) ? v : null;
}

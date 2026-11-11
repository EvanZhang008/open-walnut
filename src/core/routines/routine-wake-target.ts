/**
 * Which routines wake the task their config names, for a task's status ("waiting on a watch" versus
 * "it stopped, and nothing will wake it"). 2026-11-11: the router's wake (executor `router`) was not
 * counted, so a running router with its 5-minute check armed read "nothing will wake it" on every
 * surface. Every executor kind is listed here, so a new one has to say whether it wakes its target
 * (tests/core/routines/routine-wake-target.test.ts reads the kinds from the source).
 */
import type { CronJob } from '../cron/types.js';

export const EXECUTOR_WAKES_TASK: Readonly<Record<string, boolean>> = {
  /** A trigger or schedule delivered into the target task's session. */
  session: true,
  /** An area router's wake: hands the router its area's waiting items. */
  router: true,
  'main-agent': false,
  'walnut-agent': false,
  'claude-code': false,
  watcher: false,
};

export function wakesTask(job: Pick<CronJob, 'executor'>): boolean {
  const type = job.executor?.type;
  return typeof type === 'string' && EXECUTOR_WAKES_TASK[type] === true;
}

/** The words a status uses for this wake ("A watch: <words>"). */
export function wakeWordsOf(job: Pick<CronJob, 'executor' | 'name'>): string {
  return job.executor?.type === 'router' ? 'new items in its area' : job.name;
}

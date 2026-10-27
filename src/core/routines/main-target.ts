/**
 * A routine aimed at "main" goes to the CURRENT Main task's conversation.
 *
 * `sessionTarget: 'main'` (the "Home Chat" executor, and a job's `announce`)
 * used to run a turn on the Personal AI's general chat lane: one taskless
 * session bound to that chat's conversation id. The org's Main is a task now
 * (org_role 'main'), and that lane session stayed behind with no task.
 * 2026-10-27: "Main daily reflection", which Main had made for itself, ran in
 * the old lane session 87fc68ba (no task, no longer Main) as well as in Main;
 * two earlier one-off routines had run only there.
 *
 * The target is resolved at every run, never remembered: the Main task the org
 * has now (made on first use, the same as the Org page does), delivered the way
 * every task-targeted routine is (executors/session.ts: its live session, its
 * stopped one cold-resumed, else a new session on the task). A session with no
 * task never receives a routine.
 */

import type { CronJob } from '../cron/types.js';
import type { ExecutorRunResult } from './types.js';

let sessionExecutor: import('./types.js').ExecutorDefinition | null = null;

async function executor(): Promise<import('./types.js').ExecutorDefinition> {
  if (!sessionExecutor) {
    const { createSessionExecutor } = await import('./executors/session.js');
    sessionExecutor = createSessionExecutor();
  }
  return sessionExecutor;
}

export interface MainTargetDeps {
  mainTaskId(): Promise<string>;
  deliver(job: CronJob, taskId: string, text: string): Promise<ExecutorRunResult>;
}

const defaultDeps: MainTargetDeps = {
  async mainTaskId() {
    const { ensureMainTask } = await import('../org/org-store.js');
    return (await ensureMainTask()).id;
  },
  async deliver(job, taskId, text) {
    return await (await executor()).run(job, { type: 'session', config: { target: taskId, prompt: text, instructions: text } }, text);
  },
};

/** Deliver a "main" routine's text into the Main task's conversation. */
export async function deliverToMainAgent(
  text: string,
  job: Pick<CronJob, 'id' | 'name'> & Partial<CronJob>,
  deps: MainTargetDeps = defaultDeps,
): Promise<ExecutorRunResult & { taskId: string }> {
  const taskId = await deps.mainTaskId();
  // The run is the routine's, not a check's: no host hint rides along.
  const asJob = { ...job, check: undefined, state: { ...(job.state ?? {}), clockHost: undefined } } as CronJob;
  const res = await deps.deliver(asJob, taskId, text);
  return { ...res, taskId };
}

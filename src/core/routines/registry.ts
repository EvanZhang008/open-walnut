/**
 * Executor registry — routines layer.
 *
 * Executors are registered at server startup (src/web/server.ts) with their
 * runtime dependencies closed over. The registry powers:
 *   - job dispatch (CronServiceDeps.runExecutor),
 *   - config validation (normalize/REST create/update),
 *   - the dynamic executor section of the routine form (GET /api/routines/executors).
 */

import type { CronJob, RoutineExecutorRef, ExecutorRunResult } from '../cron/types.js';
import type { ExecutorDefinition } from './types.js';

const executors = new Map<string, ExecutorDefinition>();

export function registerExecutor(def: ExecutorDefinition): void {
  executors.set(def.type, def);
}

export function getExecutor(type: string): ExecutorDefinition | undefined {
  return executors.get(type);
}

export function listExecutors(): ExecutorDefinition[] {
  return [...executors.values()];
}

/** For tests — reset the registry between cases. */
export function clearExecutors(): void {
  executors.clear();
}

/**
 * Dispatch a job to its executor. This is what gets injected as
 * CronServiceDeps.runExecutor.
 */
export async function runExecutor(
  job: CronJob,
  executor: RoutineExecutorRef,
  message: string,
): Promise<ExecutorRunResult> {
  const def = executors.get(executor.type);
  if (!def) {
    return { status: 'error', error: `unknown executor type: ${executor.type}` };
  }
  const validated = def.validate(executor.config ?? {});
  if (!validated.ok) {
    return { status: 'error', error: `invalid ${executor.type} config: ${validated.error}` };
  }
  try {
    return await def.run(job, { type: executor.type, config: validated.config }, message);
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

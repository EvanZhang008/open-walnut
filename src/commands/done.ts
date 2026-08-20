import chalk from 'chalk';
import { outputJson } from '../utils/json-output.js';
import { apiPost, reportApiError } from '../utils/api-client.js';
import { taskRefTag } from '../utils/entity-refs.js';
import { requireDirectRunners } from './direct-registry.js';
import type { GlobalOptions } from '../core/types.js';

export interface CompletedTask {
  id: string;
  title: string;
  [key: string]: unknown;
}

/**
 * `open-walnut done <id>` — id may be a unique prefix (resolved server-side).
 *
 * Uses POST /api/v1/tasks/:id/complete, NOT PATCH { status: 'done' }: only
 * completeTask() auto-unpins the task from the Focus bar and surfaces an
 * external-sync push failure to the caller. See the endpoint's comment in
 * src/web/routes/task-v1.ts.
 */
export async function runDone(
  id: string,
  globals: GlobalOptions,
): Promise<void> {
  if (process.env.WALNUT_CLI_DIRECT === '1') {
    // In-process legacy path, installed only by the full CLI entry — see
    // direct-registry.ts.
    await requireDirectRunners().done(id, globals);
    return;
  }

  try {
    const { task } = await apiPost<{ task: CompletedTask }>(
      `/api/v1/tasks/${encodeURIComponent(id)}/complete`,
    );
    printCompleted(task, globals);
  } catch (err) {
    reportApiError(err, globals);
  }
}

export function printCompleted(task: CompletedTask, globals: GlobalOptions): void {
  const ref = taskRefTag(task.id, task.title);
  if (globals.json) {
    outputJson({ id: task.id, status: 'completed', task, ref });
  } else {
    console.log(
      chalk.green('Completed') +
        ' ' +
        chalk.dim(task.id.slice(0, 8)) +
        ' ' +
        chalk.strikethrough(task.title),
    );
    console.log(ref);
  }
}

import chalk from 'chalk';
import { outputJson } from '../utils/json-output.js';
import { apiPost, reportApiError } from '../utils/api-client.js';
import { taskRefTag } from '../utils/entity-refs.js';
import type { GlobalOptions } from '../core/types.js';

interface CompletedTask {
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
    await runDoneDirect(id, globals);
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

function printCompleted(task: CompletedTask, globals: GlobalOptions): void {
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

/**
 * LEGACY direct-core path — second writer, enabled only by WALNUT_CLI_DIRECT=1.
 * Kept as the rollback lever for the HTTP migration.
 */
async function runDoneDirect(id: string, globals: GlobalOptions): Promise<void> {
  try {
    const { completeTask } = await import('../core/task-manager.js');
    const { task } = await completeTask(id);
    printCompleted(task as unknown as CompletedTask, globals);
  } catch (err) {
    if (globals.json) {
      outputJson({ error: (err as Error).message });
    } else {
      console.error(chalk.red((err as Error).message));
    }
    process.exitCode = 1;
  }
}

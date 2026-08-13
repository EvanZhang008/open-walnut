import chalk from 'chalk';
import { outputJson } from '../utils/json-output.js';
import { apiPost, reportApiError } from '../utils/api-client.js';
import { taskRefTag } from '../utils/entity-refs.js';
import type { GlobalOptions } from '../core/types.js';
import type { TaskPriority } from '../core/types.js';

interface AddOptions {
  priority?: string;
  list?: string;
  project?: string;
  due?: string;
}

/** Slim ProjectedTask fields this command renders. */
interface CreatedTask {
  id: string;
  title: string;
  [key: string]: unknown;
}

export async function runAdd(
  title: string,
  options: AddOptions,
  globals: GlobalOptions,
): Promise<void> {
  if (process.env.WALNUT_CLI_DIRECT === '1') {
    await runAddDirect(title, options, globals);
    return;
  }

  // Omitted project → the server's default (Inbox).
  const project = options.list ?? options.project;
  try {
    const { task } = await apiPost<{ task: CreatedTask }>('/api/v1/tasks', {
      title,
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(project !== undefined ? { project } : {}),
      ...(options.due !== undefined ? { due_date: options.due } : {}),
    });
    printCreated(task, globals);
  } catch (err) {
    reportApiError(err, globals);
  }
}

/** Shared output for both paths — the ref tag is the AI-citable handle. */
function printCreated(task: CreatedTask, globals: GlobalOptions): void {
  const ref = taskRefTag(task.id, task.title);
  if (globals.json) {
    outputJson({ id: task.id, status: 'created', task, ref });
  } else {
    console.log(
      chalk.green('Created task') +
        ' ' +
        chalk.dim(task.id.slice(0, 8)) +
        ' ' +
        chalk.bold(task.title),
    );
    // Lets an AI session that ran this through Bash cite the task — the web UI
    // renders the tag as a clickable pill.
    console.log(ref);
  }
}

/**
 * LEGACY direct-core path — second writer, enabled only by WALNUT_CLI_DIRECT=1.
 * Kept as the rollback lever for the HTTP migration.
 */
async function runAddDirect(
  title: string,
  options: AddOptions,
  globals: GlobalOptions,
): Promise<void> {
  const { addTask } = await import('../core/task-manager.js');
  const { task } = await addTask({
    title,
    priority: options.priority as TaskPriority | undefined,
    // Omitted → Inbox.
    project: options.list ?? options.project,
    due_date: options.due,
  });
  printCreated(task as unknown as CreatedTask, globals);
}

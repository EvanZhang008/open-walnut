import chalk from 'chalk';
import { outputJson } from '../utils/json-output.js';
import { apiPost, reportApiError } from '../utils/api-client.js';
import { taskRefTag } from '../utils/entity-refs.js';
import { requireDirectRunners } from './direct-registry.js';
import type { GlobalOptions } from '../core/types.js';

interface AddOptions {
  priority?: string;
  list?: string;
  project?: string;
  due?: string;
}

/** Slim ProjectedTask fields this command renders. */
export interface CreatedTask {
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
    // In-process legacy path, installed only by the full CLI entry — see
    // direct-registry.ts. Keeping even a literal import of the direct module
    // out of this file is what keeps the fast bundle at ~55KB.
    await requireDirectRunners().add(title, options, globals);
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
export function printCreated(task: CreatedTask, globals: GlobalOptions): void {
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

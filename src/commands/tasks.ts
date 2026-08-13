import chalk from 'chalk';
import { outputJson } from '../utils/json-output.js';
import { apiGet, reportApiError } from '../utils/api-client.js';
import { statusSymbol, prioritySymbol, shortDate } from '../utils/format.js';
import type { GlobalOptions } from '../core/types.js';

interface TasksOptions {
  status?: string;
  project?: string;
}

/** Fields this listing renders — a subset of both Task and ProjectedTask. */
interface ListedTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  project?: string;
  created_at: string;
  [key: string]: unknown;
}

export async function runTasks(
  options: TasksOptions,
  globals: GlobalOptions,
): Promise<void> {
  if (process.env.WALNUT_CLI_DIRECT === '1') {
    await runTasksDirect(options, globals);
    return;
  }

  const params = new URLSearchParams();
  if (options.status !== undefined) params.set('status', options.status);
  // '' is meaningful (Inbox), so the gate is presence, not truthiness.
  if (options.project !== undefined) params.set('project', options.project);
  const query = params.toString();

  try {
    const { tasks } = await apiGet<{ tasks: ListedTask[] }>(
      `/api/v1/tasks${query ? `?${query}` : ''}`,
    );
    printTasks(tasks, globals);
  } catch (err) {
    reportApiError(err, globals);
  }
}

function printTasks(tasks: ListedTask[], globals: GlobalOptions): void {
  if (globals.json) {
    outputJson(tasks);
    return;
  }

  if (tasks.length === 0) {
    console.log(chalk.dim('No tasks found.'));
    return;
  }

  for (const t of tasks) {
    const sym = statusSymbol(t.status);
    const pri = prioritySymbol(t.priority);
    const id = chalk.dim(t.id.slice(0, 8));
    const title = t.status === 'done' ? chalk.strikethrough(t.title) : t.title;
    const date = chalk.dim(shortDate(t.created_at));
    const group = chalk.cyan(t.project || 'Inbox');

    console.log(`  ${sym} ${pri.padEnd(3)} ${id}  ${title}  ${group}  ${date}`);
  }
}

/**
 * LEGACY direct-core path — reads SQLite in-process. Enabled only by
 * WALNUT_CLI_DIRECT=1; the rollback lever for the HTTP migration.
 */
async function runTasksDirect(
  options: TasksOptions,
  globals: GlobalOptions,
): Promise<void> {
  const { listTasks } = await import('../core/task-manager.js');
  const tasks = await listTasks({
    status: options.status,
    project: options.project,
  });
  printTasks(tasks as unknown as ListedTask[], globals);
}

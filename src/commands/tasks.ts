import chalk from 'chalk';
import { listTasks } from '../core/task-manager.js';
import { outputJson } from '../utils/json-output.js';
import { statusSymbol, prioritySymbol, shortDate } from '../utils/format.js';
import type { GlobalOptions } from '../core/types.js';

interface TasksOptions {
  status?: string;
  category?: string;
}

export async function runTasks(
  options: TasksOptions,
  globals: GlobalOptions,
): Promise<void> {
  const tasks = await listTasks({
    status: options.status,
    category: options.category,
  });

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
    const cat = chalk.cyan(t.category);

    console.log(`  ${sym} ${pri.padEnd(3)} ${id}  ${title}  ${cat}  ${date}`);
  }
}

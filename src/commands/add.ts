import chalk from 'chalk';
import { addTask } from '../core/task-manager.js';
import { outputJson } from '../utils/json-output.js';
import type { GlobalOptions } from '../core/types.js';
import type { TaskPriority } from '../core/types.js';

interface AddOptions {
  priority?: string;
  category?: string;
  list?: string;
  project?: string;
  due?: string;
}

export async function runAdd(
  title: string,
  options: AddOptions,
  globals: GlobalOptions,
): Promise<void> {
  const { task } = await addTask({
    title,
    priority: options.priority as TaskPriority | undefined,
    category: options.category,
    project: options.list ?? options.project,
    due_date: options.due,
  });

  if (globals.json) {
    outputJson({ id: task.id, status: 'created', task });
  } else {
    console.log(
      chalk.green('Created task') +
        ' ' +
        chalk.dim(task.id.slice(0, 8)) +
        ' ' +
        chalk.bold(task.title),
    );
  }
}

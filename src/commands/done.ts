import chalk from 'chalk';
import { completeTask } from '../core/task-manager.js';
import { outputJson } from '../utils/json-output.js';
import type { GlobalOptions } from '../core/types.js';

export async function runDone(
  id: string,
  globals: GlobalOptions,
): Promise<void> {
  try {
    const { task } = await completeTask(id);

    if (globals.json) {
      outputJson({ id: task.id, status: 'completed', task });
    } else {
      console.log(
        chalk.green('Completed') +
          ' ' +
          chalk.dim(task.id.slice(0, 8)) +
          ' ' +
          chalk.strikethrough(task.title),
      );
    }
  } catch (err) {
    if (globals.json) {
      outputJson({ error: (err as Error).message });
    } else {
      console.error(chalk.red((err as Error).message));
    }
    process.exitCode = 1;
  }
}

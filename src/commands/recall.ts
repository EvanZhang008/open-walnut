import chalk from 'chalk';
import { search } from '../core/search.js';
import { outputJson } from '../utils/json-output.js';
import { prioritySymbol, statusSymbol } from '../utils/format.js';
import type { GlobalOptions, Task } from '../core/types.js';
import { listTasks } from '../core/task-manager.js';

export async function runRecall(
  query: string,
  globals: GlobalOptions,
): Promise<void> {
  const results = await search(query);

  if (globals.json) {
    outputJson(results);
    return;
  }

  if (results.length === 0) {
    console.log(chalk.dim('No results found.'));
    return;
  }

  const taskMap = new Map<string, Task>();
  const taskResults = results.filter((r) => r.type === 'task');
  if (taskResults.length > 0) {
    const tasks = await listTasks();
    for (const t of tasks) taskMap.set(t.id, t);
  }

  for (const result of results) {
    if (result.type === 'task') {
      const task = result.taskId ? taskMap.get(result.taskId) : undefined;
      const status = task ? statusSymbol(task.status) + ' ' + task.status : '';
      const priority = task ? prioritySymbol(task.priority) : '';
      console.log(`  ${chalk.yellow('[task]')} ${chalk.bold(result.title)}`);
      if (task) {
        console.log(`     ${status}  ${priority}`);
      }
    } else {
      console.log(`  ${chalk.blue('[memo]')} ${chalk.dim(result.path)}`);
      console.log(`     ${chalk.bold(result.title)}`);
    }
    console.log(`     ${chalk.dim('"' + result.snippet + '"')}`);
    console.log();
  }
}

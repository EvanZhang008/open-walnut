import chalk from 'chalk';
import { outputJson } from '../utils/json-output.js';
import { apiGet, reportApiError } from '../utils/api-client.js';
import { prioritySymbol, statusSymbol } from '../utils/format.js';
import type { GlobalOptions } from '../core/types.js';
import type { SearchResult } from '../core/search.js';

/** Status/priority decoration for a task hit — the list payload's slim shape. */
interface TaskFacts { status: string; priority: string }

export async function runRecall(
  query: string,
  globals: GlobalOptions,
): Promise<void> {
  if (process.env.WALNUT_CLI_DIRECT === '1') {
    await runRecallDirect(query, globals);
    return;
  }

  try {
    const { results } = await apiGet<{ results: SearchResult[] }>(
      `/api/v1/search?q=${encodeURIComponent(query)}`,
    );

    if (globals.json) {
      outputJson(results);
      return;
    }

    // SearchResult carries no status/priority, so task hits are decorated from
    // the task list — same enrichment the in-process path did with listTasks().
    let facts = new Map<string, TaskFacts>();
    if (results.some((r) => r.type === 'task')) {
      const { tasks } = await apiGet<{ tasks: Array<{ id: string } & TaskFacts> }>('/api/v1/tasks');
      facts = new Map(tasks.map((t) => [t.id, { status: t.status, priority: t.priority }]));
    }
    printResults(results, facts);
  } catch (err) {
    reportApiError(err, globals);
  }
}

function printResults(results: SearchResult[], facts: Map<string, TaskFacts>): void {
  if (results.length === 0) {
    console.log(chalk.dim('No results found.'));
    return;
  }

  for (const result of results) {
    if (result.type === 'task') {
      const task = result.taskId ? facts.get(result.taskId) : undefined;
      console.log(`  ${chalk.yellow('[task]')} ${chalk.bold(result.title)}`);
      if (task) {
        console.log(`     ${statusSymbol(task.status)} ${task.status}  ${prioritySymbol(task.priority)}`);
      }
    } else {
      console.log(`  ${chalk.blue('[memo]')} ${chalk.dim(result.path)}`);
      console.log(`     ${chalk.bold(result.title)}`);
    }
    console.log(`     ${chalk.dim('"' + result.snippet + '"')}`);
    console.log();
  }
}

/**
 * LEGACY direct-core path — runs the search engine in-process. Enabled only by
 * WALNUT_CLI_DIRECT=1; the rollback lever for the HTTP migration.
 */
async function runRecallDirect(query: string, globals: GlobalOptions): Promise<void> {
  const { search } = await import('../core/search.js');
  const results = await search(query);

  if (globals.json) {
    outputJson(results);
    return;
  }

  let facts = new Map<string, TaskFacts>();
  if (results.some((r) => r.type === 'task')) {
    const { listTasks } = await import('../core/task-manager.js');
    const tasks = await listTasks();
    facts = new Map(tasks.map((t) => [t.id, { status: t.status, priority: t.priority }]));
  }
  printResults(results, facts);
}

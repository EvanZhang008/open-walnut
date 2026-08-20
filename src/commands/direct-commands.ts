/**
 * WALNUT_CLI_DIRECT=1 implementations — every data command's LEGACY in-process
 * path, moved here whole so the data command files stay slim (see
 * direct-registry.ts for why even a dynamic `import('../core/...')` literal
 * inside a data command would re-inflate the fast bundle).
 *
 * This module is only ever loaded by the FULL CLI entry (src/cli.ts), and only
 * when WALNUT_CLI_DIRECT=1. It is the rollback lever for the HTTP migration
 * and the isolation lever for tests (a temp OPEN_WALNUT_HOME only affects
 * in-process reads; the HTTP path would hit the production server).
 *
 * These run core modules in THIS process — a second writer beside a running
 * server. That hazard is exactly why they are no longer the default.
 */

import chalk from 'chalk';
import { outputJson } from '../utils/json-output.js';
import { installDirectRunners } from './direct-registry.js';
import { printCreated } from './add.js';
import { printTasks, type ListedTask } from './tasks.js';
import { printCompleted } from './done.js';
import { printResults, type TaskFacts } from './recall.js';
import { printProjects, type ProjectInfo } from './projects.js';
import { printSessions, SESSION_LIST_LIMIT } from './sessions.js';
import { printStart } from './start.js';
import type { GlobalOptions, TaskPriority } from '../core/types.js';

export function installDirect(): void {
  installDirectRunners({
    async add(title, options, globals: GlobalOptions) {
      const { addTask } = await import('../core/task-manager.js');
      const { task } = await addTask({
        title,
        priority: options.priority as TaskPriority | undefined,
        // Omitted → Inbox.
        project: options.list ?? options.project,
        due_date: options.due,
      });
      printCreated(task as unknown as Parameters<typeof printCreated>[0], globals);
    },

    async tasks(options, globals) {
      const { listTasks } = await import('../core/task-manager.js');
      const tasks = await listTasks({
        status: options.status,
        project: options.project,
      });
      printTasks(tasks as unknown as ListedTask[], globals);
    },

    async done(id, globals) {
      try {
        const { completeTask } = await import('../core/task-manager.js');
        const { task } = await completeTask(id);
        printCompleted(task as unknown as Parameters<typeof printCompleted>[0], globals);
      } catch (err) {
        if (globals.json) {
          outputJson({ error: (err as Error).message });
        } else {
          console.error(chalk.red((err as Error).message));
        }
        process.exitCode = 1;
      }
    },

    async recall(query, globals) {
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
    },

    async projects(globals) {
      const { listTasks } = await import('../core/task-manager.js');
      const { listMemories } = await import('../core/memory.js');
      const tasks = await listTasks();
      const projectMap = new Map<string, ProjectInfo>();

      const ensure = (name: string): ProjectInfo => {
        let info = projectMap.get(name);
        if (!info) {
          info = { name, taskCount: 0, activeTasks: 0, doneTasks: 0, sessions: [], memoryFiles: [] };
          projectMap.set(name, info);
        }
        return info;
      };

      for (const task of tasks) {
        const info = ensure(task.project ?? '(none)');
        info.taskCount++;
        if (task.status === 'done') info.doneTasks++;
        else info.activeTasks++;
        for (const sid of task.session_ids) {
          if (!info.sessions.includes(sid)) info.sessions.push(sid);
        }
      }

      // Add project memory files (the direct path always initializes the array)
      for (const mem of listMemories('project')) {
        ensure(mem.title).memoryFiles!.push(mem.path);
      }

      const projects = Array.from(projectMap.values()).sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      printProjects(projects, globals);
    },

    async sessions(globals) {
      const { getRecentSessions } = await import('../core/session-tracker.js');
      const records = await getRecentSessions(SESSION_LIST_LIMIT);
      printSessions(
        records.map((s) => ({
          id: s.claudeSessionId,
          process_status: s.process_status,
          project: s.project,
          task_id: s.taskId,
          last_active_at: s.lastActiveAt,
        })),
        globals,
      );
    },

    async start(taskIdPrefix, options, globals) {
      const { startSessionForTask } = await import('../core/sessions/task-start.js');
      // The bus emit only reaches a runner that exists in THIS process.
      const { sessionRunner } = await import('../providers/claude-code-session.js');
      sessionRunner.init();

      try {
        const result = await startSessionForTask({
          taskIdPrefix,
          ...(options.resume ? { resume: true } : {}),
          ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
          source: 'cli',
        });
        printStart(result, globals);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (globals.json) {
          outputJson({ error: message });
        } else {
          console.error(chalk.red(message));
        }
        process.exitCode = 1;
      }
    },
  });
}

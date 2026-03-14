import chalk from 'chalk';
import { getSessionsForTask } from '../core/session-tracker.js';
import { listTasks } from '../core/task-manager.js';
import { bus, EventNames } from '../core/event-bus.js';
import { outputJson } from '../utils/json-output.js';
import type { GlobalOptions } from '../core/types.js';

interface StartOptions {
  resume?: boolean;
  prompt?: string;
}

/**
 * open-walnut start <task_id> - Start a Claude Code session for a task.
 *
 * Emits session:start or session:send to the event bus.
 * In CLI mode, the session runner must be initialized separately
 * (it auto-inits when using `open-walnut web`).
 */
export async function runStart(
  taskIdPrefix: string,
  options: StartOptions,
  globals: GlobalOptions,
): Promise<void> {
  // Find the matching task
  const tasks = await listTasks();
  const matches = tasks.filter((t) => t.id.startsWith(taskIdPrefix));

  if (matches.length === 0) {
    if (globals.json) {
      outputJson({ error: `No task found matching "${taskIdPrefix}"` });
    } else {
      console.error(chalk.red(`No task found matching "${taskIdPrefix}"`));
    }
    process.exitCode = 1;
    return;
  }

  if (matches.length > 1) {
    if (globals.json) {
      outputJson({ error: `Ambiguous ID "${taskIdPrefix}" matches ${matches.length} tasks` });
    } else {
      console.error(chalk.red(`Ambiguous ID "${taskIdPrefix}" matches ${matches.length} tasks. Be more specific.`));
    }
    process.exitCode = 1;
    return;
  }

  const task = matches[0];

  // Initialize the session runner for CLI usage
  const { sessionRunner } = await import('../providers/claude-code-session.js');
  sessionRunner.init();

  // Resume mode: find an existing session for this task
  if (options.resume) {
    const sessions = await getSessionsForTask(task.id);
    const existing = sessions.find(
      (s) => s.work_status === 'in_progress' || s.work_status === 'agent_complete',
    );

    if (existing) {
      const prompt = options.prompt ?? `Continuing work on: ${task.title}`;

      if (globals.json) {
        outputJson({ action: 'resume', sessionId: existing.claudeSessionId });
      } else {
        console.log(chalk.yellow(`Resuming session: ${existing.claudeSessionId.slice(0, 16)}`));
      }

      bus.emit(EventNames.SESSION_SEND, {
        sessionId: existing.claudeSessionId,
        taskId: task.id,
        message: prompt,
      }, ['session-runner'], { source: 'cli' });
      return;
    }

    if (globals.json) {
      outputJson({ warning: 'No existing session found, starting new one' });
    } else {
      console.log(chalk.dim('No existing session found. Starting a new one.'));
    }
  }

  // Start a new session
  const prompt = options.prompt ?? `Working on task: ${task.title}`;

  bus.emit(EventNames.SESSION_START, {
    taskId: task.id,
    message: prompt,
    project: task.project,
  }, ['session-runner'], { source: 'cli' });

  if (globals.json) {
    outputJson({ action: 'start', taskId: task.id });
  } else {
    console.log(chalk.green('Started session for task:'), task.title);
    console.log(chalk.dim('Session running via claude -p (non-blocking).'));
  }
}

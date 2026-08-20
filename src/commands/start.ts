import chalk from 'chalk';
import { outputJson } from '../utils/json-output.js';
import { apiPost, reportApiError } from '../utils/api-client.js';
import { requireDirectRunners } from './direct-registry.js';
import type { GlobalOptions } from '../core/types.js';
import type { TaskStartResult } from '../core/sessions/task-start.js';

interface StartOptions {
  resume?: boolean;
  prompt?: string;
}

/**
 * open-walnut start <task_id> - Start a Claude Code session for a task.
 *
 * Runs on the SERVER: POST /api/v1/tasks/:id/start emits SESSION_START in the
 * process that owns the session-runner, so the CLI never spawns a CLI or writes
 * the session registry itself. (POST /api/v1/sessions can't express this — its
 * body requires an absolute `cwd`, while this command names only a task and
 * lets the runner resolve cwd from the task/project chain.)
 */
export async function runStart(
  taskIdPrefix: string,
  options: StartOptions,
  globals: GlobalOptions,
): Promise<void> {
  if (process.env.WALNUT_CLI_DIRECT === '1') {
    // In-process legacy path, installed only by the full CLI entry — see
    // direct-registry.ts.
    await requireDirectRunners().start(taskIdPrefix, options, globals);
    return;
  }

  try {
    const result = await apiPost<TaskStartResult>(
      `/api/v1/tasks/${encodeURIComponent(taskIdPrefix)}/start`,
      {
        ...(options.resume ? { resume: true } : {}),
        ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
      },
    );
    printStart(result, globals);
  } catch (err) {
    reportApiError(err, globals);
  }
}

export function printStart(result: TaskStartResult, globals: GlobalOptions): void {
  if (result.action === 'resume') {
    if (globals.json) {
      outputJson({ action: 'resume', sessionId: result.sessionId });
    } else {
      console.log(chalk.yellow(`Resuming session: ${(result.sessionId ?? '').slice(0, 16)}`));
    }
    return;
  }

  if (result.resume_missed) {
    if (globals.json) {
      outputJson({ warning: 'No existing session found, starting new one' });
    } else {
      console.log(chalk.dim('No existing session found. Starting a new one.'));
    }
  }

  if (globals.json) {
    outputJson({ action: 'start', taskId: result.taskId });
  } else {
    console.log(chalk.green('Started session for task:'), result.title);
    console.log(chalk.dim('Session running via claude -p (non-blocking).'));
  }
}

// The WALNUT_CLI_DIRECT=1 implementation lives in direct-commands.ts.

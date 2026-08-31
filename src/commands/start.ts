import chalk from 'chalk';
import { outputJson } from '../utils/json-output.js';
import { apiPost, reportApiError } from '../utils/api-client.js';
import { requireDirectRunners } from './direct-registry.js';
import type { GlobalOptions } from '../core/types.js';
import type { SessionStartResult } from '../core/sessions/task-start.js';

interface StartOptions {
  message?: string;
}

/**
 * open-walnut start <task_id> - Start a Claude Code session for a task.
 *
 * Runs on the SERVER: POST /api/v1/tasks/:id/start emits SESSION_START in the
 * process that owns the session-runner, so the CLI never spawns a CLI or writes
 * the session registry itself. (POST /api/v1/sessions can't express this — its
 * body requires an absolute `cwd`, while this command names only a task and
 * lets the runner resolve cwd from the task/project chain.)
 *
 * A task whose session is still live gets a 409 from the server pointing at
 * session_send — starting is for tasks with no running session.
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
    const result = await apiPost<SessionStartResult>(
      `/api/v1/tasks/${encodeURIComponent(taskIdPrefix)}/start`,
      options.message !== undefined ? { message: options.message } : {},
    );
    printStart(result, globals);
  } catch (err) {
    reportApiError(err, globals);
  }
}

export function printStart(result: SessionStartResult, globals: GlobalOptions): void {
  if (globals.json) {
    outputJson({ action: 'start', taskId: result.taskId, ...(result.sessionId ? { sessionId: result.sessionId } : {}) });
  } else {
    console.log(chalk.green('Started session for task:'), result.title);
    if (result.sessionId) console.log(chalk.dim(`Session: ${result.sessionId}`));
    console.log(chalk.dim('Session running via claude -p (non-blocking).'));
  }
}

// The WALNUT_CLI_DIRECT=1 implementation lives in direct-commands.ts.

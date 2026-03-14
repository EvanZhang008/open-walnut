import chalk from 'chalk';
import { getRecentSessions } from '../core/session-tracker.js';
import { outputJson } from '../utils/json-output.js';
import { shortDate } from '../utils/format.js';
import type { GlobalOptions } from '../core/types.js';

/**
 * open-walnut sessions - List all tracked sessions.
 */
export async function runSessions(globals: GlobalOptions): Promise<void> {
  const sessions = await getRecentSessions(20);

  if (globals.json) {
    outputJson(sessions);
    return;
  }

  if (sessions.length === 0) {
    console.log(chalk.dim('No sessions found.'));
    return;
  }

  // Header
  console.log(
    chalk.bold(
      padRight('WORK STATUS', 18) +
      padRight('PROC', 8) +
      padRight('PROJECT', 16) +
      padRight('TASK', 12) +
      padRight('LAST ACTIVE', 14) +
      'SESSION ID',
    ),
  );

  for (const session of sessions) {
    const wsColor =
      session.work_status === 'in_progress' ? chalk.green :
      session.work_status === 'agent_complete' ? chalk.yellow :
      session.work_status === 'await_human_action' ? chalk.magenta :
      session.work_status === 'error' ? chalk.red :
      chalk.dim;

    const workStatus = wsColor(padRight(session.work_status, 18));
    const procStatus = session.process_status === 'running' ? chalk.green(padRight('●', 8))
      : session.process_status === 'idle' ? chalk.yellow(padRight('◉', 8))
      : chalk.dim(padRight('○', 8));
    const project = padRight(session.project, 16);
    const task = padRight(session.taskId?.slice(0, 10) ?? '-', 12);
    const lastActive = padRight(shortDate(session.lastActiveAt), 14);
    const sessionId = chalk.dim(session.claudeSessionId.slice(0, 16));

    console.log(`${workStatus}${procStatus}${project}${task}${lastActive}${sessionId}`);
  }
}

function padRight(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len - 1) + ' ';
  return str + ' '.repeat(len - str.length);
}

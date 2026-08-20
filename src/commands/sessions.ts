import chalk from 'chalk';
import { outputJson } from '../utils/json-output.js';
import { apiGet, reportApiError } from '../utils/api-client.js';
import { shortDate } from '../utils/format.js';
import { requireDirectRunners } from './direct-registry.js';
import type { GlobalOptions } from '../core/types.js';

export const SESSION_LIST_LIMIT = 20;

/** The columns this listing renders (ProjectedSession ∪ SessionRecord). */
export interface ListedSession {
  id: string;
  process_status: string;
  project?: string;
  task_id?: string;
  last_active_at: string;
}

/**
 * open-walnut sessions - List all tracked sessions.
 */
export async function runSessions(globals: GlobalOptions): Promise<void> {
  if (process.env.WALNUT_CLI_DIRECT === '1') {
    // In-process legacy path, installed only by the full CLI entry — see
    // direct-registry.ts.
    await requireDirectRunners().sessions(globals);
    return;
  }

  try {
    const { sessions } = await apiGet<{ sessions: ListedSession[] }>('/api/v1/sessions');
    // The projection is already sorted newest-first and capped; the CLI shows
    // the most recent 20.
    printSessions(sessions.slice(0, SESSION_LIST_LIMIT), globals);
  } catch (err) {
    reportApiError(err, globals);
  }
}

export function printSessions(sessions: ListedSession[], globals: GlobalOptions): void {
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
    const psColor =
      session.process_status === 'running' ? chalk.green :
      session.process_status === 'idle' ? chalk.yellow :
      session.process_status === 'error' ? chalk.red :
      chalk.dim;

    const procStatusLabel = psColor(padRight(session.process_status, 18));
    const procStatus = session.process_status === 'running' ? chalk.green(padRight('●', 8))
      : session.process_status === 'idle' ? chalk.yellow(padRight('◉', 8))
      : session.process_status === 'error' ? chalk.red(padRight('✕', 8))
      : chalk.dim(padRight('○', 8));
    const project = padRight(session.project ?? '', 16);
    const task = padRight(session.task_id?.slice(0, 10) ?? '-', 12);
    const lastActive = padRight(shortDate(session.last_active_at), 14);
    const sessionId = chalk.dim(session.id.slice(0, 16));

    console.log(`${procStatusLabel}${procStatus}${project}${task}${lastActive}${sessionId}`);
  }
}

// The WALNUT_CLI_DIRECT=1 implementation lives in direct-commands.ts.

function padRight(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len - 1) + ' ';
  return str + ' '.repeat(len - str.length);
}

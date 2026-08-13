import chalk from 'chalk';
import { outputJson } from '../utils/json-output.js';
import { apiGet, reportApiError } from '../utils/api-client.js';
import { shortDate } from '../utils/format.js';
import type { GlobalOptions } from '../core/types.js';

const LIST_LIMIT = 20;

/** The columns this listing renders (ProjectedSession ∪ SessionRecord). */
interface ListedSession {
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
    await runSessionsDirect(globals);
    return;
  }

  try {
    const { sessions } = await apiGet<{ sessions: ListedSession[] }>('/api/v1/sessions');
    // The projection is already sorted newest-first and capped; the CLI shows
    // the most recent 20.
    printSessions(sessions.slice(0, LIST_LIMIT), globals);
  } catch (err) {
    reportApiError(err, globals);
  }
}

function printSessions(sessions: ListedSession[], globals: GlobalOptions): void {
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

/**
 * LEGACY direct-core path — reads the session registry in-process. Enabled only
 * by WALNUT_CLI_DIRECT=1; the rollback lever for the HTTP migration.
 */
async function runSessionsDirect(globals: GlobalOptions): Promise<void> {
  const { getRecentSessions } = await import('../core/session-tracker.js');
  const records = await getRecentSessions(LIST_LIMIT);
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
}

function padRight(str: string, len: number): string {
  if (str.length >= len) return str.slice(0, len - 1) + ' ';
  return str + ' '.repeat(len - str.length);
}

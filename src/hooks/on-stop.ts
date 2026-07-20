import {
  findClaudeSessionDir,
  extractSessionSummary,
  saveSessionSummary,
  updateTaskFromSession,
  deriveProjectPath,
  formatDailyLogEntry,
  logHookError,
} from './shared.js';
import { appendDailyLog } from '../core/daily-log.js';
import { appendSkillHistoryForProject } from '../core/overview-log.js';
import { WALNUT_HOME } from '../constants.js';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { log } from '../logging/index.js';
import { markSessionStoppedInSqlite } from './session-status-store.js';

// Local copy of SESSION_DB_PATH to keep the hook bundle free of session-db.ts
// (which would drag in types + logger). Keep in sync with src/core/session-db.ts:30.
const SESSION_DB_PATH = path.join(WALNUT_HOME, 'sessions.sqlite');

/**
 * On-stop hook: runs when a Claude Code session ends.
 * MUST be completely silent - no stdout/stderr output.
 */
function main(): void {
  try {
    const sessionDir = findClaudeSessionDir();
    if (!sessionDir) return;

    const summary = extractSessionSummary(sessionDir);
    summary.status = 'agent_complete';

    // Gather git diff info
    const filesChanged = getFilesChanged();

    // Save the summary to disk
    saveSessionSummary(summary, filesChanged);

    // Update any linked sessions in sessions.json
    updateSessionStore(summary.id);

    // Update linked tasks if we can find a task ID
    const taskId = findLinkedTaskId();
    if (taskId) {
      summary.task_ids.push(taskId);
      try {
        updateTaskFromSession(taskId, summary);
      } catch (err) {
        log.hook.warn('on-stop: task update failed', { taskId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    try {
      const projectPath = taskId ? deriveProjectPath(taskId) : null;
      const entry = formatDailyLogEntry(summary, filesChanged);
      appendDailyLog(entry, 'session-end', projectPath ?? undefined);
      if (projectPath) {
        // memory/projects/ retired (2026-07 unification): session summaries land
        // in skills/<category>/<project>/history/ (or the category overview log).
        // No matching skill → skip; the daily log has the entry regardless.
        const [category, ...rest] = projectPath.split('/');
        appendSkillHistoryForProject(category, rest.join('-') || category, summary.summary, 'session');
      }
    } catch (err) {
      log.hook.warn('on-stop: failed to write daily/skill-history memory', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    // Git versioning: commits are now handled centrally by GitVersioningService
    // in the server process. Hooks only write data files; the service detects
    // changes via bus events and fs watchers, then commits with debouncing.
  } catch (err) {
    log.hook.error('on-stop hook failed', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
    logHookError('on-stop', err);
  }
}

function getFilesChanged(): string[] {
  try {
    const output = execSync(
      'git diff --name-only HEAD~1 HEAD 2>/dev/null || git diff --name-only 2>/dev/null',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function updateSessionStore(sessionId: string): void {
  try {
    if (!fs.existsSync(SESSION_DB_PATH)) return;
    // Don't overwrite error, and increment the status version only when the
    // canonical projection actually changes.
    markSessionStoppedInSqlite(SESSION_DB_PATH, sessionId);
  } catch (err) {
    log.hook.warn('on-stop: session store update failed', { sessionId, error: String(err) });
  }
}

function findLinkedTaskId(): string | null {
  try {
    if (!fs.existsSync(SESSION_DB_PATH)) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(SESSION_DB_PATH, { readonly: true, fileMustExist: true });
    try {
      const row = db
        .prepare(
          `SELECT task_id FROM sessions
           WHERE task_id IS NOT NULL AND task_id <> ''
           ORDER BY last_active_at DESC
           LIMIT 1`,
        )
        .get() as { task_id: string | null } | undefined;
      return row?.task_id ?? null;
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch {
    return null;
  }
}

// Read stdin to completion then run (Claude Code hook protocol)
process.stdin.setEncoding('utf-8');
process.stdin.on('data', () => { /* drain stdin */ });
process.stdin.on('end', () => {
  main();
  process.exit(0);
});
process.stdin.resume();

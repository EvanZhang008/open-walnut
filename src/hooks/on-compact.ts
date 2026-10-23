import {
  findClaudeSessionDir,
  extractSessionSummary,
  saveSessionSummary,
  formatDailyLogEntry,
  logHookError,
} from './shared.js';
import { appendDailyLog } from '../core/daily-log.js';
import { WALNUT_HOME } from '../constants.js';
import { log } from '../logging/index.js';
import Database from '../lib/sqlite.js';
import fs from 'node:fs';
import path from 'node:path';

// Keep in sync with src/core/session-db.ts:30.
const SESSION_DB_PATH = path.join(WALNUT_HOME, 'sessions.sqlite');

/**
 * On-compact hook: runs when Claude Code compacts context.
 * Saves intermediate session state (marked as "in progress").
 * MUST be completely silent - no stdout/stderr output.
 */
function main(): void {
  try {
    const sessionDir = findClaudeSessionDir();
    if (!sessionDir) return;

    const summary = extractSessionSummary(sessionDir);
    summary.status = 'in_progress';

    // Save the intermediate summary
    saveSessionSummary(summary);

    try {
      const entry = formatDailyLogEntry(summary);
      appendDailyLog(entry, 'compact');
    } catch (err) { log.hook.warn('on-compact: daily log failed', { error: String(err) }); }

    // Update the session store to mark last active time — scoped to THIS session.
    updateSessionLastActive(summary.id);

    // Git versioning: commits are now handled centrally by GitVersioningService
    // in the server process. Hooks only write data files.
  } catch (err) {
    logHookError('on-compact', err);
  }
}

function updateSessionLastActive(sessionId: string): void {
  try {
    if (!sessionId) return;
    if (!fs.existsSync(SESSION_DB_PATH)) return;
    const db = new Database(SESSION_DB_PATH);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');

      const now = new Date().toISOString();
      // Scoped to THIS session only. The previous unscoped
      // `WHERE process_status = 'running'` rewrote ALL ~295 running rows on
      // every compact (seen 103×), from a separate process handle — contending
      // for the WAL write lock with the main process and refreshing the
      // orphan dead-pool's timestamps so it never aged out. last_active_at is a
      // TEXT/ISO column everywhere (session-db schema), so keep ISO — the bug
      // was the unscoped WHERE, not the format.
      const stmt = db.prepare(
        `UPDATE sessions SET last_active_at = ? WHERE claude_session_id = ?`,
      );
      db.transaction(() => { stmt.run(now, sessionId); })();
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch (err) {
    log.hook.warn('on-compact: session update failed', { error: String(err) });
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

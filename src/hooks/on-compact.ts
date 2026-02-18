import {
  findClaudeSessionDir,
  extractSessionSummary,
  saveSessionSummary,
  formatDailyLogEntry,
  logHookError,
} from './shared.js';
import { appendDailyLog } from '../core/daily-log.js';
import { SESSIONS_FILE } from '../constants.js';
import { withFileLockSync } from '../utils/file-lock.js';
import { log } from '../logging/index.js';
import fs from 'node:fs';

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
      const entry = formatDailyLogEntry(summary, 'compact');
      appendDailyLog(entry, 'compact');
    } catch (err) { log.hook.warn('on-compact: daily log failed', { error: String(err) }); }

    // Update the session store to mark last active time
    updateSessionLastActive();

    // Git versioning: commits are now handled centrally by GitVersioningService
    // in the server process. Hooks only write data files.
  } catch (err) {
    logHookError('on-compact', err);
  }
}

function updateSessionLastActive(): void {
  try {
    withFileLockSync(SESSIONS_FILE, () => {
      if (!fs.existsSync(SESSIONS_FILE)) return;

      const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const store = JSON.parse(raw);
      if (!Array.isArray(store.sessions)) return;

      for (const session of store.sessions) {
        if (session.work_status === 'in_progress') {
          session.lastActiveAt = new Date().toISOString();
        }
      }

      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(store, null, 2) + '\n', 'utf-8');
    });
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

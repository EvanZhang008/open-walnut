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
import { appendProjectMemory } from '../core/project-memory.js';
import { SESSIONS_FILE } from '../constants.js';
import { withFileLockSync } from '../utils/file-lock.js';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { log } from '../logging/index.js';

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
      const entry = formatDailyLogEntry(summary, 'session-end', filesChanged);
      appendDailyLog(entry, 'session-end', projectPath ?? undefined);
      if (projectPath) {
        appendProjectMemory(projectPath, summary.summary, 'session');
      }
    } catch (err) {
      log.hook.warn('on-stop: failed to write daily/project memory', {
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
    withFileLockSync(SESSIONS_FILE, () => {
      if (!fs.existsSync(SESSIONS_FILE)) return;

      const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const store = JSON.parse(raw);
      if (!Array.isArray(store.sessions)) return;

      for (const session of store.sessions) {
        if (session.claudeSessionId === sessionId && session.work_status !== 'completed' && session.work_status !== 'error') {
          session.process_status = 'stopped';
          // Process stopping = turn completed, NOT work completed.
          // Only the human (REST PATCH) can set 'completed'.
          session.work_status = 'agent_complete';
          session.last_status_change = new Date().toISOString();
          session.lastActiveAt = new Date().toISOString();
          delete session.activity;
        }
      }

      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(store, null, 2) + '\n', 'utf-8');
    });
  } catch (err) {
    log.hook.warn('on-stop: session store update failed', { sessionId, error: String(err) });
  }
}

function findLinkedTaskId(): string | null {
  try {
    if (!fs.existsSync(SESSIONS_FILE)) return null;

    const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    const store = JSON.parse(raw);
    if (!Array.isArray(store.sessions)) return null;

    // Find the most recent active/completed session with a taskId
    const linked = store.sessions
      .filter((s: { taskId?: string }) => s.taskId)
      .sort((a: { lastActiveAt: string }, b: { lastActiveAt: string }) =>
        b.lastActiveAt.localeCompare(a.lastActiveAt),
      );

    return linked[0]?.taskId ?? null;
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

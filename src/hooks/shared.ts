import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME, SESSIONS_DIR, TASKS_DIR, HOOK_LOG_FILE } from '../constants.js';
import type { SessionSummary } from '../core/types.js';
import { log } from '../logging/index.js';

// Local TASK_DB_PATH copy (kept in sync with src/core/task-db.ts): hooks are
// bundled as standalone scripts with `better-sqlite3` listed in tsup's
// `external` array, so they load it via runtime `require()`. If better-sqlite3
// is removed from the externals list, hook bundles will try to inline the
// native addon and fail at load time.
const TASK_DB_PATH = path.join(TASKS_DIR, 'tasks.sqlite');

/**
 * Find the most recent Claude Code session directory.
 * Claude Code stores data in ~/.claude/projects/<project>/.
 */
export function findClaudeSessionDir(): string | null {
  try {
    const projectsDir = path.join(CLAUDE_HOME, 'projects');
    if (!fs.existsSync(projectsDir)) return null;

    const projects = fs.readdirSync(projectsDir);
    let latest: { dir: string; mtime: number } | null = null;

    for (const project of projects) {
      const projectPath = path.join(projectsDir, project);
      const stat = fs.statSync(projectPath);
      if (!stat.isDirectory()) continue;

      // Look for session files inside project dirs
      const files = fs.readdirSync(projectPath);
      for (const file of files) {
        const filePath = path.join(projectPath, file);
        const fstat = fs.statSync(filePath);
        if (fstat.mtime.getTime() > (latest?.mtime ?? 0)) {
          latest = { dir: projectPath, mtime: fstat.mtime.getTime() };
        }
      }
    }

    return latest?.dir ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract a session summary from git diff and session directory info.
 */
export function extractSessionSummary(sessionDir: string): SessionSummary {
  const project = path.basename(sessionDir);
  const now = new Date();
  const dateStr = formatDate(now);

  // Try to read any recent conversation data
  const conversationSnippet = readRecentConversation(sessionDir);

  const summaryText = conversationSnippet || `Work session in ${project}`;
  const slug = generateSlug(summaryText, dateStr);

  return {
    id: slug,
    project,
    slug,
    summary: summaryText,
    status: 'completed',
    date: dateStr,
    task_ids: [],
  };
}

/**
 * Save a session summary as a markdown file in the sessions directory.
 * Returns the file path.
 */
export function saveSessionSummary(
  summary: SessionSummary,
  filesChanged: string[] = [],
  decisions: string[] = [],
  nextSteps: string[] = [],
): string {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });

  const filePath = path.join(SESSIONS_DIR, `${summary.slug}.md`);

  const taskLine = summary.task_ids.length > 0
    ? `Task: ${summary.task_ids.join(', ')}`
    : '';

  const filesSection = filesChanged.length > 0
    ? `\n## Files Changed\n${filesChanged.map((f) => `- ${f}`).join('\n')}`
    : '';

  const decisionsSection = decisions.length > 0
    ? `\n## Decisions\n${decisions.map((d) => `- ${d}`).join('\n')}`
    : '';

  const nextStepsSection = nextSteps.length > 0
    ? `\n## Next Steps\n${nextSteps.map((n) => `- ${n}`).join('\n')}`
    : '';

  const content = `# Session: ${summary.summary}
Date: ${summary.date}
Project: ${summary.project}
Status: ${summary.status}
${taskLine}

## Summary
${summary.summary}
${filesSection}
${decisionsSection}
${nextStepsSection}
`;

  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Update a linked task's note with session info.
 */
export function updateTaskFromSession(taskId: string, summary: SessionSummary): void {
  try {
    // Lazy require so the TS type system doesn't fight the `external` bundle flag.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    if (!fs.existsSync(TASK_DB_PATH)) return;

    const db = new Database(TASK_DB_PATH);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');

      // Find a task whose id starts with the (possibly truncated) taskId.
      // Use LIKE with escaped % to preserve the existing `startsWith` semantics.
      //
      // Exact-match-wins pattern: a full-length task id passed by a caller must
      // hit its exact row even if another task starts with the same 8-char
      // prefix. ORDER BY (id = ?) DESC prioritizes the exact match over prefix
      // hits. LIKE escapes guard against a literal `%`, `_`, or `\` in an id
      // corrupting the pattern.
      const escaped = taskId.replace(/[\\%_]/g, (ch) => '\\' + ch);
      const row = db
        .prepare(
          `SELECT id, phase, session_ids, note, description, summary, payload
           FROM tasks
           WHERE id = ? OR id LIKE ? ESCAPE '\\'
           ORDER BY (id = ?) DESC
           LIMIT 1`,
        )
        .get(taskId, escaped + '%', taskId) as
        | {
            id: string;
            phase: string | null;
            session_ids: string | null;
            note: string | null;
            description: string | null;
            summary: string | null;
            payload: string | null;
          }
        | undefined;
      if (!row) return;

      // Parse session_ids (JSON column).
      let sessionIds: string[] = [];
      if (row.session_ids) {
        try {
          const parsed = JSON.parse(row.session_ids);
          if (Array.isArray(parsed)) sessionIds = parsed.filter((s): s is string => typeof s === 'string');
        } catch { /* treat as empty */ }
      }

      // Parse payload (for plan_session_id / exec_session_id / session_id / legacy active_session_*).
      let payload: Record<string, unknown> = {};
      if (row.payload) {
        try {
          const parsed = JSON.parse(row.payload);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            payload = parsed as Record<string, unknown>;
          }
        } catch { /* ignore corrupt payload */ }
      }

      // Append note entry.
      const entry = `[${summary.date}] Session: ${summary.summary}`;
      const currentNote = row.note ?? '';
      const newNote = currentNote ? currentNote + '\n\n' + entry : entry;

      // Phase advance.
      let newPhase = row.phase;
      if (row.phase === 'TODO' || row.phase === 'IN_PROGRESS') {
        newPhase = 'AGENT_COMPLETE';
      }

      // session_ids append (dedupe).
      if (!sessionIds.includes(summary.id)) {
        sessionIds.push(summary.id);
      }

      // Clear typed session slots on completion. These live in payload (not their
      // own columns). Only touch payload if we actually change it.
      let payloadDirty = false;
      if (summary.status === 'completed') {
        for (const slot of ['plan_session_id', 'exec_session_id', 'session_id'] as const) {
          if (payload[slot] === summary.id) {
            delete payload[slot];
            payloadDirty = true;
          }
        }
      }
      // Clean up legacy keys regardless of status.
      if ('active_session_ids' in payload) { delete payload.active_session_ids; payloadDirty = true; }
      if ('active_session_id' in payload) { delete payload.active_session_id; payloadDirty = true; }

      const updatedAt = new Date().toISOString();
      const sessionIdsJson = JSON.stringify(sessionIds);
      const payloadJson = payloadDirty ? JSON.stringify(payload) : null;

      const updateWithPayload = db.prepare(
        `UPDATE tasks SET
           note = @note,
           phase = @phase,
           session_ids = @session_ids,
           updated_at = @updated_at,
           payload = @payload
         WHERE id = @id`,
      );
      const updateWithoutPayload = db.prepare(
        `UPDATE tasks SET
           note = @note,
           phase = @phase,
           session_ids = @session_ids,
           updated_at = @updated_at
         WHERE id = @id`,
      );

      const tx = db.transaction(() => {
        if (payloadDirty) {
          updateWithPayload.run({
            id: row.id,
            note: newNote,
            phase: newPhase,
            session_ids: sessionIdsJson,
            updated_at: updatedAt,
            payload: payloadJson,
          });
        } else {
          updateWithoutPayload.run({
            id: row.id,
            note: newNote,
            phase: newPhase,
            session_ids: sessionIdsJson,
            updated_at: updatedAt,
          });
        }
      });
      tx();
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch {
    // Never throw from hook utilities
  }
}

/**
 * Log an error to the hook log file (never stdout/stderr).
 */
export function logHookError(context: string, error: unknown): void {
  try {
    fs.mkdirSync(path.dirname(HOOK_LOG_FILE), { recursive: true });
    const msg = error instanceof Error ? error.message : String(error);
    const line = `[${new Date().toISOString()}] ${context}: ${msg}\n`;
    fs.appendFileSync(HOOK_LOG_FILE, line, 'utf-8');
    // Also write to structured log
    log.hook.error(`${context}: ${msg}`, {
      context,
      stack: error instanceof Error ? (error as Error).stack : undefined,
    });
  } catch {
    // Last resort - silently ignore
  }
}

/**
 * Format a session summary as a daily log entry.
 */
export function formatDailyLogEntry(
  summary: SessionSummary,
  filesChanged?: string[],
): string {
  let entry = summary.summary;
  if (filesChanged && filesChanged.length > 0) {
    entry += `\nFiles: ${filesChanged.join(', ')}`;
  }
  return entry;
}

/**
 * Derive the task's project name by reading the task store.
 * Returns the project name, or null for Inbox (empty project) / unknown task.
 *
 * Raw SQL on its own read-only handle: this runs in a hook child process, which
 * must not touch the server's singleton connection.
 */
export function deriveProjectPath(taskId: string): string | null {
  try {
    if (!fs.existsSync(TASK_DB_PATH)) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as typeof import('better-sqlite3');
    const db = new Database(TASK_DB_PATH, { readonly: true, fileMustExist: true });
    try {
      const escaped = taskId.replace(/[\\%_]/g, (ch) => '\\' + ch);
      const row = db
        .prepare(
          `SELECT project
           FROM tasks
           WHERE id = ? OR id LIKE ? ESCAPE '\\'
           ORDER BY (id = ?) DESC
           LIMIT 1`,
        )
        .get(taskId, escaped + '%', taskId) as
        | { project: string | null }
        | undefined;
      if (!row) return null;
      return row.project?.trim() || null;
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  } catch {
    return null;
  }
}

// --- Internal helpers ---

function readRecentConversation(sessionDir: string): string {
  try {
    // Look for JSON files that might contain conversation data
    const files = fs.readdirSync(sessionDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length === 0) return '';

    const content = fs.readFileSync(path.join(sessionDir, files[0]), 'utf-8');
    const data = JSON.parse(content);

    // Try common conversation structures
    if (typeof data === 'object' && data !== null) {
      if (typeof data.summary === 'string') return data.summary;
      if (typeof data.title === 'string') return data.title;
      if (typeof data.description === 'string') return data.description;
    }

    return '';
  } catch {
    return '';
  }
}

function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

function generateSlug(text: string, dateStr: string): string {
  const dateSlug = dateStr.replace(/[: ]/g, '-').replace(/--+/g, '-');
  const textSlug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${dateSlug}-${textSlug}`;
}

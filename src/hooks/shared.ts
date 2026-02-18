import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME, SESSIONS_DIR, TASKS_FILE, HOOK_LOG_FILE } from '../constants.js';
import { withFileLockSync } from '../utils/file-lock.js';
import type { SessionSummary, Task, TaskStore } from '../core/types.js';
import { log } from '../logging/index.js';

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
    withFileLockSync(TASKS_FILE, () => {
      if (!fs.existsSync(TASKS_FILE)) return;

      const raw = fs.readFileSync(TASKS_FILE, 'utf-8');
      const store: TaskStore = JSON.parse(raw);

      const task = store.tasks.find((t) => t.id.startsWith(taskId));
      if (!task) return;

      const entry = `[${summary.date}] Session: ${summary.summary}`;
      // Migration safety: handle old notes array format
      const taskRaw = task as unknown as Record<string, unknown>;
      if (Array.isArray(taskRaw.notes)) {
        task.note = (taskRaw.notes as string[]).join('\n\n');
        delete taskRaw.notes;
        if (task.description === undefined) task.description = '';
        if (task.summary === undefined) task.summary = '';
      }
      task.note = task.note ? task.note + '\n\n' + entry : entry;

      if (!task.session_ids.includes(summary.id)) {
        task.session_ids.push(summary.id);
      }

      // Manage typed session slots (plan_session_id / exec_session_id + new session_id)
      if (summary.status === 'completed') {
        if (task.plan_session_id === summary.id) task.plan_session_id = undefined;
        if (task.exec_session_id === summary.id) task.exec_session_id = undefined;
        // Also clear new single-slot field (parallel 1-slot transition)
        if (task.session_id === summary.id) task.session_id = undefined;
      }
      // Clean up legacy active_session_ids if still present
      delete taskRaw.active_session_ids;
      delete taskRaw.active_session_id;

      task.updated_at = new Date().toISOString();
      fs.writeFileSync(TASKS_FILE, JSON.stringify(store, null, 2) + '\n', 'utf-8');
    });
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
  source: string,
  filesChanged?: string[],
): string {
  let entry = summary.summary;
  if (filesChanged && filesChanged.length > 0) {
    entry += `\nFiles: ${filesChanged.join(', ')}`;
  }
  return entry;
}

/**
 * Derive a project path from a task ID by reading the task store.
 * Returns "{category}/{project}" if both exist, null otherwise.
 */
export function deriveProjectPath(taskId: string): string | null {
  try {
    if (!fs.existsSync(TASKS_FILE)) return null;

    const raw = fs.readFileSync(TASKS_FILE, 'utf-8');
    const store: TaskStore = JSON.parse(raw);

    const task = store.tasks.find((t: Task) => t.id.startsWith(taskId));
    if (!task) return null;

    if (task.category && task.project) {
      return `${task.category}/${task.project}`;
    }
    return null;
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

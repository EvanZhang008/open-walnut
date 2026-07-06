/**
 * Memory V2 file seeder utilities.
 *
 * Writes known files into the temp WALNUT_HOME directory structure
 * so that QMD stores can index them for real E2E tests.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Seed a daily log file at memory/daily/{dateStr}.md
 */
export function seedDailyLog(baseDir: string, dateStr: string, content: string): string {
  const filepath = path.join(baseDir, 'memory', 'daily', `${dateStr}.md`);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

/**
 * Seed a topic file at memory/topics/{filename}.md
 */
export function seedTopicFile(baseDir: string, filename: string, content: string): string {
  const filepath = path.join(baseDir, 'memory', 'topics', `${filename}.md`);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

/**
 * Seed a project memory file at memory/projects/{category}/{project}/MEMORY.md
 */
export function seedProjectMemory(
  baseDir: string,
  category: string,
  project: string,
  content: string,
): string {
  const filepath = path.join(baseDir, 'memory', 'projects', category, project, 'MEMORY.md');
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

/**
 * Seed a compaction file at memory/compaction/{filename}.md
 */
export function seedCompactionFile(baseDir: string, filename: string, content: string): string {
  const filepath = path.join(baseDir, 'memory', 'compaction', `${filename}.md`);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

/**
 * Seed the working memory file at memory/working-memory.md
 */
export function seedWorkingMemory(baseDir: string, content: string): string {
  const filepath = path.join(baseDir, 'memory', 'working-memory.md');
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

/**
 * Seed the memory index at memory/index.md
 */
export function seedMemoryIndex(baseDir: string, content: string): string {
  const filepath = path.join(baseDir, 'memory', 'index.md');
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

/**
 * Seed the global memory file at memory/MEMORY.md (2026-07 unification).
 * Global memory is a bounded "## Title" entry store — renderForPrompt() only
 * emits entry content, so plain text is wrapped in an entry heading.
 */
export function seedGlobalMemory(baseDir: string, content: string): string {
  const filepath = path.join(baseDir, 'memory', 'MEMORY.md');
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  const body = content.trimStart().startsWith('## ') ? content : `## Seeded entry\n${content}`;
  fs.writeFileSync(filepath, body, 'utf-8');
  return filepath;
}

/**
 * Seed a notes file at notes/{area}/{filename}.md
 */
export function seedNotesFile(
  baseDir: string,
  area: string,
  filename: string,
  content: string,
): string {
  const filepath = path.join(baseDir, 'notes', area, `${filename}.md`);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

/**
 * Seed sessions.json with an array of session objects.
 */
export function seedSessionsJson(
  baseDir: string,
  sessions: Array<{ startedAt?: string; created_at?: string; [key: string]: unknown }>,
): string {
  const filepath = path.join(baseDir, 'sessions.json');
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify({ sessions }), 'utf-8');
  return filepath;
}

/**
 * Seed dream state file at memory/.dream-state.json
 */
export function seedDreamState(baseDir: string, lastDreamAt: string): string {
  const filepath = path.join(baseDir, 'memory', '.dream-state.json');
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, JSON.stringify({ lastDreamAt }), 'utf-8');
  return filepath;
}

/**
 * Seed a session memory file at memory/sessions/{filename}.md
 */
export function seedSessionMemory(baseDir: string, filename: string, content: string): string {
  const filepath = path.join(baseDir, 'memory', 'sessions', `${filename}.md`);
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

/**
 * Helper: generate a date string N days ago from today (local timezone).
 * Uses the same format as formatDateKey() in daily-log.ts to avoid UTC/local mismatch.
 */
export function daysAgoStr(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

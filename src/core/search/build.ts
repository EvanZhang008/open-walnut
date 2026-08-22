/**
 * Full search-index build: walk all five doc sources and feed the hybrid-search
 * core. Used by the eval runner (temp-dir builds against live data) and by the
 * one-time backfill when the v2 index first appears on a host.
 *
 * NEVER pointed at the production search.sqlite by the eval runner — callers
 * pass an explicit dbPath.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  createSearchIndex,
  type Doc,
  type IndexStats,
  type LogFn,
} from '../../lib/hybrid-search/index.js';
import { GLOBAL_SKILLS_DIR, MEMORY_DIR, NOTES_DIR } from '../../constants.js';
import { listTasks } from '../task-manager.js';
import { listSessions } from '../session-tracker.js';
import { readSessionHistoryTail } from '../session-history.js';
import { buildIndexedContent } from '../session-content-indexer.js';
import { markdownToDoc, sessionToDoc, taskToDoc } from './serializers.js';
import type { SessionRecord, Task } from '../types.js';

export interface BuildOptions {
  dbPath: string;
  /** Read session JSONL bodies (the expensive part). Default true; the eval
   *  runner and tests can turn it off for metadata-only speed. */
  includeSessionContent?: boolean;
  /** Parallel session-content reads. Default 8. */
  concurrency?: number;
  /** Local-only tail read budget per session. */
  sessionTailBytes?: number;
  logger?: LogFn;
  onProgress?: (done: number, total: number, stage: string) => void;
}

export interface BuildResult {
  stats: IndexStats;
  inserted: number;
  ms: number;
}

const SESSION_CONTENT_TIMEOUT_MS = 20_000;

async function* walkMarkdown(root: string): AsyncGenerator<{ absPath: string; mtimeMs: number }> {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return; // missing root = empty kind
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkMarkdown(absPath);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      try {
        const stat = await fsp.stat(absPath);
        yield { absPath, mtimeMs: stat.mtimeMs };
      } catch {
        // deleted mid-walk
      }
    }
  }
}

async function fileDoc(
  kind: 'memory' | 'note' | 'skill',
  absPath: string,
  mtimeMs: number,
): Promise<Doc | null> {
  try {
    const raw = await fsp.readFile(absPath, 'utf8');
    return markdownToDoc(kind, absPath, raw, mtimeMs);
  } catch {
    return null;
  }
}

/** Notes vault excludes global-notes.md (matches the old QMD collection). */
function isIndexableNote(absPath: string): boolean {
  return path.basename(absPath) !== 'global-notes.md';
}

async function readSessionBody(
  session: SessionRecord,
  tailBytes: number | undefined,
): Promise<{ body: string | null; commitShas?: string[] }> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const messages = await Promise.race([
      readSessionHistoryTail(
        session.claudeSessionId,
        session.cwd,
        session.host,
        session.outputFile,
        tailBytes,
      ),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('content read timeout')),
          SESSION_CONTENT_TIMEOUT_MS,
        );
      }),
    ]);
    if (!messages || messages.length === 0) return { body: null };
    const { body, commitShas } = buildIndexedContent(messages);
    return { body: body || null, commitShas };
  } catch {
    return { body: null };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Stream every indexable doc. Session content reads (the slow part) run in
 * bounded-parallel chunks, and docs are YIELDED rather than collected — the
 * first full-corpus build held 3.2 GB RSS when everything sat in one array.
 */
export async function* iterateAllDocs(options: {
  includeSessionContent?: boolean;
  concurrency?: number;
  sessionTailBytes?: number;
  onProgress?: BuildOptions['onProgress'];
}): AsyncGenerator<Doc> {
  const onProgress = options.onProgress ?? (() => {});

  const tasks = await listTasks();
  const taskById = new Map<string, Task>(tasks.map((t) => [t.id, t]));
  let taskCount = 0;
  for (const task of tasks) {
    const doc = taskToDoc(task);
    if (doc) { taskCount++; yield doc; }
  }
  onProgress(taskCount, taskCount, 'tasks');

  const sessions = await listSessions();
  const indexable = sessions.filter((s) => Boolean(s.claudeSessionId));
  const chunkSize = Math.max(1, options.concurrency ?? 8);
  for (let i = 0; i < indexable.length; i += chunkSize) {
    const chunk = indexable.slice(i, i + chunkSize);
    const docs = await Promise.all(chunk.map(async (session) => {
      const linkedTask = session.taskId ? taskById.get(session.taskId) : undefined;
      const content = options.includeSessionContent === false
        ? { body: null as string | null }
        : await readSessionBody(session, options.sessionTailBytes);
      return sessionToDoc({
        session,
        task: linkedTask,
        body: content.body,
        commitShas: (content as { commitShas?: string[] }).commitShas,
      });
    }));
    for (const doc of docs) if (doc) yield doc;
    if ((i / chunkSize) % 25 === 0) onProgress(i, indexable.length, 'sessions');
  }

  for (const [kind, root, filter] of [
    ['memory', MEMORY_DIR, () => true],
    ['note', NOTES_DIR, isIndexableNote],
    ['skill', GLOBAL_SKILLS_DIR, () => true],
  ] as Array<['memory' | 'note' | 'skill', string, (p: string) => boolean]>) {
    let count = 0;
    for await (const file of walkMarkdown(root)) {
      if (!filter(file.absPath)) continue;
      const doc = await fileDoc(kind, file.absPath, file.mtimeMs);
      if (doc) { count++; yield doc; }
    }
    onProgress(count, count, kind);
  }
}

export async function buildFullSearchIndex(options: BuildOptions): Promise<BuildResult> {
  const t0 = performance.now();
  const index = createSearchIndex({ dbPath: options.dbPath, logger: options.logger });
  try {
    const { inserted } = await index.rebuildAll(iterateAllDocs(options));
    return {
      stats: index.stats(),
      inserted,
      ms: Math.round(performance.now() - t0),
    };
  } finally {
    index.close();
  }
}

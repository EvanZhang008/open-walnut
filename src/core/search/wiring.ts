/**
 * Search v2 wiring: the walnut-side lifecycle of the hybrid-search index.
 *
 * Gated on WALNUT_SEARCH_V2=1 (default off while QMD double-runs). When on:
 *   - one index handle per process (~/.open-walnut/search.sqlite)
 *   - event-bus driven incremental upserts (tasks + sessions), reusing the
 *     debounce/generation/cooldown queue the QMD path proved out
 *   - a startup backfill when the index is empty/gate-wiped, plus a periodic
 *     mtime-based sweep for the file kinds (memory/note/skill)
 *
 * Index writes are inline in the web process ON PURPOSE: single-doc upsert is
 * ~0.5ms and the tokenizer runs at ~48 Mchar/s, so there is nothing to fork
 * for (the QMD child-process indexer existed because QMD writes were
 * seconds-long native calls). The one long operation — the first full
 * backfill — streams via async iterators, so the event loop breathes between
 * batches.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  createSearchIndex,
  type ScoredHit,
  type SearchIndex,
} from '../../lib/hybrid-search/index.js';
import { GLOBAL_SKILLS_DIR, MEMORY_DIR, NOTES_DIR, WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { createQmdIncrementalQueue, type QmdIncrementalQueue } from '../qmd-incremental-queue.js';
import { EventNames, type EventBus } from '../event-bus.js';
import { listTasks } from '../task-manager.js';
import { listSessions } from '../session-tracker.js';
import { markdownToDoc, sessionToDoc, taskToDoc } from './serializers.js';
import { iterateAllDocs, readSessionBody } from './build.js';

export const SEARCH_V2_KIND_WEIGHTS = {
  task: { weight: 1.0 },
  memory: { weight: 1.1 },
  session: { weight: 0.9 },
  note: { weight: 1.0 },
  skill: { weight: 1.0 },
} as const;

export function isSearchV2Enabled(): boolean {
  return process.env.WALNUT_SEARCH_V2 === '1'
    && process.env.WALNUT_DISABLE_SEARCH !== '1';
}

let handle: SearchIndex | null = null;

export function getSearchV2Index(): SearchIndex {
  if (!handle) {
    handle = createSearchIndex({
      dbPath: path.join(WALNUT_HOME, 'search.sqlite'),
      kinds: SEARCH_V2_KIND_WEIGHTS,
      logger: (level, msg, data) => log.memory[level](msg, data),
    });
  }
  return handle;
}

/** Test hook: drop the singleton so a fresh WALNUT_HOME gets a fresh index. */
export function resetSearchV2IndexForTests(): void {
  try { handle?.close(); } catch { /* already closed */ }
  handle = null;
}

export interface SearchV2Hit extends ScoredHit {
  /** Raw doc text (title+summary+note) for snippet extraction by the caller. */
  text: string;
}

/** Keyword lane for walnut callers: hits + raw text for snippets. */
export function searchV2Lane(
  query: string,
  options: { kinds?: string[]; limit?: number } = {},
): SearchV2Hit[] {
  const index = getSearchV2Index();
  const hits = index.search(query, {
    kinds: options.kinds,
    limit: options.limit,
  });
  return hits.map((hit) => {
    const doc = index.getDoc(hit.kind, hit.ref);
    const text = doc ? [doc.title, doc.summary, doc.note].filter(Boolean).join('\n') : hit.title;
    return { ...hit, text };
  });
}

// ── incremental sync ──

async function syncTasks(taskIds: string[]): Promise<void> {
  const index = getSearchV2Index();
  const wanted = new Set(taskIds);
  const present = new Map(
    (await listTasks()).filter((t) => wanted.has(t.id)).map((t) => [t.id, t]),
  );
  for (const taskId of taskIds) {
    const task = present.get(taskId);
    const doc = task ? taskToDoc(task) : null;
    // Deleted AND junk-classified tasks both leave the index.
    if (doc) index.upsert(doc);
    else index.remove('task', taskId);
  }
}

async function syncSessions(sessionIds: string[]): Promise<void> {
  const index = getSearchV2Index();
  const wanted = new Set(sessionIds);
  const sessions = (await listSessions()).filter((s) => wanted.has(s.claudeSessionId));
  const tasks = await listTasks();
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  for (const session of sessions) {
    seen.add(session.claudeSessionId);
    const linkedTask = session.taskId ? taskById.get(session.taskId) : undefined;
    const content = await readSessionBody(session);
    const doc = sessionToDoc({
      session,
      task: linkedTask,
      body: content.body,
      commitShas: content.commitShas,
    });
    if (doc) index.upsert(doc);
    else index.remove('session', session.claudeSessionId);
  }
  for (const sessionId of sessionIds) {
    if (!seen.has(sessionId)) index.remove('session', sessionId);
  }
}

/** mtime-based sweep of the file kinds. Stat-only when nothing changed. */
export async function sweepSearchV2Files(): Promise<{ changed: number; removed: number }> {
  const index = getSearchV2Index();
  let changed = 0;
  let removed = 0;
  for (const [kind, root] of [
    ['memory', MEMORY_DIR],
    ['note', NOTES_DIR],
    ['skill', GLOBAL_SKILLS_DIR],
  ] as Array<['memory' | 'note' | 'skill', string]>) {
    const stored = new Map(
      (index.db.prepare(`SELECT ref, updated_at FROM doc WHERE kind = ?`)
        .all(kind) as Array<{ ref: string; updated_at: number }>)
        .map((r) => [r.ref, r.updated_at]),
    );
    for await (const file of walkMd(root)) {
      if (kind === 'note' && path.basename(file.absPath) === 'global-notes.md') continue;
      const prev = stored.get(file.absPath);
      stored.delete(file.absPath);
      if (prev !== undefined && Math.abs(prev - file.mtimeMs) < 1) continue;
      try {
        const raw = await fsp.readFile(file.absPath, 'utf8');
        index.upsert(markdownToDoc(kind, file.absPath, raw, file.mtimeMs));
        changed++;
      } catch { /* deleted mid-sweep — the leftover branch below removes it */ }
    }
    for (const staleRef of stored.keys()) {
      index.remove(kind, staleRef);
      removed++;
    }
  }
  return { changed, removed };
}

async function* walkMd(root: string): AsyncGenerator<{ absPath: string; mtimeMs: number }> {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const absPath = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walkMd(absPath);
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      try {
        const stat = await fsp.stat(absPath);
        yield { absPath, mtimeMs: stat.mtimeMs };
      } catch { /* deleted mid-walk */ }
    }
  }
}

// ── lifecycle ──

const FILE_SWEEP_INTERVAL_MS = 10 * 60_000;
const SESSION_REEMBED_MIN_INTERVAL_MS = 10 * 60_000;
const DEBOUNCE_MS = 2_000;

export interface SearchV2Wiring {
  stop(): Promise<void>;
}

/**
 * Subscribe incremental sync to the event bus and schedule backfill + sweeps.
 * Caller (server startup) checks isSearchV2Enabled() first.
 */
export function startSearchV2Wiring(bus: EventBus): SearchV2Wiring {
  const index = getSearchV2Index();

  const taskQueue: QmdIncrementalQueue = createQmdIncrementalQueue({
    debounceMs: DEBOUNCE_MS,
    dispatch: (ids) => syncTasks(ids),
    onError: (err, retryInMs) => log.memory.warn('search-v2 task sync failed; retry scheduled', {
      error: err instanceof Error ? err.message : String(err), retryInMs,
    }),
  });
  // Same cooldown rationale as the QMD queue: an active session fires
  // session:result every turn and each flush re-reads its transcript tail.
  const sessionQueue: QmdIncrementalQueue = createQmdIncrementalQueue({
    debounceMs: DEBOUNCE_MS,
    minIntervalMs: SESSION_REEMBED_MIN_INTERVAL_MS,
    dispatch: (ids) => syncSessions(ids),
    onError: (err, retryInMs) => log.memory.warn('search-v2 session sync failed; retry scheduled', {
      error: err instanceof Error ? err.message : String(err), retryInMs,
    }),
  });

  bus.subscribe('search-v2-task-sync', (event) => {
    if (event.name === EventNames.TASK_CREATED
      || event.name === EventNames.TASK_UPDATED
      || event.name === EventNames.TASK_COMPLETED) {
      const data = event.data as { task?: { id?: string } | null; taskIds?: string[] };
      for (const taskId of data.task?.id ? [data.task.id] : data.taskIds ?? []) {
        if (taskId) taskQueue.enqueue(taskId, 'sync');
      }
    } else if (event.name === EventNames.TASK_DELETED) {
      const taskId = (event.data as { task?: { id?: string } })?.task?.id;
      if (taskId) taskQueue.enqueue(taskId, 'delete');
    }
  }, { global: true, interest: ['task:created', 'task:updated', 'task:completed', 'task:deleted'] });

  bus.subscribe('search-v2-session-sync', (event) => {
    if (event.name === EventNames.SESSION_DELETED) {
      for (const sessionId of (event.data as { sessionIds?: string[] })?.sessionIds ?? []) {
        sessionQueue.enqueue(sessionId, 'delete');
      }
    } else if (event.name === EventNames.SESSION_STARTED
      || event.name === EventNames.SESSION_CONTENT_UPDATED
      || event.name === EventNames.SESSION_RESULT
      || event.name === EventNames.SESSION_ERROR) {
      const sessionId = (event.data as { sessionId?: string })?.sessionId;
      if (sessionId) sessionQueue.enqueue(sessionId, 'sync');
    }
  }, {
    global: true,
    interest: ['session:started', 'session:content-updated', 'session:deleted', 'session:result', 'session:error'],
  });

  // Backfill when empty (first run / version-gate wipe); otherwise just sweep
  // files. Delayed off the startup critical path.
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  const backfillTimer = setTimeout(() => {
    void (async () => {
      try {
        if (index.stats().docs === 0) {
          log.memory.info('search-v2 backfill starting (empty index)');
          const t0 = Date.now();
          const { inserted } = await index.rebuildAll(iterateAllDocs({}));
          log.memory.info('search-v2 backfill complete', { inserted, ms: Date.now() - t0 });
        } else {
          const swept = await sweepSearchV2Files();
          if (swept.changed || swept.removed) {
            log.memory.info('search-v2 file sweep', swept);
          }
        }
      } catch (err) {
        log.memory.warn('search-v2 backfill/sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      sweepTimer = setInterval(() => {
        void sweepSearchV2Files().catch((err) => {
          log.memory.warn('search-v2 file sweep failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }, FILE_SWEEP_INTERVAL_MS);
      sweepTimer.unref?.();
    })();
  }, 15_000);
  backfillTimer.unref?.();

  return {
    async stop() {
      clearTimeout(backfillTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      bus.unsubscribe('search-v2-task-sync');
      bus.unsubscribe('search-v2-session-sync');
      await Promise.all([taskQueue.stop(), sessionQueue.stop()]);
    },
  };
}

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

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createSearchIndex,
  type EmbedderConfig,
  type MissingVecCursor,
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
  // Transcripts get per-passage vectors: one 50KB mean-pool buries the 2% of
  // the text that answers the query.
  session: { weight: 0.9, chunkVectors: true },
  note: { weight: 1.0 },
  skill: { weight: 1.0 },
} as const;

export function isSearchV2Enabled(): boolean {
  return process.env.WALNUT_SEARCH_V2 === '1'
    && process.env.WALNUT_DISABLE_SEARCH !== '1';
}

/** Known embedding models (Q2 in the plan: golden-set Chinese recall decides
 *  between them; the env override exists so the eval can flip without code). */
const EMBED_MODELS: Record<string, Omit<EmbedderConfig, 'workerPath'>> = {
  'e5-small': {
    modelId: 'Xenova/multilingual-e5-small',
    dims: 384,
    queryPrefix: 'query: ',
    passagePrefix: 'passage: ',
  },
  // A/B alternative (plan Q2): stronger cross-lingual/typo discrimination in
  // probes, ~30x slower passage embedding (209ms vs 7ms) — measured 2026-08-23.
  'qwen3-0.6b': {
    modelId: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    dims: 1024,
    queryPrefix: 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ',
    passagePrefix: '',
    pooling: 'last',
  },
};

function resolveEmbedWorkerPath(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Bundled: this module lives inside a dist entry — dist/web/server.js (one
  // level up from dist/lib) or dist/cli.js (same level: argv[1] candidate).
  // Un-bundled (tsx/vitest): under src/core/search/. Workers can't run .ts,
  // so every candidate points at the tsup-built dist file.
  const entryDir = process.argv[1] ? path.dirname(process.argv[1]) : undefined;
  const candidates = [
    path.join(here, '..', 'lib', 'hybrid-search', 'embed-worker.js'),
    ...(entryDir ? [path.join(entryDir, 'lib', 'hybrid-search', 'embed-worker.js')] : []),
    path.join(here, '..', '..', '..', 'dist', 'lib', 'hybrid-search', 'embed-worker.js'),
    path.join(process.cwd(), 'dist', 'lib', 'hybrid-search', 'embed-worker.js'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

function buildEmbedderConfig(): EmbedderConfig | undefined {
  if (process.env.WALNUT_SEARCH_V2_SEMANTIC === '0') return undefined;
  const model = EMBED_MODELS[process.env.WALNUT_SEARCH_V2_EMBED_MODEL ?? 'e5-small'];
  if (!model) return undefined;
  const workerPath = resolveEmbedWorkerPath();
  if (!workerPath) {
    log.memory.warn('search-v2: embed worker not built — keyword-only until next build');
    return undefined;
  }
  // Model cache OUTSIDE node_modules: the transformers.js default cache dir
  // lives inside the package, so every `npm ci` silently discarded the 129MB
  // model and the next search re-downloaded it inside the web server.
  return { ...model, workerPath, cacheDir: path.join(WALNUT_HOME, 'models') };
}

let handle: SearchIndex | null = null;

export function getSearchV2Index(): SearchIndex {
  if (!handle) {
    handle = createSearchIndex({
      dbPath: path.join(WALNUT_HOME, 'search.sqlite'),
      kinds: SEARCH_V2_KIND_WEIGHTS,
      embedder: buildEmbedderConfig(),
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

/** Hybrid lane for walnut callers: keyword lanes + deadline-bounded semantic
 *  rescore (degrades to keyword order), plus raw doc text for snippets. */
export async function searchV2Lane(
  query: string,
  options: { kinds?: string[]; limit?: number; semanticDeadlineMs?: number } = {},
): Promise<SearchV2Hit[]> {
  const index = getSearchV2Index();
  const hits = await index.searchSemantic(query, {
    kinds: options.kinds,
    limit: options.limit,
    semanticDeadlineMs: options.semanticDeadlineMs,
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
  let vecTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // Vector backfill: paced batches so a fresh index (~12k docs) embeds over
  // minutes of idle capacity, never in one event-loop-adjacent burst. The
  // heavy work happens in the embed worker thread; the host side rides the
  // keyset cursor (one index walk per DRAIN, not a full table scan per batch
  // — the batches run on the production server's one event loop). A fresh
  // pass (cursor null) starts after each drain: upsert() drops a changed
  // doc's vectors, so the periodic pass re-embeds whatever went missing.
  const VEC_BATCH_PAUSE_MS = 100;
  let vecTotal = 0;
  let vecCursor: MissingVecCursor | null = null;
  const scheduleVectorBackfill = (delayMs: number) => {
    if (stopped) return;
    vecTimer = setTimeout(() => {
      void (async () => {
        try {
          const { embedded, drained, cursor } = await index.backfillVectors({
            batchDocs: 16, cursor: vecCursor,
          });
          vecCursor = cursor;
          vecTotal += embedded;
          if (drained) {
            if (vecTotal > 0) log.memory.info('search-v2 vector backfill drained', { embedded: vecTotal });
            vecTotal = 0;
            vecCursor = null; // next pass rescans from the top (self-heal)
            scheduleVectorBackfill(FILE_SWEEP_INTERVAL_MS);
            return;
          }
          if (vecTotal > 0 && vecTotal % 800 < 16) {
            log.memory.info('search-v2 vector backfill progress', { embedded: vecTotal });
          }
          scheduleVectorBackfill(VEC_BATCH_PAUSE_MS);
        } catch (err) {
          log.memory.warn('search-v2 vector backfill failed — retrying next sweep interval', {
            error: err instanceof Error ? err.message : String(err),
          });
          vecCursor = null;
          scheduleVectorBackfill(FILE_SWEEP_INTERVAL_MS);
        }
      })();
    }, delayMs);
    vecTimer.unref?.();
  };

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
      scheduleVectorBackfill(VEC_BATCH_PAUSE_MS);
    })();
  }, 15_000);
  backfillTimer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearTimeout(backfillTimer);
      if (vecTimer) clearTimeout(vecTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      bus.unsubscribe('search-v2-task-sync');
      bus.unsubscribe('search-v2-session-sync');
      await Promise.all([taskQueue.stop(), sessionQueue.stop()]);
    },
  };
}

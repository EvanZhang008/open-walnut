/**
 * QMD store singletons for memory, notes, task, and session search.
 *
 * WHY 4 SEPARATE STORES: Each store has its own SQLite DB to avoid noisy-neighbor
 * problems at scale. Memory docs change constantly (daily logs); re-embedding them
 * would block task/session queries if they shared a DB. Separate DBs also let us
 * tune per-store (e.g. force re-embed notes without touching tasks).
 *
 * Four QMD instances:
 * - memoryStore: daily logs, topics, projects, repos, compaction, global memory, sessions
 * - notesStore: Obsidian vault areas, projects, resources, archive
 * - taskStore: tasks (programmatic insertion from tasks.json)
 * - sessionStore: claude code sessions (programmatic insertion from sessions.json)
 */
import { createStore, type QMDStore } from '@tobilu/qmd';
import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { WALNUT_HOME, MEMORY_DIR, NOTES_DIR, GLOBAL_SKILLS_DIR } from '../constants.js';
import fs from 'node:fs';
import path from 'node:path';
import { log } from '../logging/index.js';
import {
  BGE_M3_EMBEDDING_MODEL,
  DEFAULT_QMD_MODEL,
  EMBEDDING_GEMMA_MODEL,
  initializeQmdRuntimeModel,
  QWEN3_EMBEDDING_MODEL,
} from './qmd-model.js';

/** Default embedding model URI - shared with the QMD route and settings UI. */
export { DEFAULT_QMD_MODEL } from './qmd-model.js';
const KNOWN_QMD_MODEL_DIMENSIONS: Readonly<Record<string, number>> = {
  [QWEN3_EMBEDDING_MODEL]: 1024,
  [EMBEDDING_GEMMA_MODEL]: 768,
  [BGE_M3_EMBEDDING_MODEL]: 1024,
};
const EMBED_RUN_TABLE = 'walnut_qmd_embed_runs';
const QMD_DB_FILES = [
  'memory-search.sqlite',
  'notes-search.sqlite',
  'task-search.sqlite',
  'session-search.sqlite',
] as const;

type QmdEmbedOptions = NonNullable<Parameters<QMDStore['embed']>[0]>;
type QmdEmbedResult = Awaited<ReturnType<QMDStore['embed']>>;

interface PersistedEmbedRun {
  force: number;
  hashes_json: string;
  model: string;
  started_at: string;
}

/**
 * Detect whether startup must close Web-process stores and block reads while
 * the worker rebuilds vectors. Ordinary same-model reconciliation stays fully
 * readable through WAL.
 */
export function qmdStoresRequireModelReset(currentModel: string): boolean {
  const expectedDimensions = KNOWN_QMD_MODEL_DIMENSIONS[currentModel];

  for (const filename of QMD_DB_FILES) {
    const dbPath = path.join(WALNUT_HOME, filename);
    if (!fs.existsSync(dbPath)) continue;

    let db: DatabaseType | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const hasVectors = Boolean(db.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'content_vectors'",
      ).get());
      if (!hasVectors) continue;

      const stored = db.prepare(
        'SELECT model FROM content_vectors WHERE model <> ? LIMIT 1',
      ).get(currentModel) as { model?: string } | undefined;
      if (stored?.model) {
        log.memory.info('QMD startup requires exclusive model migration', {
          store: filename,
          storedModel: stored.model,
          currentModel,
        });
        return true;
      }

      if (expectedDimensions !== undefined) {
        const schema = db.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vectors_vec'",
        ).get() as { sql?: string | null } | undefined;
        const match = schema?.sql?.match(/\bembedding\s+float\[(\d+)\]/i);
        const storedDimensions = match?.[1]
          ? Number.parseInt(match[1], 10)
          : null;
        if (
          storedDimensions !== null
          && storedDimensions !== expectedDimensions
        ) {
          log.memory.info('QMD startup requires exclusive dimension migration', {
            store: filename,
            storedDimensions,
            expectedDimensions,
          });
          return true;
        }
      }
    } catch (error) {
      // If compatibility cannot be proven, prefer a guarded rebuild over
      // exposing readers to a possible vector-schema replacement.
      log.memory.warn('QMD startup compatibility inspection failed', {
        store: filename,
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    } finally {
      db?.close();
    }
  }
  return false;
}

function ensureEmbedRunTable(store: QMDStore): void {
  store.internal.db.exec(`
    CREATE TABLE IF NOT EXISTS ${EMBED_RUN_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      model TEXT NOT NULL,
      force INTEGER NOT NULL,
      hashes_json TEXT NOT NULL,
      started_at TEXT NOT NULL
    )
  `);
}

function readPersistedEmbedRun(store: QMDStore): PersistedEmbedRun | null {
  const row = store.internal.db.prepare(`
    SELECT force, hashes_json, model, started_at
    FROM ${EMBED_RUN_TABLE}
    WHERE id = 1
  `).get() as PersistedEmbedRun | undefined;
  return row ?? null;
}

function deletePersistedEmbedRun(store: QMDStore): void {
  store.internal.db.prepare(
    `DELETE FROM ${EMBED_RUN_TABLE} WHERE id = 1`,
  ).run();
}

function clearEmbeddingHashes(store: QMDStore, hashes: readonly string[]): void {
  const uniqueHashes = [...new Set(hashes.filter(Boolean))];
  if (uniqueHashes.length === 0) return;

  const hasVectorTable = Boolean(store.internal.db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vectors_vec'",
  ).get());

  // Bound the number of SQLite parameters and preserve the QMD-required
  // vectors_vec-before-content_vectors deletion order.
  for (let offset = 0; offset < uniqueHashes.length; offset += 500) {
    const batch = uniqueHashes.slice(offset, offset + 500);
    const placeholders = batch.map(() => '?').join(', ');
    if (hasVectorTable) {
      store.internal.db.prepare(`
        DELETE FROM vectors_vec
        WHERE hash_seq IN (
          SELECT hash || '_' || seq
          FROM content_vectors
          WHERE hash IN (${placeholders})
        )
      `).run(...batch);
    }
    store.internal.db.prepare(
      `DELETE FROM content_vectors WHERE hash IN (${placeholders})`,
    ).run(...batch);
  }
}

function clearInterruptedEmbedRun(
  store: QMDStore,
  run: PersistedEmbedRun,
): void {
  if (run.force === 1) {
    store.internal.clearAllEmbeddings();
    return;
  }

  try {
    const hashes = JSON.parse(run.hashes_json) as unknown;
    if (!Array.isArray(hashes) || !hashes.every((hash) => typeof hash === 'string')) {
      throw new Error('invalid hash list');
    }
    clearEmbeddingHashes(store, hashes);
  } catch {
    // A corrupt recovery marker cannot prove which vectors are complete.
    store.internal.clearAllEmbeddings();
  }
}

/**
 * Run QMD embedding with a durable recovery marker.
 *
 * QMD treats seq=0 as proof that an entire document is embedded. A process
 * exit after writing seq=0 can therefore strand missing later chunks forever.
 * The marker records every hash touched by a pass so the next pass removes
 * only those potentially partial vectors before retrying.
 */
export async function embedQmdStore(
  store: QMDStore,
  label: string,
  options: QmdEmbedOptions,
): Promise<QmdEmbedResult> {
  ensureEmbedRunTable(store);

  const interrupted = readPersistedEmbedRun(store);
  if (interrupted) {
    log.agent.warn(`QMD ${label}: recovering interrupted embedding pass`, {
      model: interrupted.model,
      startedAt: interrupted.started_at,
      force: interrupted.force === 1,
    });
    clearInterruptedEmbedRun(store, interrupted);
    deletePersistedEmbedRun(store);
  }

  const hashes = options.force
    ? []
    : store.internal.getHashesForEmbedding().map((row) => row.hash);
  store.internal.db.prepare(`
    INSERT OR REPLACE INTO ${EMBED_RUN_TABLE}
      (id, model, force, hashes_json, started_at)
    VALUES (1, ?, ?, ?, ?)
  `).run(
    options.model ?? DEFAULT_QMD_MODEL,
    options.force ? 1 : 0,
    JSON.stringify(hashes),
    new Date().toISOString(),
  );

  const result = await store.embed(options);
  if (result.errors > 0) {
    const failedRun = readPersistedEmbedRun(store);
    if (failedRun) clearInterruptedEmbedRun(store, failedRun);
    throw new Error(
      `QMD ${label}: embedding failed for ${result.errors} chunk(s); partial vectors cleared for retry`,
    );
  }

  deletePersistedEmbedRun(store);
  return result;
}

let memoryStore: QMDStore | null = null;
let memoryStorePromise: Promise<QMDStore> | null = null;
let notesStore: QMDStore | null = null;
let notesStorePromise: Promise<QMDStore> | null = null;
let taskStore: QMDStore | null = null;
let taskStorePromise: Promise<QMDStore> | null = null;
let sessionStore: QMDStore | null = null;
let sessionStorePromise: Promise<QMDStore> | null = null;

export async function getMemoryStore(): Promise<QMDStore> {
  if (memoryStore) return memoryStore;
  if (!memoryStorePromise) {
    const model = await initializeQmdRuntimeModel();
    if (memoryStore) return memoryStore;
    if (memoryStorePromise) return memoryStorePromise;
    memoryStorePromise = createStore({
      dbPath: path.join(WALNUT_HOME, 'memory-search.sqlite'),
      config: {
        models: { embed: model },
        collections: {
          daily:      { path: path.join(MEMORY_DIR, 'daily'),      pattern: '**/*.md' },
          topic:      { path: path.join(MEMORY_DIR, 'topics'),     pattern: '**/*.md' },
          project:    { path: path.join(MEMORY_DIR, 'projects'),   pattern: '**/*.md' },
          repo:       { path: path.join(MEMORY_DIR, 'repos'),      pattern: '**/*.md' },
          compaction: { path: path.join(MEMORY_DIR, 'compaction'),  pattern: '**/*.md' },
          // MEMORY.md moved into memory/ (2026-07 unification; init.ts migrates).
          global:     { path: MEMORY_DIR,                           pattern: 'MEMORY.md' },
          session:    { path: path.join(MEMORY_DIR, 'sessions'),    pattern: '**/*.md' },
          // Skills index (flat + categorized layouts). Feeds the per-turn
          // "Possibly relevant skills" prefetch hint (memory-search.ts).
          // Pattern covers ALL md under skills/ — SKILL.md bodies plus support
          // files (references/*.md, overview history/ log volumes, templates).
          // This IS the project-history search story: overview history logs
          // are plain md, searched here — no separate FTS db for them.
          skill:      { path: GLOBAL_SKILLS_DIR,                     pattern: '**/*.md' },
        },
      },
    }).then(store => {
      memoryStore = store;
      memoryStorePromise = null;
      return store;
    }).catch(err => {
      memoryStorePromise = null;
      throw err;
    });
  }
  return memoryStorePromise;
}

export async function getNotesStore(): Promise<QMDStore> {
  if (notesStore) return notesStore;
  if (!notesStorePromise) {
    const model = await initializeQmdRuntimeModel();
    if (notesStore) return notesStore;
    if (notesStorePromise) return notesStorePromise;
    notesStorePromise = createStore({
      dbPath: path.join(WALNUT_HOME, 'notes-search.sqlite'),
      config: {
        models: { embed: model },
        // ONE whole-vault collection (was 4 PARA folders). This is the semantic
        // side of the hybrid notes search; notes anywhere in the vault are now
        // embedded. The reconciler drives this store ONE changed file at a time
        // (notes-indexer.ts). QMD's glob-based store.update() is never used because
        // it would generate different virtual paths and duplicate every note.
        // BEHAVIOR CHANGE: notes outside Areas/Projects/Resources/Archive are now
        // searchable, and the old Archive exclusion + resource/archive down-weight
        // are dropped (collapsed to a single note_vault weight in memory-search.ts).
        collections: {
          vault: { path: NOTES_DIR, pattern: '**/*.md', ignore: ['global-notes.md', '.*/**'] },
        },
      },
    }).then(store => {
      notesStore = store;
      notesStorePromise = null;
      return store;
    }).catch(err => {
      notesStorePromise = null;
      throw err;
    });
  }
  return notesStorePromise;
}

/**
 * Task store — programmatic-only (no filesystem scanning).
 * Tasks are inserted via qmd-task-sync.ts from tasks.json.
 *
 * `__qmd_programmatic_only__` is a sentinel glob that matches zero files, so
 * store.update() is a no-op (tasks have no on-disk .md files). NEVER call
 * store.update() on this store — all data enters via insertContent/insertDocument.
 */
export async function getTaskStore(): Promise<QMDStore> {
  if (taskStore) return taskStore;
  if (!taskStorePromise) {
    const model = await initializeQmdRuntimeModel();
    if (taskStore) return taskStore;
    if (taskStorePromise) return taskStorePromise;
    taskStorePromise = createStore({
      dbPath: path.join(WALNUT_HOME, 'task-search.sqlite'),
      config: {
        models: { embed: model },
        collections: {
          tasks: { path: path.join(WALNUT_HOME, 'tasks'), pattern: '__qmd_programmatic_only__' },
        },
      },
    }).then(store => {
      taskStore = store;
      taskStorePromise = null;
      return store;
    }).catch(err => {
      taskStorePromise = null;
      throw err;
    });
  }
  return taskStorePromise;
}

/**
 * Session store — programmatic-only (no filesystem scanning).
 * Sessions are inserted via qmd-session-sync.ts from sessions.json.
 * Same sentinel pattern as taskStore — see comment above.
 */
export async function getSessionStore(): Promise<QMDStore> {
  if (sessionStore) return sessionStore;
  if (!sessionStorePromise) {
    const model = await initializeQmdRuntimeModel();
    if (sessionStore) return sessionStore;
    if (sessionStorePromise) return sessionStorePromise;
    sessionStorePromise = createStore({
      dbPath: path.join(WALNUT_HOME, 'session-search.sqlite'),
      config: {
        models: { embed: model },
        collections: {
          sessions: { path: path.join(WALNUT_HOME, 'sessions'), pattern: '__qmd_programmatic_only__' },
        },
      },
    }).then(store => {
      sessionStore = store;
      sessionStorePromise = null;
      return store;
    }).catch(err => {
      sessionStorePromise = null;
      throw err;
    });
  }
  return sessionStorePromise;
}

export interface InitQmdStoresOptions {
  force?: boolean;
  onProgress?: (
    store: string,
    progress: {
      chunksEmbedded: number;
      totalChunks: number;
      bytesProcessed: number;
      totalBytes: number;
    },
  ) => void;
}

export async function initQmdStores(options?: InitQmdStoresOptions): Promise<void> {
  // Keep the model explicit so every QMD store and the background worker share
  // the same URI. Existing model metadata and physical dimensions are checked
  // below; old 768d indexes are rebuilt automatically for the 1024d default.
  await initializeQmdRuntimeModel();

  log.agent.info('QMD: initializing stores...');
  // Eagerly open both store singletons at boot (notes is then driven per-file by
  // the reconciler — see updateAndEmbed group below — not via store.update()).
  const [mem] = await Promise.all([getMemoryStore(), getNotesStore()]);

  // embed() without force skips docs represented in content_vectors. Check both
  // its model metadata and sqlite-vec's physical dimensions before deciding
  // whether an existing index is reusable.
  function getStoredEmbedModel(store: QMDStore): string | null {
    try {
      const row = store.internal.db.prepare(
        'SELECT DISTINCT model FROM content_vectors LIMIT 1'
      ).get() as { model: string } | undefined;
      return row?.model ?? null;
    } catch {
      return null; // table doesn't exist yet = no vectors
    }
  }

  function getStoredVectorDimensions(store: QMDStore): number | null {
    try {
      const row = store.internal.db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vectors_vec'"
      ).get() as { sql?: string | null } | undefined;
      if (!row?.sql) return null;

      const match = row.sql.match(/\bembedding\s+float\[(\d+)\]/i);
      return match?.[1] ? Number.parseInt(match[1], 10) : null;
    } catch {
      return null;
    }
  }

  function getForceReason(store: QMDStore, currentModel: string): string | null {
    const storedModel = getStoredEmbedModel(store);
    if (storedModel && storedModel !== currentModel) {
      return `model mismatch: stored="${storedModel}", current="${currentModel}"`;
    }

    // Custom model dimensions are unknown until inference loads the model.
    // Keep physical-schema checks limited to models Walnut can identify.
    const expectedDimensions = KNOWN_QMD_MODEL_DIMENSIONS[currentModel];
    if (expectedDimensions !== undefined) {
      const storedDimensions = getStoredVectorDimensions(store);
      if (storedDimensions !== null && storedDimensions !== expectedDimensions) {
        return `vector dimension mismatch: stored=${storedDimensions}d, current=${expectedDimensions}d`;
      }
    }

    return null;
  }

  async function forceReembed(
    store: QMDStore,
    label: string,
    currentModel: string,
    onProgress: ((progress: {
      chunksEmbedded: number;
      totalChunks: number;
      bytesProcessed: number;
      totalBytes: number;
    }) => void) | undefined,
  ): Promise<void> {
    const result = await embedQmdStore(store, label, {
      force: true,
      model: currentModel,
      onProgress,
    });

    const expectedDimensions = KNOWN_QMD_MODEL_DIMENSIONS[currentModel];
    const storedDimensions = getStoredVectorDimensions(store);
    if (
      expectedDimensions !== undefined
      && result.chunksEmbedded > 0
      && storedDimensions !== expectedDimensions
    ) {
      store.internal.clearAllEmbeddings();
      throw new Error(
        `QMD ${label}: force re-embed left vector schema at ${storedDimensions ?? 'missing'}d; expected ${expectedDimensions}d; vectors cleared for retry`,
      );
    }
  }

  async function updateAndEmbed(store: QMDStore, label: string): Promise<void> {
    await store.update();

    const currentModel = process.env.QMD_EMBED_MODEL!;
    const forceReason = options?.force
      ? 'forced refresh requested'
      : getForceReason(store, currentModel);
    const onProgress = options?.onProgress
      ? (progress: { chunksEmbedded: number; totalChunks: number; bytesProcessed: number; totalBytes: number }) =>
          options.onProgress!(label, progress)
      : undefined;

    if (forceReason) {
      log.agent.warn(`QMD ${label}: ${forceReason}. Force re-embedding all documents.`);
      await forceReembed(store, label, currentModel, onProgress);
      const afterModel = getStoredEmbedModel(store);
      log.agent.info(`QMD ${label}: force re-embed complete, model now="${afterModel}"`);
    } else {
      await embedQmdStore(store, label, { model: currentModel, onProgress });
    }
  }

  // Memory store keeps the glob-driven store.update() path.
  await updateAndEmbed(mem, 'memory');

  // NOTES store is now driven PER-FILE by the structural reconciler
  // (notes-indexer.ts → insertContent/insertDocument keyed on the raw vault-relative
  // path), NOT by store.update(). Calling store.update() here would re-key every
  // note under QMD's handelize() (lowercased/slugified) path, DIVERGING from the
  // reconciler's raw-path keys → two documents per note + redundant re-embeds.
  // So notes joins the programmatic-store group: model-mismatch detection only,
  // no glob. The reconciler (kicked by initNotesIndex) populates + embeds per file.

  // Task, session, and notes stores are programmatic (no store.update()), but they
  // still need model mismatch detection. Without this, switching embedding models
  // leaves stale vectors with wrong dimensions → every search fails with
  // "Dimension mismatch for query vector" and returns zero results silently.
  async function checkAndReembed(storeFn: () => Promise<QMDStore>, label: string): Promise<void> {
    try {
      const store = await storeFn();
      const currentModel = process.env.QMD_EMBED_MODEL!;
      const forceReason = options?.force
        ? 'forced refresh requested'
        : getForceReason(store, currentModel);
      const onProgress = options?.onProgress
        ? (progress: { chunksEmbedded: number; totalChunks: number; bytesProcessed: number; totalBytes: number }) =>
            options.onProgress!(label, progress)
        : undefined;

      if (forceReason) {
        log.agent.warn(`QMD ${label}: ${forceReason}. Force re-embedding.`);
        await forceReembed(store, label, currentModel, onProgress);
        log.agent.info(`QMD ${label}: force re-embed complete, model now="${getStoredEmbedModel(store)}"`);
      }
    } catch (err) {
      log.agent.warn(`QMD ${label}: compatibility check failed`, {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  // Each store owns a separate LlamaCpp instance. Re-embedding them in
  // parallel loads multiple copies of the large local model and can starve
  // interactive search plus the HTTP event loop.
  await checkAndReembed(getNotesStore, 'notes');
  await checkAndReembed(getTaskStore, 'task');
  await checkAndReembed(getSessionStore, 'session');

  log.agent.info('QMD: stores initialized');
}

export async function closeQmdStores(): Promise<void> {
  // A model switch can race the first lazy search that is still creating its
  // store. Let that creation settle before closing, otherwise it can publish an
  // old-model singleton after this function returns.
  await Promise.allSettled([
    memoryStorePromise,
    notesStorePromise,
    taskStorePromise,
    sessionStorePromise,
  ].filter((promise): promise is Promise<QMDStore> => promise !== null));

  if (memoryStore) { await memoryStore.close(); memoryStore = null; }
  if (notesStore) { await notesStore.close(); notesStore = null; }
  if (taskStore) { await taskStore.close(); taskStore = null; }
  if (sessionStore) { await sessionStore.close(); sessionStore = null; }
  memoryStorePromise = null;
  notesStorePromise = null;
  taskStorePromise = null;
  sessionStorePromise = null;
}

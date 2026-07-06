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
import { WALNUT_HOME, MEMORY_DIR, NOTES_DIR, GLOBAL_SKILLS_DIR } from '../constants.js';
import path from 'node:path';
import { log } from '../logging/index.js';

/** Default embedding model URI — shared with qmd route. */
export const DEFAULT_QMD_MODEL = 'hf:CompendiumLabs/bge-m3-gguf/bge-m3-f16.gguf';

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
    memoryStorePromise = createStore({
      dbPath: path.join(WALNUT_HOME, 'memory-search.sqlite'),
      config: {
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
    notesStorePromise = createStore({
      dbPath: path.join(WALNUT_HOME, 'notes-search.sqlite'),
      config: {
        // ONE whole-vault collection (was 4 PARA folders). This is the semantic
        // side of the hybrid notes search; notes anywhere in the vault are now
        // embedded. The per-save reconcile drives this store ONE changed file at
        // a time (notes-indexer.ts) — store.update() (used here for cold rebuild /
        // startup glob only) is NEVER called on the save hot path.
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
    taskStorePromise = createStore({
      dbPath: path.join(WALNUT_HOME, 'task-search.sqlite'),
      config: {
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
    sessionStorePromise = createStore({
      dbPath: path.join(WALNUT_HOME, 'session-search.sqlite'),
      config: {
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

export async function initQmdStores(): Promise<void> {
  // BGE-M3: multilingual embedding model (Chinese + English) — critical for bilingual search.
  // Replaces QMD's default EmbeddingGemma which is English-only.
  // GGUF conversion by CompendiumLabs (BAAI doesn't publish GGUF directly).
  process.env.QMD_EMBED_MODEL = process.env.QMD_EMBED_MODEL || DEFAULT_QMD_MODEL;

  log.agent.info('QMD: initializing stores...');
  // Eagerly open both store singletons at boot (notes is then driven per-file by
  // the reconciler — see updateAndEmbed group below — not via store.update()).
  const [mem] = await Promise.all([getMemoryStore(), getNotesStore()]);

  // Detect embedding model mismatch by checking content_vectors.model in SQLite.
  // embed() without force skips docs that already have vectors, so it can't
  // detect wrong-model vectors. We check the DB directly — source of truth.
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

  // Lazy import to avoid circular dependency — only used during init
  let reportProgress: ((store: string, progress: { chunksEmbedded: number; totalChunks: number; bytesProcessed: number; totalBytes: number }) => void) | null = null;
  try {
    const { setQmdEmbedProgress } = await import('../web/routes/qmd.js');
    reportProgress = setQmdEmbedProgress;
  } catch { /* web routes not loaded yet — skip progress reporting */ }

  async function updateAndEmbed(store: QMDStore, label: string): Promise<void> {
    await store.update();

    const currentModel = process.env.QMD_EMBED_MODEL!;
    const storedModel = getStoredEmbedModel(store);
    const onProgress = reportProgress ? (p: { chunksEmbedded: number; totalChunks: number; bytesProcessed: number; totalBytes: number }) => reportProgress!(label, p) : undefined;

    if (storedModel && storedModel !== currentModel) {
      log.agent.warn(`QMD ${label}: model mismatch — stored="${storedModel}", current="${currentModel}". Force re-embedding all documents.`);
      await store.embed({ force: true, model: currentModel, onProgress });
      const afterModel = getStoredEmbedModel(store);
      log.agent.info(`QMD ${label}: force re-embed complete, model now="${afterModel}"`);
    } else {
      await store.embed({ model: currentModel, onProgress });
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
      const storedModel = getStoredEmbedModel(store);
      const onProgress = reportProgress ? (p: { chunksEmbedded: number; totalChunks: number; bytesProcessed: number; totalBytes: number }) => reportProgress!(label, p) : undefined;

      if (storedModel && storedModel !== currentModel) {
        log.agent.warn(`QMD ${label}: model mismatch — stored="${storedModel}", current="${currentModel}". Force re-embedding.`);
        await store.embed({ force: true, model: currentModel, onProgress });
        log.agent.info(`QMD ${label}: force re-embed complete, model now="${getStoredEmbedModel(store)}"`);
      }
    } catch (err) {
      log.agent.warn(`QMD ${label}: model check failed`, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  await Promise.all([
    checkAndReembed(getNotesStore, 'notes'),
    checkAndReembed(getTaskStore, 'task'),
    checkAndReembed(getSessionStore, 'session'),
  ]);

  log.agent.info('QMD: stores initialized');
}

export async function closeQmdStores(): Promise<void> {
  if (memoryStore) { await memoryStore.close(); memoryStore = null; }
  if (notesStore) { await notesStore.close(); notesStore = null; }
  if (taskStore) { await taskStore.close(); taskStore = null; }
  if (sessionStore) { await sessionStore.close(); sessionStore = null; }
}

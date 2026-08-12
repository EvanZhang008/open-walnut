/**
 * Task -> QMD sync module.
 *
 * Reads tasks from tasks.json and inserts them into the QMD task store
 * for semantic search. Uses content-hash comparison to skip unchanged tasks.
 *
 * Design notes:
 * - No store.update(): task store uses __qmd_programmatic_only__ sentinel,
 *   so there are no on-disk .md files. All data enters via internal.insert*.
 * - Hash-skip: SHA256 of serialized task content avoids redundant insertContent
 *   calls + embedding work when task data hasn't actually changed.
 * - Virtual path convention: "task-{id}" — these aren't real files, just
 *   stable document keys so QMD can track insert vs update.
 * - embed() is called by the server's debounced event handler (not here)
 *   for incremental syncs. syncAllTasks() calls embed() directly for bulk init.
 */
import { createHash } from 'node:crypto';
import {
  embedQmdStore,
  getTaskStore,
  DEFAULT_QMD_MODEL,
} from './qmd-store.js';
import { listTasks } from './task-manager.js';
import { log } from '../logging/index.js';
import { pruneStaleQmdDocuments } from './qmd-sync-utils.js';
import { isJunkTask } from './task-junk.js';
import type { Task } from './types.js';

const COLLECTION = 'tasks';

/**
 * Serialization format version, salted into the content hash. Bumping it makes
 * every task document's hash differ from what's on disk, so the next sync
 * re-inserts + re-embeds the whole collection. Bump whenever
 * serializeTaskForSearch changes shape (v2 = category removed, project-only).
 */
const TASK_DOC_FORMAT_VERSION = 'v2';

/**
 * Junk/test tasks stay OUT of the semantic index — pure-title test debris
 * ("Burst message echo test", __TestCat fixtures) produces short embeddings
 * that score inflated cosine against short queries and outranks real work
 * (0.875 vs 0.4, 2026-08-12). Filtering at sync time also lets the prune pass
 * clean up junk that older syncs already indexed: junk paths are excluded
 * from expectedPaths, so pruneStaleQmdDocuments deactivates them.
 */
function isIndexableTask(task: Task): boolean {
  return !isJunkTask(task);
}

/**
 * Serialize human-language task content for QMD.
 *
 * Opaque task/session IDs deliberately stay in the structured task store and
 * are resolved by searchTaskReferences(). Including them here changes the
 * content hash whenever a session is linked, forcing an expensive semantic
 * re-embed without improving the vector representation.
 */
export function serializeTaskForSearch(task: Task): string {
  const parts = [task.title];
  if (task.description) parts.push(task.description);
  if (task.summary) parts.push(task.summary);
  if (task.tags?.length) parts.push(`Tags: ${task.tags.join(', ')}`);
  parts.push(`Project: ${task.project || 'Inbox'}`);
  if (task.note) parts.push(task.note);
  if (task.conversation_log) parts.push(task.conversation_log);
  return parts.join('\n\n');
}

/** SHA256 hash of serialized content, salted with the format version so a
 *  serializer change invalidates every existing document hash. */
function contentHash(text: string): string {
  return createHash('sha256').update(`${TASK_DOC_FORMAT_VERSION}\n${text}`).digest('hex');
}

/** Virtual document path for a task. */
function taskDocPath(taskId: string): string {
  return `task-${taskId}`;
}

/**
 * Full sync: read all tasks, insert/update in QMD, then embed.
 * Skips tasks whose content hash hasn't changed.
 */
export interface SyncAllTaskOptions {
  force?: boolean;
  onProgress?: (progress: {
    chunksEmbedded: number;
    totalChunks: number;
    bytesProcessed: number;
    totalBytes: number;
  }) => void;
}

export async function syncAllTasks(opts?: SyncAllTaskOptions): Promise<void> {
  const store = await getTaskStore();
  const tasks = await listTasks();
  const now = new Date().toISOString();

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const task of tasks) {
    if (!isIndexableTask(task)) continue; // junk never enters; prune removes existing docs
    const text = serializeTaskForSearch(task);
    const hash = contentHash(text);
    const docPath = taskDocPath(task.id);

    const existing = store.internal.findActiveDocument(COLLECTION, docPath);

    if (existing && existing.hash === hash) {
      skipped++;
      continue;
    }

    // Insert content (content-addressable, deduped by hash)
    store.internal.insertContent(hash, text, now);

    if (existing) {
      // Update existing document with new hash
      store.internal.updateDocument(existing.id, task.title, hash, now);
      updated++;
    } else {
      // Insert new document
      store.internal.insertDocument(COLLECTION, docPath, task.title, hash, now, now);
      inserted++;
    }
  }

  // Re-read the source of truth at prune time so a task created during the
  // initial loop is not mistaken for a stale QMD document. Junk tasks are
  // deliberately absent from expectedPaths so prune deactivates their docs.
  const currentTasks = await listTasks();
  const expectedPaths = new Set(
    currentTasks.filter(isIndexableTask).map((task) => taskDocPath(task.id)),
  );
  const pruned = pruneStaleQmdDocuments(store, COLLECTION, expectedPaths);

  // Embed any new/updated content
  const model = process.env.QMD_EMBED_MODEL || DEFAULT_QMD_MODEL;
  await embedQmdStore(store, 'task', {
    ...(opts?.force ? { force: true } : {}),
    model,
    onProgress: opts?.onProgress,
  });

  log.agent.info(`QMD task sync: ${inserted} inserted, ${updated} updated, ${skipped} skipped, ${pruned.deactivated} stale removed (${tasks.length} total)`, {
    pruned,
  });
}

/**
 * Incremental sync: upsert a single task (insert/update only, no embed).
 * Call flushTaskEmbeddings() after batching multiple syncs.
 */
export async function syncTask(task: Task): Promise<boolean> {
  const store = await getTaskStore();
  if (isJunkTask(task)) {
    // Junk task created/updated (e.g. an E2E fixture): keep it out of the
    // index — deactivate any doc an older sync may have inserted.
    store.internal.deactivateDocument(COLLECTION, taskDocPath(task.id));
    return store.internal.getHashesNeedingEmbedding() > 0;
  }
  const text = serializeTaskForSearch(task);
  const hash = contentHash(text);
  const docPath = taskDocPath(task.id);
  const now = new Date().toISOString();

  const existing = store.internal.findActiveDocument(COLLECTION, docPath);

  if (existing && existing.hash === hash) {
    return store.internal.getHashesNeedingEmbedding() > 0;
  }

  store.internal.insertContent(hash, text, now);

  if (existing) {
    store.internal.updateDocument(existing.id, task.title, hash, now);
  } else {
    store.internal.insertDocument(COLLECTION, docPath, task.title, hash, now, now);
  }
  return true;
}

/**
 * Flush pending task embeddings. Called once after batching multiple syncTask() calls.
 */
export async function flushTaskEmbeddings(): Promise<void> {
  const store = await getTaskStore();
  const model = process.env.QMD_EMBED_MODEL || DEFAULT_QMD_MODEL;
  await embedQmdStore(store, 'task', { model });
}

/**
 * Remove a task from the QMD store (deactivate its document).
 */
export async function removeTask(taskId: string): Promise<void> {
  const store = await getTaskStore();
  store.internal.deactivateDocument(COLLECTION, taskDocPath(taskId));
}

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
import type { Task } from './types.js';

const COLLECTION = 'tasks';

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
  parts.push(`${task.category} / ${task.project}`);
  if (task.note) parts.push(task.note);
  if (task.conversation_log) parts.push(task.conversation_log);
  return parts.join('\n\n');
}

/** SHA256 hash of serialized content. */
function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
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
  // initial loop is not mistaken for a stale QMD document.
  const currentTasks = await listTasks();
  const expectedPaths = new Set(currentTasks.map((task) => taskDocPath(task.id)));
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

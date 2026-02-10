/**
 * Embedding pipeline — reconciliation on startup + incremental embedding on task/memory changes.
 */

import crypto from 'node:crypto';
import { log } from '../../logging/index.js';
import { listTasks } from '../task-manager.js';
import type { Task } from '../types.js';
import { batchEmbed, unloadModel, type OllamaEmbedOptions } from './client.js';
import {
  ensureEmbeddingTables,
  getTaskEmbeddingHash,
  upsertTaskEmbedding,
  deleteTaskEmbedding,
  upsertChunkEmbedding,
  cleanOrphanedChunkEmbeddings,
  getUnembeddedChunkIds,
} from './store.js';

const BATCH_SIZE = 8;

/** Build the composite search document for a task (used for embedding). */
export function buildCompositeText(task: Task): string {
  const parts: string[] = [];
  // Title repeated for emphasis
  parts.push(`[${task.title}] ${task.title}.`);
  if (task.description) parts.push(task.description);
  if (task.summary) parts.push(task.summary);
  if (task.tags?.length) parts.push(`Tags: ${task.tags.join(', ')}.`);
  parts.push(`${task.category}/${task.project}.`);
  // Include note — critical for cross-language search (e.g. "test" ↔ "测试")
  if (task.note) {
    const noteSnippet = task.note.length > 1500 ? task.note.slice(0, 1500) : task.note;
    parts.push(noteSnippet);
  }
  // Truncate to ~4000 chars (~1000 tokens) — BGE-M3 supports up to 8192 tokens
  const text = parts.join(' ');
  return text.length > 4000 ? text.slice(0, 4000) : text;
}

/** Compute SHA256 hash of composite text for change detection. */
export function compositeHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Reconcile task embeddings: hash-compare each task, embed only changed/new ones.
 * Returns { embedded: number, skipped: number, deleted: number }.
 */
export async function reconcileTaskEmbeddings(
  options?: OllamaEmbedOptions,
): Promise<{ embedded: number; skipped: number; deleted: number }> {
  ensureEmbeddingTables();

  const tasks = await listTasks();
  const model = options?.model ?? 'bge-m3';

  // Build list of tasks that need embedding
  const toEmbed: Array<{ task: Task; text: string; hash: string }> = [];
  const seenIds = new Set<string>();
  let skipped = 0;

  for (const task of tasks) {
    seenIds.add(task.id);
    const text = buildCompositeText(task);
    const hash = compositeHash(text);
    const existingHash = getTaskEmbeddingHash(task.id);

    if (existingHash === hash) {
      skipped++;
      continue;
    }
    toEmbed.push({ task, text, hash });
  }

  // Batch embed
  let embedded = 0;
  for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
    const batch = toEmbed.slice(i, i + BATCH_SIZE);
    const texts = batch.map((b) => b.text);
    const vectors = await batchEmbed(texts, options);

    if (!vectors) {
      log.agent.warn('Ollama unavailable — skipping remaining task embeddings');
      break;
    }

    for (let j = 0; j < batch.length; j++) {
      upsertTaskEmbedding(batch[j].task.id, batch[j].hash, vectors[j], model);
      embedded++;
    }

    if (i + BATCH_SIZE < toEmbed.length) {
      log.agent.debug(`Embedded ${embedded}/${toEmbed.length} tasks...`);
    }
  }

  // Delete embeddings for tasks that no longer exist
  let deleted = 0;
  const { getDb } = await import('../memory-index.js');
  const db = getDb();
  const existingEmbIds = db.prepare('SELECT task_id FROM task_embeddings').all() as Array<{ task_id: string }>;
  for (const row of existingEmbIds) {
    if (!seenIds.has(row.task_id)) {
      deleteTaskEmbedding(row.task_id);
      deleted++;
    }
  }

  return { embedded, skipped, deleted };
}

/**
 * Embed a single task (for incremental updates on task:created / task:updated).
 */
export async function embedSingleTask(
  task: Task,
  options?: OllamaEmbedOptions,
): Promise<boolean> {
  ensureEmbeddingTables();

  const model = options?.model ?? 'bge-m3';
  const text = buildCompositeText(task);
  const hash = compositeHash(text);
  const existingHash = getTaskEmbeddingHash(task.id);

  if (existingHash === hash) return false; // unchanged

  const vectors = await batchEmbed([text], options);
  if (!vectors) return false; // Ollama unavailable

  upsertTaskEmbedding(task.id, hash, vectors[0], model);
  return true;
}

/**
 * Reconcile chunk embeddings: embed any chunks that don't have embeddings yet.
 * Also cleans up orphaned embeddings (chunk deleted from FTS but embedding remains).
 */
export async function reconcileChunkEmbeddings(
  options?: OllamaEmbedOptions,
): Promise<{ embedded: number; cleaned: number }> {
  ensureEmbeddingTables();

  const model = options?.model ?? 'bge-m3';

  // Clean orphans first
  const cleaned = cleanOrphanedChunkEmbeddings();

  // Find chunks without embeddings
  const unembedded = getUnembeddedChunkIds();
  if (unembedded.length === 0) return { embedded: 0, cleaned };

  let embedded = 0;
  for (let i = 0; i < unembedded.length; i += BATCH_SIZE) {
    const batch = unembedded.slice(i, i + BATCH_SIZE);
    const texts = batch.map((b) => b.text);
    const vectors = await batchEmbed(texts, options);

    if (!vectors) {
      log.agent.warn('Ollama unavailable — skipping remaining chunk embeddings');
      break;
    }

    for (let j = 0; j < batch.length; j++) {
      upsertChunkEmbedding(batch[j].id, vectors[j], model);
      embedded++;
    }
  }

  return { embedded, cleaned };
}

/**
 * Full reconciliation: tasks + chunks. Called on server startup.
 * Unloads model from GPU after completion to free memory.
 */
export async function reconcileAllEmbeddings(
  options?: OllamaEmbedOptions,
): Promise<void> {
  const startTime = Date.now();

  const taskResult = await reconcileTaskEmbeddings(options);
  log.agent.info(`Task embeddings: ${taskResult.embedded} new, ${taskResult.skipped} unchanged, ${taskResult.deleted} removed`);

  const chunkResult = await reconcileChunkEmbeddings(options);
  log.agent.info(`Chunk embeddings: ${chunkResult.embedded} new, ${chunkResult.cleaned} orphans cleaned`);

  const elapsed = Date.now() - startTime;
  const totalEmbedded = taskResult.embedded + chunkResult.embedded;

  if (totalEmbedded > 0) {
    log.agent.info(`Embedding reconciliation complete in ${elapsed}ms (${totalEmbedded} vectors)`);
    // Unload model from GPU after bulk indexing
    await unloadModel(options);
  } else {
    log.agent.debug(`Embedding reconciliation: nothing to update (${elapsed}ms)`);
  }
}

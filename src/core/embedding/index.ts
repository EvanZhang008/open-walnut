/** Embedding subsystem barrel — re-exports all public APIs. */

export { cosineSimilarity, topK, bufferToFloat32, float32ToBuffer } from './cosine.js';
export { embed, batchEmbed, unloadModel, isOllamaAvailable, resetAvailabilityCache } from './client.js';
export type { OllamaEmbedOptions } from './client.js';
export {
  ensureEmbeddingTables,
  getTaskEmbeddingHash,
  upsertTaskEmbedding,
  deleteTaskEmbedding,
  getAllTaskEmbeddings,
  getChunkEmbeddingIds,
  upsertChunkEmbedding,
  getAllChunkEmbeddings,
  cleanOrphanedChunkEmbeddings,
  getUnembeddedChunkIds,
} from './store.js';
export {
  buildCompositeText,
  compositeHash,
  reconcileTaskEmbeddings,
  reconcileChunkEmbeddings,
  reconcileAllEmbeddings,
  embedSingleTask,
} from './pipeline.js';
export type { EmbeddingConfig, SearchMode, TaskEmbeddingRecord, ChunkEmbeddingRecord } from './types.js';

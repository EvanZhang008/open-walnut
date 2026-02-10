/** Embedding subsystem types. */

export interface EmbeddingConfig {
  /** Enable/disable embedding-based search. Default: true. */
  enabled?: boolean;
  /** Ollama model name. Default: 'bge-m3'. */
  model?: string;
  /** Ollama base URL. Default: 'http://localhost:11434'. */
  ollama_url?: string;
  /** Vector dimensions. BGE-M3 outputs 1024d by default. */
  dimensions?: number;
  /** RRF alpha (BM25 weight). Default: 0.4. Range: 0-1. */
  rrf_alpha?: number;
  /** Default search mode. Default: 'hybrid'. */
  default_mode?: SearchMode;
  /** Ollama keep_alive for embedding model. Default: '5m'. */
  keep_alive?: string;
}

export type SearchMode = 'hybrid' | 'keyword' | 'semantic';

export interface TaskEmbeddingRecord {
  task_id: string;
  composite_hash: string;
  embedding: Buffer;
  model: string;
  created_at: string;
}

export interface ChunkEmbeddingRecord {
  chunk_id: number;
  embedding: Buffer;
  model: string;
  created_at: string;
}

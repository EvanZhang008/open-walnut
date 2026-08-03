/** Embedding subsystem types. */

export interface EmbeddingConfig {
  /** Enable/disable embedding-based search. Default: true. */
  enabled?: boolean;
  /** QMD model URI (e.g. 'hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf'). */
  qmd_model?: string;
  /** RRF alpha (BM25 weight). Default: 0.4. Range: 0-1. */
  rrf_alpha?: number;
  /** Vault-relative folder prefixes excluded from notes search results
   *  (e.g. ['archive']). Matching is per path segment, case-insensitive.
   *  Content stays indexed — exclusion is applied at query time, so toggling
   *  the setting needs no reindex. */
  excluded_folders?: string[];

  // ── Legacy (Ollama-era, unused) ──
  /** @deprecated Ollama model name. */
  model?: string;
  /** @deprecated Ollama base URL. */
  ollama_url?: string;
  /** @deprecated Vector dimensions. */
  dimensions?: number;
  /** @deprecated Ollama keep_alive. */
  keep_alive?: string;
}

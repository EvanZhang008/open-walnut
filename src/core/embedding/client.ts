/**
 * Ollama embedding client — calls local Ollama HTTP API for BGE-M3 embeddings.
 * Zero npm dependencies (pure fetch).
 */

import { log } from '../../logging/index.js';

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'bge-m3';
const DEFAULT_KEEP_ALIVE = '30m';

export interface OllamaEmbedOptions {
  ollamaUrl?: string;
  model?: string;
  keepAlive?: string;
}

interface OllamaEmbedResponse {
  embeddings: number[][];
}

let _available: boolean | null = null;

/** Check if Ollama is reachable. Caches result for 60s. */
export async function isOllamaAvailable(ollamaUrl?: string): Promise<boolean> {
  if (_available !== null) return _available;
  try {
    const res = await fetch(`${ollamaUrl ?? DEFAULT_OLLAMA_URL}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    _available = res.ok;
  } catch {
    _available = false;
  }
  // Reset cache after 60s so we re-check
  setTimeout(() => { _available = null; }, 60_000);
  return _available;
}

/** Reset the availability cache (for testing or after config change). */
export function resetAvailabilityCache(): void {
  _available = null;
}

/**
 * Embed a single text using Ollama BGE-M3.
 * Returns null if Ollama is unavailable.
 */
export async function embed(
  text: string,
  options?: OllamaEmbedOptions,
): Promise<Float32Array | null> {
  const result = await batchEmbed([text], options);
  return result ? result[0] : null;
}

/**
 * Embed multiple texts in a single Ollama API call.
 * Returns null if Ollama is unavailable.
 */
export async function batchEmbed(
  texts: string[],
  options?: OllamaEmbedOptions,
): Promise<Float32Array[] | null> {
  if (texts.length === 0) return [];

  const url = options?.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const model = options?.model ?? DEFAULT_MODEL;
  const keepAlive = options?.keepAlive ?? DEFAULT_KEEP_ALIVE;

  if (!(await isOllamaAvailable(url))) {
    return null;
  }

  try {
    const res = await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        input: texts,
        keep_alive: keepAlive,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log.agent.warn(`Ollama embed failed: ${res.status} ${body.slice(0, 200)}`);
      // If model not found, log a helpful message
      if (res.status === 404 || body.includes('not found')) {
        log.agent.warn(`Model "${model}" not found. Run: ollama pull ${model}`);
      }
      return null;
    }

    const data = (await res.json()) as OllamaEmbedResponse;
    // Ollama /api/embed returns L2-normalized vectors
    return data.embeddings.map((arr) => new Float32Array(arr));
  } catch (err) {
    // Network error, timeout, etc — degrade gracefully
    log.agent.debug(`Ollama embed error: ${err instanceof Error ? err.message : String(err)}`);
    _available = null; // reset cache so next call re-checks
    return null;
  }
}

/**
 * Tell Ollama to unload the embedding model from GPU memory.
 * Used after batch indexing to free resources.
 */
export async function unloadModel(options?: OllamaEmbedOptions): Promise<void> {
  const url = options?.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const model = options?.model ?? DEFAULT_MODEL;

  try {
    await fetch(`${url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: '', keep_alive: 0 }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Non-critical — model will auto-unload after default timeout
  }
}

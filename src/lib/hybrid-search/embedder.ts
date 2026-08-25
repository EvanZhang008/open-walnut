/**
 * Host-side handle for the embedding worker: lazy spawn, one in-flight map,
 * deadline-aware query embedding, crash containment.
 *
 * Failure philosophy: embedding is an ENHANCEMENT. Every failure mode here —
 * model missing, worker crash, deadline blown — degrades to `null`, and the
 * caller returns keyword results as-is. Nothing in this file may throw into
 * the search path.
 */

import { Worker } from 'node:worker_threads';
import type { LogFn } from './index.js';

export interface EmbedderRuntimeConfig {
  modelId: string;
  dims: number;
  queryPrefix?: string;
  passagePrefix?: string;
  /** transformers.js dtype (default 'q8'). */
  dtype?: string;
  cacheDir?: string;
  /** Pooling: 'mean' (default; e5 family) or 'last' (Qwen3-Embedding). */
  pooling?: 'mean' | 'last';
  /** Absolute path/URL of the compiled worker script. Defaults to the sibling
   *  embed-worker.js — correct when this library runs un-bundled; a bundling
   *  caller must pass where its build put the worker entry. */
  workerPath?: string | URL;
  /** Index db file for the worker's own READONLY connection (semantic recall
   *  lane). Omitted for :memory: indexes — a worker thread can't see them. */
  dbPath?: string;
}

/** One semantic-recall candidate from the worker's doc-level KNN. */
export interface RecallHit {
  docId: number;
  cos: number;
}

export interface QueryEmbedding {
  vec: Int8Array;
  /** Doc-level KNN neighbours (empty when recall is disabled/unavailable). */
  recall: RecallHit[];
}

export interface Embedder {
  /** Embed one query (optionally with doc-level KNN recall). Resolves null
   *  when the deadline expires or the worker is unavailable — callers degrade
   *  to keyword-only. */
  embedQuery(text: string, deadlineMs?: number, recallK?: number): Promise<QueryEmbedding | null>;
  /** Embed passages (backfill path, no deadline). Throws on worker failure so
   *  the backfill loop can stop instead of writing garbage. */
  embedPassages(texts: string[]): Promise<Int8Array[]>;
  dispose(): Promise<void>;
}

/** Truncation budget per text: ~500 tokens for the e5 family's 512 cap. The
 *  chunker keeps passages under this anyway; queries are always tiny. */
export const MAX_EMBED_CHARS = 2000;

const MAX_CONSECUTIVE_CRASHES = 3;

interface WorkerReply {
  rows: Int8Array[];
  recall: RecallHit[];
}

interface Pending {
  resolve: (reply: WorkerReply) => void;
  reject: (err: Error) => void;
  count: number;
}

export function cosineInt8(a: Int8Array, b: Int8Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export function createEmbedder(config: EmbedderRuntimeConfig, log: LogFn): Embedder {
  let worker: Worker | null = null;
  let nextId = 1;
  let crashes = 0;
  let disposed = false;
  const pending = new Map<number, Pending>();

  function failAllPending(reason: string): void {
    for (const [, p] of pending) p.reject(new Error(reason));
    pending.clear();
  }

  function getWorker(): Worker | null {
    if (disposed || crashes >= MAX_CONSECUTIVE_CRASHES) return null;
    if (worker) return worker;
    const scriptPath = config.workerPath ?? new URL('./embed-worker.js', import.meta.url);
    try {
      worker = new Worker(scriptPath, {
        workerData: {
          modelId: config.modelId,
          dims: config.dims,
          dtype: config.dtype,
          cacheDir: config.cacheDir,
          pooling: config.pooling,
          dbPath: config.dbPath,
        },
      });
    } catch (err) {
      crashes++;
      log('warn', 'hybrid-search: embed worker failed to spawn', {
        error: err instanceof Error ? err.message : String(err),
        scriptPath: String(scriptPath),
      });
      return null;
    }
    worker.unref();
    worker.on('message', (msg: {
      id: number;
      buf?: ArrayBuffer;
      dims?: number;
      error?: string;
      recall?: RecallHit[];
    }) => {
      // Only a SUCCESSFUL reply proves health. Resetting on error replies (or
      // counting any reply) lets a worker that answers a few batches and then
      // dies on a poison input reload the model forever without ever tripping
      // the 3-strike containment.
      if (msg.error === undefined) crashes = 0;
      const p = pending.get(msg.id);
      if (!p) return; // deadline already gave up on this job
      pending.delete(msg.id);
      if (msg.error !== undefined || !msg.buf || !msg.dims) {
        p.reject(new Error(msg.error ?? 'embed worker returned no data'));
        return;
      }
      const flat = new Int8Array(msg.buf);
      const rows: Int8Array[] = [];
      for (let i = 0; i < p.count; i++) {
        rows.push(flat.slice(i * msg.dims, (i + 1) * msg.dims));
      }
      p.resolve({ rows, recall: msg.recall ?? [] });
    });
    worker.on('error', (err) => {
      log('warn', 'hybrid-search: embed worker error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    worker.on('exit', (code) => {
      worker = null;
      if (disposed) return;
      crashes++;
      failAllPending(`embed worker exited (code ${code})`);
      if (crashes >= MAX_CONSECUTIVE_CRASHES) {
        log('error', 'hybrid-search: embed worker crashed repeatedly — semantic lane disabled for this process', {
          crashes,
        });
      }
    });
    return worker;
  }

  function submitJob(
    texts: string[],
    recallK?: number,
  ): { id: number; promise: Promise<WorkerReply> } | null {
    const w = getWorker();
    if (!w) return null;
    const id = nextId++;
    const promise = new Promise<WorkerReply>((resolve, reject) => {
      pending.set(id, { resolve, reject, count: texts.length });
      w.postMessage({ id, texts, ...(recallK ? { recallK } : {}) });
    });
    return { id, promise };
  }

  return {
    async embedQuery(text, deadlineMs = 150, recallK) {
      const prefixed = (config.queryPrefix ?? '') + text.slice(0, MAX_EMBED_CHARS);
      // Recall requires a real db file the worker can open on its own.
      const job = submitJob([prefixed], config.dbPath ? recallK : undefined);
      if (!job) return null;
      job.promise.catch(() => {}); // settled after we gave up ≠ unhandled
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The deadline timer stays REF'd: it is short-lived, cleared in
        // finally, and it is the only thing guaranteeing this race settles —
        // an unref'd timer plus the (deliberately) unref'd worker let a
        // one-shot CLI process exit before the race resolved.
        const reply = await Promise.race([
          job.promise,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), deadlineMs);
          }),
        ]);
        if (!reply) pending.delete(job.id); // deadline: drop the live closure
        return reply ? { vec: reply.rows[0], recall: reply.recall } : null;
      } catch {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    async embedPassages(texts) {
      const prefixed = texts.map((t) => (config.passagePrefix ?? '') + t.slice(0, MAX_EMBED_CHARS));
      const job = submitJob(prefixed);
      if (!job) return Promise.reject(new Error('embed worker unavailable'));
      return (await job.promise).rows;
    },

    async dispose() {
      disposed = true;
      failAllPending('embedder disposed');
      const w = worker;
      worker = null;
      if (w) await w.terminate();
    },
  };
}

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
  /** How long a cached reply may still serve its RECALL list (default 20s).
   *  Test seam / tuning knob; the cached VECTOR has no expiry. */
  recallFreshMs?: number;
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
  /** How this reply was served — instrumentation only, never scoring input.
   *  'worker' = fresh inference; 'cache' = LRU hit, no worker round-trip;
   *  'cache-vec' = the worker missed its deadline and a cached vector rescued
   *  the rescore (recall dropped). */
  source?: 'worker' | 'cache' | 'cache-vec';
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

/**
 * Query-embedding LRU (per embedder instance, i.e. per index handle).
 *
 * Why it pays: ONE /api/search fans out into three lanes (tasks, sessions,
 * files) and every lane embeds the SAME query string, serially, each with its
 * own deadline — three model round-trips for one keystroke. Repeated/overlapping
 * queries land within seconds of each other too (debounced typing, the AI-search
 * child re-asking).
 *
 * What may be reused, and for how long, differs by field:
 *  - `vec` is deterministic for a fixed model+prefix → no expiry.
 *  - `recall` is a SNAPSHOT of index state (the worker's level-0 KNN over
 *    doc_vec, which the paced backfill rewrites continuously), so it may only
 *    be served while fresh. After that the worker runs again; if THAT blows its
 *    deadline the cached vector still rescues the cosine rescore, with recall
 *    dropped rather than served stale (a doc id freed by a delete can be reused
 *    by a later insert, and a wrong doc entering the page as a "neighbour" is
 *    worse than no recall at all).
 */
export const QUERY_CACHE_CAP = 200;
export const DEFAULT_RECALL_FRESH_MS = 20_000;

interface CachedQuery {
  vec: Int8Array;
  recall: RecallHit[];
  /** When the recall snapshot was taken. */
  at: number;
}

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

/** One worker + its in-flight bookkeeping. The embedder runs TWO of these —
 *  a resident QUERY lane and a reap-when-idle PASSAGE lane — so an
 *  interactive query embed can never queue behind a backfill/re-embed
 *  inference (measured: one 2KB passage is ~0.5-1s on a busy machine, which
 *  alone eats an interactive deadline; a batch used to be 22s). */
interface Lane {
  submit(texts: string[], recallK?: number): { id: number; promise: Promise<WorkerReply> } | null;
  /** Caller gave up on a job (deadline) — drop its live closure. */
  abandon(id: number): void;
  /** Deliberate shutdown (idle reap / dispose) — never counted as a crash. */
  terminate(): Promise<void>;
}

export function createEmbedder(config: EmbedderRuntimeConfig, log: LogFn): Embedder {
  let disposed = false;

  function makeLane(role: string): Lane {
    let worker: Worker | null = null;
    let nextId = 1;
    let crashes = 0;
    let expectedExit = false;
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
          role,
          error: err instanceof Error ? err.message : String(err),
          scriptPath: String(scriptPath),
        });
        return null;
      }
      expectedExit = false;
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
          role,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      worker.on('exit', (code) => {
        worker = null;
        if (disposed || expectedExit) return;
        crashes++;
        failAllPending(`embed worker exited (code ${code})`);
        if (crashes >= MAX_CONSECUTIVE_CRASHES) {
          log('error', 'hybrid-search: embed worker crashed repeatedly — semantic lane disabled for this process', {
            role,
            crashes,
          });
        }
      });
      return worker;
    }

    return {
      submit(texts, recallK) {
        const w = getWorker();
        if (!w) return null;
        const id = nextId++;
        const promise = new Promise<WorkerReply>((resolve, reject) => {
          pending.set(id, { resolve, reject, count: texts.length });
          w.postMessage({ id, texts, ...(recallK ? { recallK } : {}) });
        });
        return { id, promise };
      },
      abandon(id) {
        pending.delete(id);
      },
      async terminate() {
        const w = worker;
        if (!w) return;
        expectedExit = true;
        worker = null;
        failAllPending('embed worker terminated');
        await w.terminate();
      },
    };
  }

  // Query lane stays resident: the first search pays the model load once and
  // every later query hits a warm, never-contended worker. The passage lane
  // holds a SECOND model copy, so it exists only while embedding work exists —
  // reaped after idle, steady-state RAM is one model, not two.
  const queryLane = makeLane('query');
  const passageLane = makeLane('passage');
  const PASSAGE_IDLE_KILL_MS = 5 * 60_000;
  let passageIdleTimer: ReturnType<typeof setTimeout> | undefined;
  function armPassageReaper(): void {
    if (passageIdleTimer) clearTimeout(passageIdleTimer);
    passageIdleTimer = setTimeout(() => { void passageLane.terminate(); }, PASSAGE_IDLE_KILL_MS);
    passageIdleTimer.unref?.();
  }

  // See CachedQuery: insertion-ordered Map used as the LRU (re-set on hit
  // moves an entry to the young end; the oldest key is evicted at the cap).
  const queryCache = new Map<string, CachedQuery>();
  const recallFreshMs = config.recallFreshMs ?? DEFAULT_RECALL_FRESH_MS;

  return {
    async embedQuery(text, deadlineMs = 150, recallK) {
      const prefixed = (config.queryPrefix ?? '') + text.slice(0, MAX_EMBED_CHARS);
      // Recall requires a real db file the worker can open on its own.
      const wantRecall = config.dbPath ? recallK : undefined;
      const cacheKey = `${wantRecall ?? 0}\u0000${prefixed}`;
      const cached = queryCache.get(cacheKey);
      if (cached && Date.now() - cached.at < recallFreshMs) {
        queryCache.delete(cacheKey);
        queryCache.set(cacheKey, cached); // touch: youngest
        return { vec: cached.vec, recall: cached.recall, source: 'cache' };
      }
      /** Cached vector as the fallback when the worker can't answer in time. */
      const rescue = (): QueryEmbedding | null =>
        (cached ? { vec: cached.vec, recall: [], source: 'cache-vec' } : null);
      const job = queryLane.submit([prefixed], wantRecall);
      if (!job) return rescue();
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
        if (!reply) {
          queryLane.abandon(job.id); // deadline: drop the live closure
          return rescue();
        }
        const out: QueryEmbedding = {
          vec: reply.rows[0],
          recall: reply.recall,
          source: 'worker',
        };
        queryCache.delete(cacheKey);
        queryCache.set(cacheKey, { vec: out.vec, recall: out.recall, at: Date.now() });
        if (queryCache.size > QUERY_CACHE_CAP) {
          // Map iteration is insertion order → the first key is the oldest.
          for (const oldest of queryCache.keys()) { queryCache.delete(oldest); break; }
        }
        return out;
      } catch {
        return rescue();
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    async embedPassages(texts) {
      const prefixed = texts.map((t) => (config.passagePrefix ?? '') + t.slice(0, MAX_EMBED_CHARS));
      const job = passageLane.submit(prefixed);
      if (!job) return Promise.reject(new Error('embed worker unavailable'));
      try {
        return (await job.promise).rows;
      } finally {
        armPassageReaper();
      }
    },

    async dispose() {
      disposed = true;
      queryCache.clear();
      if (passageIdleTimer) clearTimeout(passageIdleTimer);
      await Promise.all([queryLane.terminate(), passageLane.terminate()]);
    },
  };
}

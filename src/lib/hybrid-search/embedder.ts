/**
 * Host-side handle for the embedding worker: lazy spawn, one in-flight map,
 * deadline-aware query embedding, crash containment.
 *
 * The worker is a CHILD PROCESS, not a worker thread. Ending a thread while
 * onnxruntime is inside a run aborts the whole host process (Napi::Error,
 * exit 134): the production server on 2026-09-29, and a CI test process on
 * 2026-10-02 when a model load outlived the stop grace. Killing a child process
 * can only end that child, so a forced stop is always safe.
 *
 * Failure philosophy: embedding is an ENHANCEMENT. Every failure mode here —
 * model missing, worker crash, deadline blown — degrades to `null`, and the
 * caller returns keyword results as-is. Nothing in this file may throw into
 * the search path.
 */

import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LogFn, WorkerLauncher } from './index.js';

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
   *  lane). Omitted for :memory: indexes — another process can't see them. */
  dbPath?: string;
  /** How long a cached reply may still serve its RECALL list (default 20s).
   *  Test seam / tuning knob; the cached VECTOR has no expiry. */
  recallFreshMs?: number;
  /** Launcher that execs node in front of the worker (index.ts EmbedderConfig). */
  workerLauncher?: WorkerLauncher;
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
  /** Give the model memory back (machine memory pressure): stop both workers
   *  (a run in flight finishes first) and spawn none until resume(). Queries
   *  degrade to a cached vector or keyword order; passages reject. */
  suspend(): Promise<void>;
  resume(): void;
  isSuspended(): boolean;
  /** Stop the passage worker now unless a run is in flight (end of a backfill
   *  pass). Resolves true when it stopped one. */
  releasePassageWorker(): Promise<boolean>;
  dispose(): Promise<void>;
}

/** Truncation budget per text: ~500 tokens for the e5 family's 512 cap. The
 *  chunker keeps passages under this anyway; queries are always tiny. */
export const MAX_EMBED_CHARS = 2000;

const MAX_CONSECUTIVE_CRASHES = 3;

/** How long a stopping worker may take to finish its run and exit before it is
 *  forced. One passage embeds in well under this even on a loaded machine. */
export const WORKER_STOP_GRACE_MS = 10_000;

/** Environment variable carrying the worker's config (JSON) into the child. */
export const EMBED_WORKER_CONFIG_ENV = 'HYBRID_SEARCH_EMBED_WORKER_CONFIG';

/**
 * Why a passage embed failed. Only the last two can be the INPUT's fault, and
 * even then only if a healthy worker fails on it again (the backfill's blame
 * rule, index.ts):
 *  - unavailable  no worker could run it (disposed, suspended, not built, or
 *                 the lane disabled after repeated crashes)
 *  - terminated   a stop ended the run (shutdown, memory pressure, idle reap)
 *  - crashed      the worker process died while the job was in flight
 *  - replied      the worker answered with an error for this job
 */
export type EmbedFailureKind = 'unavailable' | 'terminated' | 'crashed' | 'replied';

function embedError(message: string, kind: EmbedFailureKind): Error {
  return Object.assign(new Error(message), { embedFailure: kind });
}

export function embedFailureKind(err: unknown): EmbedFailureKind | undefined {
  return (err as { embedFailure?: EmbedFailureKind } | null)?.embedFailure;
}

interface WorkerMessage {
  id: number;
  buf?: ArrayBuffer;
  dims?: number;
  error?: string;
  recall?: RecallHit[];
}

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

/**
 * Workers alive in this process. A host that exits takes them with it: an
 * orphaned worker would otherwise finish whatever batch it was in (minutes, on
 * a loaded machine) for an answer nobody will read. Killing a child process
 * cannot reach the host, and the host is exiting anyway.
 */
const liveWorkers = new Set<ChildProcess>();
let exitHookArmed = false;
function trackWorker(w: ChildProcess): void {
  liveWorkers.add(w);
  if (exitHookArmed) return;
  exitHookArmed = true;
  process.once('exit', () => {
    for (const child of liveWorkers) child.kill('SIGKILL');
  });
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
 *  a QUERY lane and a PASSAGE lane, each reaped when idle, so an
 *  interactive query embed can never queue behind a backfill/re-embed
 *  inference (measured: one 2KB passage is ~0.5-1s on a busy machine, which
 *  alone eats an interactive deadline; a batch used to be 22s). */
interface Lane {
  submit(texts: string[], recallK?: number): { id: number; promise: Promise<WorkerReply> } | null;
  /** No job in flight. */
  idle(): boolean;
  /** A worker (with its model) exists right now. */
  running(): boolean;
  /** Deliberate shutdown (idle reap / dispose) — never counted as a crash. */
  terminate(): Promise<void>;
}

export interface EmbedderOptions {
  /** Test seam: how long a stopping worker gets before it is forced. */
  stopGraceMs?: number;
  /** Test seam: how long the passage lane may sit idle before it is reaped. */
  passageIdleMs?: number;
  /** How long the query lane may sit idle before it is reaped (default
   *  DEFAULT_QUERY_IDLE_MS; 0 keeps it resident). */
  queryIdleMs?: number;
}

/**
 * The query worker is released after this long without a query. Measured
 * 2026-10-02: one lane of the default model is +2.2 GB of footprint, and the
 * production server saw queries in 54 of 1314 minutes over 22 hours, so a
 * resident query worker held that memory almost entirely for nothing. At 10
 * minutes the worker is absent about 72% of the time, and about 25 queries a
 * day arrive to a cold worker: those rank by keyword (the model loads in the
 * background in 1.6 to 3.8 s and the next query is semantic again).
 */
export const DEFAULT_QUERY_IDLE_MS = 10 * 60_000;

export function createEmbedder(config: EmbedderRuntimeConfig, log: LogFn, options: EmbedderOptions = {}): Embedder {
  const stopGraceMs = options.stopGraceMs ?? WORKER_STOP_GRACE_MS;
  let disposed = false;
  // Suspended: no lane may spawn a worker (each holds a full model copy).
  let suspended = false;

  /** holdOpen: a job in flight keeps the host process alive. The passage lane
   *  does (its callers await every job); the query lane does not, because its
   *  caller's deadline timer already holds the host for as long as it waits,
   *  and a one-shot CLI that gave up on a query must not then wait for the
   *  model to load. */
  function makeLane(role: string, holdOpen: boolean): Lane {
    let worker: ChildProcess | null = null;
    let nextId = 1;
    let crashes = 0;
    // Workers asked to stop. A stopping worker can outlive the next one's
    // spawn (it finishes its run first), so its exit must neither clear the
    // new worker's slot nor count as a crash.
    const stopped = new WeakSet<ChildProcess>();
    // Settles once a worker is gone for good (closed, or never started).
    const closedOf = new WeakMap<ChildProcess, Promise<void>>();
    const pending = new Map<number, Pending>();

    function failAllPending(reason: string, kind: EmbedFailureKind): void {
      for (const [, p] of pending) p.reject(embedError(reason, kind));
      pending.clear();
      if (worker) hold(worker, false);
    }

    /** An idle worker never keeps the host alive (see holdOpen). */
    function hold(w: ChildProcess, on: boolean): void {
      if (on) { w.ref(); w.channel?.ref(); } else { w.unref(); w.channel?.unref(); }
    }

    function getWorker(): ChildProcess | null {
      if (disposed || crashes >= MAX_CONSECUTIVE_CRASHES) return null;
      if (worker) return worker;
      if (suspended) return null;
      const scriptPath = config.workerPath ?? new URL('./embed-worker.js', import.meta.url);
      const workerConfig = {
        modelId: config.modelId,
        dims: config.dims,
        dtype: config.dtype,
        cacheDir: config.cacheDir,
        pooling: config.pooling,
        dbPath: config.dbPath,
      };
      let w: ChildProcess;
      try {
        const file = scriptPath instanceof URL || scriptPath.startsWith('file:') ? fileURLToPath(scriptPath) : scriptPath;
        // Not built: no process to start (it would only print a stack and exit).
        if (!fs.existsSync(file)) throw new Error(`no worker script at ${file}`);
        w = fork(file, [], {
          // 'advanced' carries the ArrayBuffer replies; JSON would not.
          serialization: 'advanced',
          // The worker is compiled JS: a host's loader or inspector flags
          // (tsx, vitest, --inspect) must not follow it. A launcher (a
          // scheduling clamp that execs node) goes in front of it instead.
          ...(config.workerLauncher
            ? { execPath: config.workerLauncher.execPath, execArgv: [...config.workerLauncher.execArgv] }
            : { execArgv: [] }),
          env: { ...process.env, [EMBED_WORKER_CONFIG_ENV]: JSON.stringify(workerConfig) },
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
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
      worker = w;
      let markClosed!: () => void;
      closedOf.set(w, new Promise<void>((resolve) => { markClosed = resolve; }));
      w.on('message', (msg: WorkerMessage) => {
        // Only a SUCCESSFUL reply proves health. Resetting on error replies (or
        // counting any reply) lets a worker that answers a few batches and then
        // dies on a poison input reload the model forever without ever tripping
        // the 3-strike containment.
        if (msg.error === undefined) crashes = 0;
        const p = pending.get(msg.id);
        if (!p) return; // terminated: failAllPending already settled it
        pending.delete(msg.id);
        if (pending.size === 0 && worker === w) hold(w, false);
        if (msg.error !== undefined || !msg.buf || !msg.dims) {
          // A worker asked to stop refuses new jobs: that is the stop, not the input.
          p.reject(embedError(
            msg.error ?? 'embed worker returned no data',
            msg.error === 'embed worker stopping' ? 'terminated' : 'replied',
          ));
          return;
        }
        const flat = new Int8Array(msg.buf);
        const rows: Int8Array[] = [];
        for (let i = 0; i < p.count; i++) {
          rows.push(flat.slice(i * msg.dims, (i + 1) * msg.dims));
        }
        p.resolve({ rows, recall: msg.recall ?? [] });
      });
      let gone = false;
      const onGone = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (gone) return;
        gone = true;
        liveWorkers.delete(w);
        markClosed();
        if (worker === w) worker = null;
        if (disposed || stopped.has(w)) return;
        crashes++;
        failAllPending(`embed worker exited (${signal ?? `code ${code}`})`, 'crashed');
        if (crashes >= MAX_CONSECUTIVE_CRASHES) {
          log('error', 'hybrid-search: embed worker crashed repeatedly — semantic lane disabled for this process', {
            role,
            crashes,
          });
        }
      };
      w.on('error', (err) => {
        log('warn', 'hybrid-search: embed worker error', {
          role,
          error: err instanceof Error ? err.message : String(err),
        });
        // A process that never started emits no exit of its own.
        if (w.pid === undefined) onGone(null, null);
      });
      // 'close' comes after the IPC channel has delivered every message the
      // worker sent before it exited; 'exit' can come before them.
      w.on('close', onGone);
      // An idle worker keeps no host alive: a one-shot CLI exits when its own
      // work is done, and the worker follows (it exits when its channel
      // closes, embed-worker.ts).
      hold(w, false);
      trackWorker(w);
      return w;
    }

    return {
      submit(texts, recallK) {
        const w = getWorker();
        if (!w) return null;
        const id = nextId++;
        const promise = new Promise<WorkerReply>((resolve, reject) => {
          pending.set(id, { resolve, reject, count: texts.length });
          if (holdOpen) hold(w, true);
          w.send({ id, texts, ...(recallK ? { recallK } : {}) }, (err) => {
            if (!err || !pending.has(id)) return;
            pending.delete(id);
            if (pending.size === 0 && worker === w) hold(w, false);
            reject(embedError(err.message, 'unavailable'));
          });
        });
        return { id, promise };
      },
      idle() {
        return pending.size === 0;
      },
      running() {
        return worker !== null;
      },
      async terminate() {
        const w = worker;
        if (!w) return;
        stopped.add(w);
        worker = null;
        failAllPending('embed worker terminated', 'terminated');
        // The worker finishes its run and exits on its own, so a model load or
        // an inference is never cut short for nothing; only a run that outlives
        // the grace is killed, which ends the worker process and nothing else.
        // The worker is ref'd again from here on, so a shutdown that awaits
        // this cannot exit before the worker has (the unref'd handles would
        // let a one-shot host's loop end with this promise still pending).
        hold(w, true);
        const closed = closedOf.get(w) ?? Promise.resolve();
        // A worker already gone answers through its callback; nothing to do.
        w.send({ stop: true }, () => {});
        let timer: ReturnType<typeof setTimeout> | undefined;
        const exited = await Promise.race([
          closed.then(() => true),
          new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), stopGraceMs); }),
        ]);
        clearTimeout(timer);
        if (exited) return;
        log('warn', 'hybrid-search: embed worker did not stop in time — killing it', { role, graceMs: stopGraceMs });
        w.kill('SIGKILL');
        await closed;
      },
    };
  }

  // Each lane holds its own model copy. The query lane stays while queries
  // keep coming (released after DEFAULT_QUERY_IDLE_MS without one) and never
  // waits behind backfill; the passage lane exists only while embedding work
  // exists (released when a pass drains, or after its idle timer).
  const queryLane = makeLane('query', false);
  const passageLane = makeLane('passage', true);
  const PASSAGE_IDLE_KILL_MS = options.passageIdleMs ?? 5 * 60_000;
  const QUERY_IDLE_KILL_MS = options.queryIdleMs ?? DEFAULT_QUERY_IDLE_MS;
  let queryIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let lastQueryAt = 0;
  // Re-armed after every query that reached the worker. When it fires with no
  // job in flight, the worker goes (with its model); the next query respawns it.
  function armQueryReaper(): void {
    if (QUERY_IDLE_KILL_MS <= 0 || disposed) return;
    lastQueryAt = Date.now();
    if (queryIdleTimer) clearTimeout(queryIdleTimer);
    queryIdleTimer = setTimeout(function reap() {
      queryIdleTimer = undefined;
      if (disposed || suspended) return;
      if (!queryLane.idle() || inflight.size > 0) {
        queryIdleTimer = setTimeout(reap, QUERY_IDLE_KILL_MS);
        queryIdleTimer.unref?.();
        return;
      }
      if (!queryLane.running()) return;
      log('info', 'hybrid-search: query embed worker released after idle', {
        idleMs: Date.now() - lastQueryAt,
      });
      void queryLane.terminate();
    }, QUERY_IDLE_KILL_MS);
    queryIdleTimer.unref?.();
  }
  let passageIdleTimer: ReturnType<typeof setTimeout> | undefined;
  function armPassageReaper(): void {
    if (passageIdleTimer) clearTimeout(passageIdleTimer);
    passageIdleTimer = setTimeout(() => {
      // A job that started after this timer was armed is still running (after
      // a sleep every timer fires at once): reaping now would fail it for
      // nothing. Look again later.
      if (!passageLane.idle()) { armPassageReaper(); return; }
      void passageLane.terminate();
    }, PASSAGE_IDLE_KILL_MS);
    passageIdleTimer.unref?.();
  }

  // See CachedQuery: insertion-ordered Map used as the LRU (re-set on hit
  // moves an entry to the young end; the oldest key is evicted at the cap).
  const queryCache = new Map<string, CachedQuery>();
  const recallFreshMs = config.recallFreshMs ?? DEFAULT_RECALL_FRESH_MS;
  const inflight = new Map<string, Promise<WorkerReply>>();
  function remember(key: string, entry: CachedQuery): void {
    queryCache.delete(key);
    queryCache.set(key, entry);
    if (queryCache.size > QUERY_CACHE_CAP) {
      // Map iteration is insertion order → the first key is the oldest.
      for (const oldest of queryCache.keys()) { queryCache.delete(oldest); break; }
    }
  }

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
      // One inference per text in flight. A caller that gives up at its
      // deadline leaves the job running and its answer still lands in the
      // cache, so the next lane of the same request (and the next request)
      // finds it there. Abandoning it instead made every lane of one
      // /api/search submit the same text again: three inferences racing for
      // the CPU, each slower for the others, and in production 104 of 117
      // queries on 2026-09-28 lost the 150ms deadline.
      let promise = inflight.get(cacheKey);
      if (!promise) {
        const job = queryLane.submit([prefixed], wantRecall);
        if (!job) return rescue();
        promise = job.promise.then((reply) => {
          if (!disposed) remember(cacheKey, { vec: reply.rows[0], recall: reply.recall, at: Date.now() });
          return reply;
        });
        const settled = promise.finally(() => {
          if (inflight.get(cacheKey) === promise) inflight.delete(cacheKey);
          armQueryReaper();
        });
        settled.catch(() => {}); // settled after we gave up ≠ unhandled
        inflight.set(cacheKey, promise);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The deadline timer stays REF'd: it is short-lived, cleared in
        // finally, and it is the only thing guaranteeing this race settles —
        // an unref'd timer plus the (deliberately) unref'd worker let a
        // one-shot CLI process exit before the race resolved.
        const reply = await Promise.race([
          promise,
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), deadlineMs);
          }),
        ]);
        if (!reply) return rescue();
        return { vec: reply.rows[0], recall: reply.recall, source: 'worker' };
      } catch {
        return rescue();
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    async embedPassages(texts) {
      const prefixed = texts.map((t) => (config.passagePrefix ?? '') + t.slice(0, MAX_EMBED_CHARS));
      const job = passageLane.submit(prefixed);
      if (!job) return Promise.reject(embedError('embed worker unavailable', 'unavailable'));
      try {
        return (await job.promise).rows;
      } finally {
        armPassageReaper();
      }
    },

    async releasePassageWorker() {
      if (disposed || !passageLane.running() || !passageLane.idle()) return false;
      if (passageIdleTimer) clearTimeout(passageIdleTimer);
      await passageLane.terminate();
      return true;
    },

    async suspend() {
      if (suspended || disposed) return;
      suspended = true;
      if (passageIdleTimer) clearTimeout(passageIdleTimer);
      if (queryIdleTimer) clearTimeout(queryIdleTimer);
      await Promise.all([queryLane.terminate(), passageLane.terminate()]);
    },

    resume() {
      suspended = false;
    },

    isSuspended() {
      return suspended;
    },

    async dispose() {
      disposed = true;
      queryCache.clear();
      if (passageIdleTimer) clearTimeout(passageIdleTimer);
      if (queryIdleTimer) clearTimeout(queryIdleTimer);
      await Promise.all([queryLane.terminate(), passageLane.terminate()]);
    },
  };
}

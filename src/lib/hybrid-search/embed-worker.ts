/**
 * hybrid-search embedding worker (a child process the host forks over IPC).
 *
 * Lives in its own process because model load (~10s cold) and tokenization are
 * synchronous JS — running them on the host thread would freeze every route
 * in a web process (the exact incident class that killed the old engine's
 * reranker). ONNX inference itself runs in onnxruntime's native pool, but the
 * process boundary makes the whole path unable to hurt the caller, a forced
 * stop included (embedder.ts says why it is not a worker thread).
 *
 * Config arrives as JSON in the EMBED_WORKER_CONFIG_ENV variable.
 * Protocol (host side: embedder.ts):
 *   in  : { id, texts: string[], recallK? }  texts arrive prefixed + truncated
 *   out : { id, buf: ArrayBuffer, dims, recall? }  Int8Array rows, one per text
 *         { id, error: string }
 *   in  : { id, probe: { model } }  `walnut __selftest`: load the library the way
 *         a job does and run `model` (a one-node ONNX graph) on its onnxruntime
 *   out : { id, probe: { pipeline, y } }
 *
 * Vectors are mean-pooled, L2-normalized, then quantized to int8
 * (round(v*127)): 384 bytes per vector, and cosine survives quantization to
 * ~1e-3, far below ranking noise.
 *
 * Semantic recall (recallK set): after embedding texts[0], brute-force cosine
 * over every doc's LEVEL-0 vector (12k docs ≈ 12MB, ~10-20ms) and attach the
 * top-K docIds. Runs HERE because the scan is sync CPU the host event loop
 * must never pay; the worker reads the index through its own READONLY
 * connection and caches the matrix briefly (a recall lane tolerates staleness).
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import Database from '../sqlite.js';

const requireModule = createRequire(import.meta.url);

interface WorkerConfig {
  /** A downloaded copy of @huggingface/transformers (file URL of its entry); absent: the package. */
  moduleUrl?: string;
  modelId: string;
  dims: number;
  /** transformers.js dtype, default 'q8'. */
  dtype?: string;
  cacheDir?: string;
  /** 'mean' (default; e5 family) or 'last' (Qwen3-Embedding family — the
   *  pipeline API doesn't support last-token pooling, so that path drops to
   *  AutoTokenizer/AutoModel and pools by attention mask manually). */
  pooling?: 'mean' | 'last';
  /** Index db file for the recall lane; absent = recall disabled. */
  dbPath?: string;
  /** Which embedder lane started this worker (embedder.ts makeLane). */
  lane?: 'query' | 'passage';
}

interface Job {
  id: number;
  texts: string[];
  recallK?: number;
}

// Twin of EMBED_WORKER_CONFIG_ENV in embedder.ts (this entry imports nothing
// from the host side, so its bundle stays the worker alone).
const config = JSON.parse(process.env.HYBRID_SEARCH_EMBED_WORKER_CONFIG ?? '{}') as WorkerConfig;

/** A reply to the host; dropped when the host has gone. */
function reply(msg: object): void {
  if (process.connected) process.send?.(msg, undefined, undefined, () => {});
}

/**
 * onnxruntime session thread caps. Left to its default, ort-node sizes its
 * intra-op pool to the machine's cores — measured on a 14-core Mac as SEVEN
 * threads pinned at ~45% CPU each for the hours a vector backfill runs,
 * starving every other process (and the server's own event loop) of cores.
 * Embedding is a background lane; two threads keep it far off the interactive
 * path while only ~2x-ing per-batch latency.
 */
const ORT_THREADS = { intraOpNumThreads: 2, interOpNumThreads: 1 };

/**
 * Per-lane session options. The passage lane turns weight prepacking off:
 * onnxruntime keeps a packed copy of every quantized weight beside the
 * original, about 390 MB on the default model, measured 2026-10-25 on
 * qwen3-0.6b q8 (footprint after load 1.55 GB with it, 1.17 GB without). It
 * costs the background backfill about 5% more CPU per passage, and the vectors
 * are byte-identical. The query lane keeps it: a short query embeds in 143 ms
 * with packed weights and 253 ms without (p50), and the search path gives the
 * semantic rescore 150 ms.
 */
const ORT_LANE_OPTIONS = {
  query: ORT_THREADS,
  passage: { ...ORT_THREADS, extra: { session: { disable_prepacking: '1' } } },
};
const ORT_SESSION_OPTIONS = ORT_LANE_OPTIONS[config.lane ?? 'query'];

/**
 * The model outputs to fetch. A decoder export (Qwen3-Embedding) also returns
 * its key/value cache, two tensors per layer (56 on qwen3-0.6b, up to 117 MB
 * for one 512-token passage), which transformers.js copies into JS on every
 * run and this worker never reads; that churn held the passage worker about
 * 600 MB above its loaded size. Asking onnxruntime for the hidden state alone
 * leaves the vectors byte-identical.
 */
const FETCH_ONLY = ['last_hidden_state'];

/** Make every run of `session` fetch only `outputs` (the session belongs to
 *  transformers.js, which calls run(feeds) and reads the outputs it gets). */
function fetchOnly(session: unknown, outputs: string[]): void {
  const s = session as { outputNames?: string[]; run?: (feeds: unknown, ...rest: unknown[]) => Promise<unknown> } | undefined;
  if (!s?.run || !outputs.every((name) => s.outputNames?.includes(name))) return;
  const run = s.run.bind(s);
  s.run = (feeds: unknown) => run(feeds, outputs);
}

type Extractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractorPromise: Promise<Extractor> | null = null;

/** The model library: the downloaded component's copy when the host named one, else the package. */
async function importTransformers(): Promise<typeof import('@huggingface/transformers')> {
  return config.moduleUrl ? await import(config.moduleUrl) : await import('@huggingface/transformers');
}

function loadExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const transformers = await importTransformers();
      if (config.cacheDir) {
        (transformers.env as { cacheDir?: string }).cacheDir = config.cacheDir;
      }
      if (config.pooling === 'last') return loadLastTokenExtractor(transformers);
      const pipe = await transformers.pipeline('feature-extraction', config.modelId, {
        dtype: (config.dtype ?? 'q8') as 'q8',
        device: 'cpu',
        session_options: ORT_SESSION_OPTIONS,
      });
      fetchOnly((pipe as unknown as { model?: { sessions?: Record<string, unknown> } }).model?.sessions?.model, FETCH_ONLY);
      return pipe as unknown as Extractor;
    })();
    // A transient first-load failure (network blip during the model fetch)
    // must not be cached as a permanent rejection — clear so the next job
    // retries the load. The current job still sees the error.
    extractorPromise.catch(() => { extractorPromise = null; });
  }
  return extractorPromise;
}

/** Last-token pooling via the low-level API: run the encoder, take each
 *  sequence's last attention-masked token, L2-normalize. Returns the same
 *  shape contract the pipeline path produces. */
/**
 * The tokenizer silently truncates at this length, and because this path pools
 * on the LAST token a truncated passage produces a vector describing only its
 * prefix — no error, no shorter output, nothing downstream can notice.
 * chunk.ts sizes passages to stay under it; this is the check that the estimator
 * actually succeeded, and it is the authoritative detector for that invariant.
 */
const TOKENIZER_MAX_LENGTH = 512;
let truncatedPassages = 0;
let truncationWarnedAt = 0;
/** Throttle: one line per 100 truncations, so a systematic estimator failure is
 *  loud once and never floods an hours-long backfill. */
const TRUNCATION_WARN_EVERY = 100;

function reportIfTruncated(inputs: unknown): void {
  const ids = (inputs as { input_ids?: { dims?: number[] } }).input_ids;
  const seqLen = ids?.dims?.[1];
  // Padding makes every row in the batch the same length, so `seqLen` at the cap
  // means AT LEAST one passage was truncated. Counting rows exactly would need
  // the attention mask; "at least one" is what the invariant cares about.
  if (typeof seqLen !== 'number' || seqLen < TOKENIZER_MAX_LENGTH) return;
  truncatedPassages++;
  if (truncatedPassages - truncationWarnedAt < TRUNCATION_WARN_EVERY
    && truncationWarnedAt !== 0) return;
  truncationWarnedAt = truncatedPassages;
  console.warn(
    `[embed-worker] passage hit the ${TOKENIZER_MAX_LENGTH}-token cap and was `
    + `truncated (${truncatedPassages} batch(es) so far). The passage policy in `
    + `chunk.ts is meant to prevent this — its token estimator is under-counting `
    + `for some script, and those vectors describe only the start of their text.`,
  );
}

async function loadLastTokenExtractor(
  transformers: typeof import('@huggingface/transformers'),
): Promise<Extractor> {
  const tokenizer = await transformers.AutoTokenizer.from_pretrained(config.modelId);
  const model = await transformers.AutoModel.from_pretrained(config.modelId, {
    dtype: (config.dtype ?? 'q8') as 'q8',
    device: 'cpu',
    session_options: ORT_SESSION_OPTIONS,
  });
  fetchOnly((model as unknown as { sessions?: Record<string, unknown> }).sessions?.model, FETCH_ONLY);
  return (async (texts: string[]) => {
    const inputs = await tokenizer(texts, { padding: true, truncation: true, max_length: TOKENIZER_MAX_LENGTH });
    reportIfTruncated(inputs);
    const out = await model(inputs);
    const hidden = out.last_hidden_state as { dims: number[]; data: Float32Array };
    const [batch, seq, dim] = hidden.dims;
    const mask = inputs.attention_mask as { data: ArrayLike<number | bigint> };
    const data = new Float32Array(batch * dim);
    for (let b = 0; b < batch; b++) {
      let last = 0;
      for (let s = 0; s < seq; s++) {
        if (Number(mask.data[b * seq + s]) === 1) last = s;
      }
      const row = hidden.data.subarray((b * seq + last) * dim, (b * seq + last + 1) * dim);
      let norm = 0;
      for (let i = 0; i < dim; i++) norm += row[i] * row[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < dim; i++) data[b * dim + i] = row[i] / norm;
    }
    return { data, dims: [batch, dim] };
  }) as Extractor;
}

function quantize(row: Float32Array): Int8Array {
  const out = new Int8Array(row.length);
  for (let i = 0; i < row.length; i++) {
    const q = Math.round(row[i] * 127);
    out[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return out;
}

// ── semantic recall: cached doc-level vector matrix + brute-force cosine ──

const MATRIX_TTL_MS = 30_000;

interface VecMatrix {
  ids: number[];
  /** n × dims, row-major. */
  mat: Int8Array;
  loadedAt: number;
}

let matrix: VecMatrix | null = null;

function loadMatrix(): VecMatrix | null {
  if (!config.dbPath) return null;
  if (matrix && Date.now() - matrix.loadedAt < MATRIX_TTL_MS) return matrix;
  try {
    // Own READONLY connection: WAL supports readers in other processes, and
    // this worker must never be able to write or lock the host's handle.
    const db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(
        'SELECT doc_id, vec FROM doc_vec WHERE seq = 0',
      ).all() as Array<{ doc_id: number; vec: Buffer }>;
      const ids: number[] = [];
      const mat = new Int8Array(rows.length * config.dims);
      let n = 0;
      for (const row of rows) {
        if (row.vec.byteLength !== config.dims) continue; // model changed mid-flight
        mat.set(new Int8Array(row.vec.buffer, row.vec.byteOffset, config.dims), n * config.dims);
        ids.push(row.doc_id);
        n++;
      }
      matrix = { ids, mat: mat.subarray(0, n * config.dims), loadedAt: Date.now() };
      return matrix;
    } finally {
      db.close();
    }
  } catch {
    return null; // recall is an enhancement — no matrix, no recall
  }
}

/** Top-K doc ids by cosine against the level-0 matrix. Quarantined zero
 *  vectors score 0 and never surface. */
function recallTopK(queryVec: Int8Array, k: number): Array<{ docId: number; cos: number }> {
  const m = loadMatrix();
  if (!m || m.ids.length === 0) return [];
  const dims = config.dims;
  let qNorm = 0;
  for (let i = 0; i < dims; i++) qNorm += queryVec[i] * queryVec[i];
  if (qNorm === 0) return [];
  const top: Array<{ docId: number; cos: number }> = [];
  for (let r = 0; r < m.ids.length; r++) {
    const off = r * dims;
    let dot = 0;
    let dNorm = 0;
    for (let i = 0; i < dims; i++) {
      const d = m.mat[off + i];
      dot += queryVec[i] * d;
      dNorm += d * d;
    }
    if (dNorm === 0) continue;
    const cos = dot / Math.sqrt(qNorm * dNorm);
    if (top.length < k) {
      top.push({ docId: m.ids[r], cos });
      if (top.length === k) top.sort((a, b) => a.cos - b.cos);
    } else if (cos > top[0].cos) {
      top[0] = { docId: m.ids[r], cos };
      top.sort((a, b) => a.cos - b.cos);
    }
  }
  return top.sort((a, b) => b.cos - a.cos);
}

/**
 * How this worker ends. Exiting while onnxruntime is inside a run aborts the
 * process ("libc++abi: terminating due to uncaught exception of type
 * Napi::Error", exit 134); when this was a worker thread, that took the host
 * with it (the production server, 2026-09-29). So the worker still ends only
 * between runs: the host sends { stop: true }, and a host that died without
 * killing its workers on the way out (embedder.ts) closes the IPC channel;
 * either way the worker exits once its jobs have finished. A run that never
 * finishes is the host's to kill or, with the host gone, ends at
 * ORPHAN_EXIT_MS.
 */
let activeJobs = 0;
let stopping = false;
const ORPHAN_EXIT_MS = 30_000;

function exitIfDrained(): void {
  if (stopping && activeJobs === 0) process.exit(0);
}

process.on('disconnect', () => {
  stopping = true;
  exitIfDrained();
  setTimeout(() => process.exit(0), ORPHAN_EXIT_MS).unref();
});

interface Probe { id: number; probe: { model: Uint8Array } }

type Ort = {
  InferenceSession: { create(model: Uint8Array): Promise<{ run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>> }> };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
};

/** The library loads here as a job loads it, and its onnxruntime runs a model in this process. */
async function probe(job: Probe): Promise<void> {
  try {
    const transformers = await importTransformers();
    // The onnxruntime next to the library: the component's own copy when it is one.
    const req = config.moduleUrl ? createRequire(fileURLToPath(config.moduleUrl)) : requireModule;
    const ort = req('onnxruntime-node') as Ort;
    const session = await ort.InferenceSession.create(job.probe.model);
    const out = await session.run({ x: new ort.Tensor('float32', Float32Array.from([1.5, -2]), [2]) });
    reply({ id: job.id, probe: { pipeline: typeof transformers.pipeline, y: Array.from(out.y.data) } });
  } catch (err) {
    reply({ id: job.id, error: err instanceof Error ? err.message : String(err) });
  } finally {
    activeJobs--;
    exitIfDrained();
  }
}

process.on('message', (msg: Job | Probe | { stop: true }) => {
  if ('stop' in msg) {
    stopping = true;
    exitIfDrained();
    return;
  }
  if ('probe' in msg) {
    activeJobs++;
    void probe(msg);
    return;
  }
  const job = msg;
  if (stopping) {
    reply({ id: job.id, error: 'embed worker stopping' });
    return;
  }
  activeJobs++;
  void (async () => {
    try {
      const extractor = await loadExtractor();
      const result = await extractor(job.texts, { pooling: 'mean', normalize: true });
      const dims = result.dims[result.dims.length - 1];
      const out = new Int8Array(job.texts.length * dims);
      for (let row = 0; row < job.texts.length; row++) {
        out.set(quantize(result.data.subarray(row * dims, (row + 1) * dims) as Float32Array), row * dims);
      }
      const recall = job.recallK
        ? recallTopK(out.subarray(0, dims), job.recallK)
        : undefined;
      reply({ id: job.id, buf: out.buffer, dims, recall });
    } catch (err) {
      reply({
        id: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      activeJobs--;
      exitIfDrained();
    }
  })();
});

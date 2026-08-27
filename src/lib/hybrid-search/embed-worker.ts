/**
 * hybrid-search embedding worker (worker_threads script).
 *
 * Lives in its own thread because model load (~10s cold) and tokenization are
 * synchronous JS — running them on the host thread would freeze every route
 * in a web process (the exact incident class that killed the old engine's
 * reranker). ONNX inference itself runs in onnxruntime's native pool, but the
 * thread boundary makes the whole path unable to hurt the caller.
 *
 * Protocol (host side: embedder.ts):
 *   in  : { id, texts: string[], recallK? }  texts arrive prefixed + truncated
 *   out : { id, buf: ArrayBuffer, dims, recall? }  Int8Array rows, one per text
 *         { id, error: string }
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

import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

const requireModule = createRequire(import.meta.url);

interface WorkerConfig {
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
}

interface Job {
  id: number;
  texts: string[];
  recallK?: number;
}

const config = (workerData ?? {}) as WorkerConfig;

/**
 * onnxruntime session thread caps. Left to its default, ort-node sizes its
 * intra-op pool to the machine's cores — measured on a 14-core Mac as SEVEN
 * threads pinned at ~45% CPU each for the hours a vector backfill runs,
 * starving every other process (and the server's own event loop) of cores.
 * Embedding is a background lane; two threads keep it far off the interactive
 * path while only ~2x-ing per-batch latency.
 */
const ORT_SESSION_OPTIONS = { intraOpNumThreads: 2, interOpNumThreads: 1 };

type Extractor = (
  texts: string[],
  opts: { pooling: 'mean'; normalize: boolean },
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractorPromise: Promise<Extractor> | null = null;

function loadExtractor(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const transformers = await import('@huggingface/transformers');
      if (config.cacheDir) {
        (transformers.env as { cacheDir?: string }).cacheDir = config.cacheDir;
      }
      if (config.pooling === 'last') return loadLastTokenExtractor(transformers);
      const pipe = await transformers.pipeline('feature-extraction', config.modelId, {
        dtype: (config.dtype ?? 'q8') as 'q8',
        device: 'cpu',
        session_options: ORT_SESSION_OPTIONS,
      });
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
async function loadLastTokenExtractor(
  transformers: typeof import('@huggingface/transformers'),
): Promise<Extractor> {
  const tokenizer = await transformers.AutoTokenizer.from_pretrained(config.modelId);
  const model = await transformers.AutoModel.from_pretrained(config.modelId, {
    dtype: (config.dtype ?? 'q8') as 'q8',
    device: 'cpu',
    session_options: ORT_SESSION_OPTIONS,
  });
  return (async (texts: string[]) => {
    const inputs = await tokenizer(texts, { padding: true, truncation: true, max_length: 512 });
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
    // Own READONLY connection: WAL supports cross-thread readers, and this
    // worker must never be able to write or lock the host's handle.
    const Database = requireModule('better-sqlite3') as typeof import('better-sqlite3');
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

parentPort?.on('message', (job: Job) => {
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
      parentPort?.postMessage({ id: job.id, buf: out.buffer, dims, recall }, [out.buffer]);
    } catch (err) {
      parentPort?.postMessage({
        id: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});

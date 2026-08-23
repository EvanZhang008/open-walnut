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
 *   in  : { id, texts: string[] }            texts arrive prefixed + truncated
 *   out : { id, buf: ArrayBuffer, dims }     Int8Array rows, one per text
 *         { id, error: string }
 *
 * Vectors are mean-pooled, L2-normalized, then quantized to int8
 * (round(v*127)): 384 bytes per vector, and cosine survives quantization to
 * ~1e-3, far below ranking noise.
 */

import { parentPort, workerData } from 'node:worker_threads';

interface WorkerConfig {
  modelId: string;
  dims: number;
  /** transformers.js dtype, default 'q8'. */
  dtype?: string;
  cacheDir?: string;
}

interface Job {
  id: number;
  texts: string[];
}

const config = (workerData ?? {}) as WorkerConfig;

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
      const pipe = await transformers.pipeline('feature-extraction', config.modelId, {
        dtype: (config.dtype ?? 'q8') as 'q8',
        device: 'cpu',
      });
      return pipe as unknown as Extractor;
    })();
  }
  return extractorPromise;
}

function quantize(row: Float32Array): Int8Array {
  const out = new Int8Array(row.length);
  for (let i = 0; i < row.length; i++) {
    const q = Math.round(row[i] * 127);
    out[i] = q > 127 ? 127 : q < -127 ? -127 : q;
  }
  return out;
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
      parentPort?.postMessage({ id: job.id, buf: out.buffer, dims }, [out.buffer]);
    } catch (err) {
      parentPort?.postMessage({
        id: job.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});

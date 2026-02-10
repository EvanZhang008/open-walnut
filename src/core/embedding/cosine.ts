/**
 * Pure math utilities for cosine similarity on Float32Array vectors.
 * No external dependencies.
 */

/** Cosine similarity between two Float32Array vectors. Assumes L2-normalized inputs (returns dot product). */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/** Return top-K items by cosine similarity to the query vector. */
export function topK(
  queryVec: Float32Array,
  candidates: Array<{ id: string; embedding: Float32Array }>,
  k: number,
): Array<{ id: string; score: number }> {
  const scored = candidates.map((c) => ({
    id: c.id,
    score: cosineSimilarity(queryVec, c.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** Deserialize a Buffer (from SQLite BLOB) into Float32Array. */
export function bufferToFloat32(buf: Buffer): Float32Array {
  // Ensure proper alignment by copying into a new ArrayBuffer
  const ab = new ArrayBuffer(buf.length);
  const view = new Uint8Array(ab);
  for (let i = 0; i < buf.length; i++) view[i] = buf[i];
  return new Float32Array(ab);
}

/** Serialize a Float32Array into a Buffer for SQLite BLOB storage. */
export function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * The semantic rescore's vector read and cosine math, in one place for both
 * sides that run it: the query-lane embed worker (embed-worker.ts, the normal
 * path, off the host's event loop) and searchSemantic's in-thread fallback for
 * an index the worker cannot open (index.ts, a :memory: db). Imports nothing,
 * so the worker bundle stays the worker alone.
 */

/** Cosine of two int8 vectors of the same length; 0 when either is all zeros. */
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

/** The one statement shape the rescore reads (better-sqlite3 API, src/lib/sqlite.ts). */
interface VecReader {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/** Ids per statement: well under SQLite's bound-parameter limit. */
const IDS_PER_STATEMENT = 500;

/**
 * Max cosine of `query` over each doc's chunk vectors (the best-matching
 * passage speaks for the doc). A vector whose length differs from the query's
 * is skipped (the model changed mid-flight); a doc with no usable vector is
 * absent from the result.
 */
export function readMaxCosines(db: VecReader, query: Int8Array, ids: readonly number[]): Map<number, number> {
  const best = new Map<number, number>();
  for (let from = 0; from < ids.length; from += IDS_PER_STATEMENT) {
    const chunk = ids.slice(from, from + IDS_PER_STATEMENT);
    const rows = db.prepare(
      `SELECT doc_id, vec FROM doc_vec WHERE doc_id IN (${chunk.map(() => '?').join(',')})`,
    ).all(...chunk) as Array<{ doc_id: number; vec: Uint8Array }>;
    for (const row of rows) {
      if (row.vec.byteLength !== query.length) continue;
      const cos = cosineInt8(query, new Int8Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength));
      const prev = best.get(row.doc_id);
      if (prev === undefined || cos > prev) best.set(row.doc_id, cos);
    }
  }
  return best;
}

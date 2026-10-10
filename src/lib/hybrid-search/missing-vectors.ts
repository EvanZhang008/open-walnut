/**
 * The vector backfill's work queue: which docs have no vectors yet
 * (Writer.listDocsMissingVectors, writer.ts). Moved out of writer.ts unchanged.
 *
 * Cost is bounded by `scanLimit` doc rows per call, never by the table size:
 * the walk runs on the host thread of a live web server.
 */

import type { Statement } from 'better-sqlite3';
import type { SearchDb } from './db.js';

/** Keyset position in the missing-vectors walk (updated_at DESC, id DESC). */
export interface MissingVecCursor {
  updatedAt: number;
  id: number;
}

export interface MissingVecOptions {
  /** Floor on updated_at: the walk never looks below it. Omitted = the whole
   *  table (the periodic self-heal pass). */
  minUpdatedAt?: number;
  /** Hard cap on doc rows ONE call may examine. Default MISSING_VEC_SCAN_LIMIT. */
  scanLimit?: number;
  /**
   * Skip docs whose note is longer than this. The light phase of the two-phase
   * backfill walk uses it so cheap single-passage docs are vectored before
   * multi-passage whales: in plain updated_at order a few thousand short docs
   * were starved for a DAY behind the expensive tail.
   *
   * This replaced an `excludeKinds` split by kind, which stopped meaning
   * anything once every kind became chunked. Filtering here is free: the doc row
   * is already materialized for embedding, so no extra read is paid.
   */
  maxNoteChars?: number;
  /**
   * A doc whose only vector is the zero marker (seq 0 all zero: a quarantine,
   * or the sentinel of a doc with no text) counts as vectored, unless this says
   * to retry it; then it is handed out with `zeroMarker` set. The index retries
   * each marker once per process, which is how a quarantine expires.
   */
  retryZero?: (docId: number) => boolean;
}

export interface MissingVecPage {
  docs: Array<{
    id: number; kind: string; ref: string; title: string; summary: string; note: string;
    /** Content hash at listing time: hand it back to the vector write. */
    hash: string;
    /** Listed only because `retryZero` asked for its zero marker to be retried. */
    zeroMarker?: boolean;
  }>;
  cursor: MissingVecCursor | null;
  /** True when the walk reached the end of its range (the floor, or the oldest
   *  doc) with nothing left over, so this pass is complete. */
  drained: boolean;
  /** Doc rows examined by this call. Bounded by scanLimit by construction; a
   *  test asserting this stays small is what keeps the full-table anti-join
   *  from creeping back. */
  scanned: number;
}

/**
 * Doc rows one call may examine.
 *
 * Measured on the real 493MB / 11,894-doc index: total cost of a whole two-phase
 * walk is FLAT across 64-512 (190-210 ms warm), so this knob buys nothing on
 * throughput and everything on the length of a single blocked stretch: the
 * per-row cost is a PK seek into doc_vec, i.e. page reads. Warm max per call:
 * 1.1 ms at 64, 1.7 ms at 128, 2.9 ms at 256, 6.1 ms at 512. COLD (a fresh
 * process, which is what a CPU profile catches) 256 measured a 179 ms worst
 * call, and that scales with the window, so 128 halves the worst case for 186
 * paced calls per hourly self-heal pass instead of 94.
 */
export const MISSING_VEC_SCAN_LIMIT = 128;

/** Prepared statement with the default loose bind signature: ReturnType of
 *  the generic prepare() cannot be spread into. */
type Stmt = Statement<unknown[]>;

/** The missing-vectors walk over `db` (Writer.listDocsMissingVectors). */
export function createMissingVecWalk(db: SearchDb): (
  limit: number,
  cursor?: MissingVecCursor | null,
  excludeKinds?: string[],
  options?: MissingVecOptions,
) => MissingVecPage {
  // The missing-vectors walk, in two bounded statements.
  //
  // Step 1 takes the next <= scanLimit ids in walk order. It is a COVERING read
  // of doc_updated_id (an index on a rowid table already carries `id`), so it
  // never touches a doc row: note/session bodies stay on disk. `updated_at <=
  // ?` is what makes the keyset resume a SEEK rather than a scan down from the
  // newest row; the OR pair breaks the id tie at that timestamp.
  //
  // Step 2 asks which of those ids already have vectors. seq 0 always exists
  // when a doc has any vectors (writeVectors rewrites from 0, and the recall
  // lane in embed-worker.ts already relies on the same invariant), so `seq = 0`
  // makes each probe an exact PK seek instead of a range walk across the doc's
  // chunk blobs.
  //
  // What this deliberately does NOT do is filter `kind` in SQL. `kind` is not in
  // the walk index, so a SQL kind filter costs one doc-row lookup per SCANNED
  // row: that lookup is why the old light-phase query was the slower of the
  // two. The caller uses excludeKinds to vectorize cheap single-vector kinds
  // before multi-chunk whales, so a few thousand notes are not starved for hours
  // behind ten thousand chunked sessions; that filter now runs in JS, over the
  // handful of rows actually handed out.
  const missingSliceFirst = db.prepare(
    `SELECT id, updated_at FROM doc WHERE updated_at >= ?
     ORDER BY updated_at DESC, id DESC LIMIT ?`,
  );
  const missingSliceAfter = db.prepare(
    `SELECT id, updated_at FROM doc
     WHERE updated_at <= ? AND (updated_at < ? OR id < ?) AND updated_at >= ?
     ORDER BY updated_at DESC, id DESC LIMIT ?`,
  );
  /** One prepared probe per window width (in practice: one). The id list is
   *  padded to a fixed width with 0 (a value no rowid can take) so the statement
   *  shape (and with it the prepared plan) never churns. */
  const vecProbeStmts = new Map<string, Stmt>();
  /** `zero` adds whether seq 0 is the zero marker: the vector is on the leaf
   *  page the PK seek already reads, so the compare costs no extra I/O. */
  function vecProbeFor(width: number, zero: boolean): Stmt {
    const key = `${width}:${zero}`;
    let stmt = vecProbeStmts.get(key);
    if (!stmt) {
      stmt = db.prepare(
        `SELECT doc_id${zero ? ', vec = zeroblob(length(vec)) AS zero' : ''} FROM doc_vec WHERE seq = 0
         AND doc_id IN (${Array.from({ length: width }, () => '?').join(',')})`,
      );
      vecProbeStmts.set(key, stmt);
    }
    return stmt;
  }
  const missingBodyStmts = new Map<number, Stmt>();
  function missingBodiesFor(count: number): Stmt {
    let stmt = missingBodyStmts.get(count);
    if (!stmt) {
      stmt = db.prepare(
        `SELECT id, kind, ref, title, summary, note, hash FROM doc
         WHERE id IN (${Array.from({ length: count }, () => '?').join(',')})`,
      );
      missingBodyStmts.set(count, stmt);
    }
    return stmt;
  }

  function listDocsMissingVectors(
    limit: number,
    cursor?: MissingVecCursor | null,
    excludeKinds?: string[],
    options?: MissingVecOptions,
  ): MissingVecPage {
    const scanLimit = Math.max(limit, options?.scanLimit ?? MISSING_VEC_SCAN_LIMIT);
    const floor = options?.minUpdatedAt ?? Number.MIN_SAFE_INTEGER;
    const rows = (cursor
      ? missingSliceAfter.all(cursor.updatedAt, cursor.updatedAt, cursor.id, floor, scanLimit)
      : missingSliceFirst.all(floor, scanLimit)) as Array<{ id: number; updated_at: number }>;
    if (rows.length === 0) {
      return { docs: [], cursor: cursor ?? null, drained: true, scanned: 0 };
    }
    const probeIds: number[] = rows.map((r) => r.id);
    while (probeIds.length < scanLimit) probeIds.push(0);
    const retryZero = options?.retryZero;
    const vectored = new Set<number>();
    const zeroRetry = new Set<number>();
    for (const r of vecProbeFor(scanLimit, Boolean(retryZero)).all(...probeIds) as Array<{ doc_id: number; zero?: number }>) {
      if (r.zero && retryZero?.(r.doc_id)) zeroRetry.add(r.doc_id);
      else vectored.add(r.doc_id);
    }
    const missing = rows.filter((r) => !vectored.has(r.id));
    // Only the first `limit` missing docs are handed out, so the cursor stops at
    // the last row this call actually consumed, never past unprocessed work.
    const head = missing.slice(0, limit);
    const consumed = missing.length > limit ? missing[limit - 1] : rows[rows.length - 1];
    const drained = missing.length <= limit && rows.length < scanLimit;
    const docs: MissingVecPage['docs'] = [];
    if (head.length > 0) {
      const byId = new Map(
        (missingBodiesFor(head.length).all(...head.map((r) => r.id)) as MissingVecPage['docs'])
          .map((row) => [row.id, row] as const),
      );
      const excluded = excludeKinds?.length ? new Set(excludeKinds) : null;
      const maxNote = options?.maxNoteChars;
      for (const row of head) { // walk order, not the rowid order of the IN fetch
        const body = byId.get(row.id);
        if (!body) continue;
        if (excluded?.has(body.kind)) continue;
        if (maxNote !== undefined && body.note.length > maxNote) continue;
        docs.push(zeroRetry.has(row.id) ? { ...body, zeroMarker: true } : body);
      }
    }
    return {
      docs,
      cursor: { updatedAt: consumed.updated_at, id: consumed.id },
      drained,
      scanned: rows.length,
    };
  }
  return listDocsMissingVectors;
}

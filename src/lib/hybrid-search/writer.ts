/**
 * hybrid-search write path — upsert / remove / rebuild.
 *
 * Write protocol (single transaction per doc; deviating corrupts the index
 * silently because contentless FTS5 cannot be diffed against `doc`):
 *   1. DELETE FROM doc_fts WHERE rowid = existing id (plain DELETE — the
 *      special 'delete' insert syntax errors on contentless_delete tables)
 *   2. UPDATE/INSERT the doc row, PRESERVING the rowid (doc_vec + ident
 *      reference it; INSERT OR REPLACE would mint a new one)
 *   3. INSERT the tokenized streams into doc_fts at that rowid
 *   4. rewrite ident rows
 *   5. drop doc_vec rows — stale vectors must not rescore new content
 *
 * A content hash (fields + identifiers, NOT updatedAt) skips unchanged docs;
 * a pure timestamp change costs one UPDATE and no FTS work.
 *
 * Step 5 is why the vector backfill can be cheap: the ONLY in-process way a doc
 * loses its vectors is this transaction, which writes `updated_at` in the same
 * breath. So "which docs need embedding?" can be asked about a timestamp range
 * instead of the whole table (listDocsMissingVectors + minUpdatedAt). The
 * exceptions all wipe doc_vec wholesale at a moment the caller knows about —
 * rebuildAll here, and the schema/embed-model gates in db.ts — so the caller
 * arms a full walk after them rather than trusting a floor.
 */

import { createHash } from 'node:crypto';
import type { Statement } from 'better-sqlite3';
import { tokenize } from './tokenizer.js';
import { FTS_DDL, type SearchDb } from './db.js';

export interface Doc {
  /** Arbitrary caller-defined kind ('task', 'note', …). Never an enum here. */
  kind: string;
  /** Caller's stable id for the doc within its kind. */
  ref: string;
  title: string;
  summary?: string;
  note?: string;
  meta?: string;
  /** Epoch ms. Feeds the recency score component. */
  updatedAt: number;
  /** Exact-match identifiers (ids, ticket numbers, SHAs, URLs). */
  identifiers?: string[];
}

export interface UpsertResult {
  docId: number;
  /** False when the content hash matched and only (at most) updated_at moved. */
  changed: boolean;
}

export interface Writer {
  upsert(doc: Doc): UpsertResult;
  remove(kind: string, ref: string): boolean;
  /** Wipe + re-feed everything. Accepts an async source so a large corpus can
   *  stream (docs are batched into transactions, never all held in memory);
   *  call optimize() (via the index handle) afterwards. */
  rebuildAll(docs: Iterable<Doc> | AsyncIterable<Doc>): Promise<{ inserted: number }>;
  /** Re-tokenize doc_fts from the stored doc rows (tokenizer/FTS version bump
   *  path — no source re-read needed). Assumes doc_fts is freshly empty. */
  reindexFtsFromDocs(): { reindexed: number };
  /** Replace a doc's vectors (seq = array index). No-op if the doc vanished. */
  writeVectors(docId: number, vectors: Int8Array[]): void;
  /** Docs with no vectors yet — the backfill work queue. upsert() drops a
   *  changed doc's vectors, so this walk also self-heals staleness.
   *
   *  Cost is bounded by `scanLimit` doc rows per call, NEVER by the table size:
   *  the batches run on the host thread of a live web server, and this used to
   *  be a full anti-join scan (measured on a 493MB / 11,894-doc index: 590-1006
   *  ms of BLOCKED event loop per call, twice per cycle, growing with the doc
   *  count). Pass `minUpdatedAt` to skip the docs an earlier drained pass
   *  already verified — that turns the steady-state walk into a range seek over
   *  the tail of doc_updated_id (measured: 0.05 ms). Note bodies are fetched by
   *  id for just the returned batch. */
  listDocsMissingVectors(
    limit: number,
    cursor?: MissingVecCursor | null,
    excludeKinds?: string[],
    options?: MissingVecOptions,
  ): MissingVecPage;
}

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
}

export interface MissingVecPage {
  docs: Array<{
    id: number; kind: string; ref: string; title: string; summary: string; note: string;
  }>;
  cursor: MissingVecCursor | null;
  /** True when the walk reached the end of its range (the floor, or the oldest
   *  doc) with nothing left over — i.e. this pass is complete. */
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
 * throughput and everything on the length of a single blocked stretch — the
 * per-row cost is a PK seek into doc_vec, i.e. page reads. Warm max per call:
 * 1.1 ms at 64, 1.7 ms at 128, 2.9 ms at 256, 6.1 ms at 512. COLD (a fresh
 * process, which is what a CPU profile catches) 256 measured a 179 ms worst
 * call, and that scales with the window, so 128 halves the worst case for 186
 * paced calls per hourly self-heal pass instead of 94.
 */
export const MISSING_VEC_SCAN_LIMIT = 128;

function contentHash(doc: Doc): string {
  const h = createHash('sha1');
  h.update(doc.title);
  h.update('\u0000');
  h.update(doc.summary ?? '');
  h.update('\u0000');
  h.update(doc.note ?? '');
  h.update('\u0000');
  h.update(doc.meta ?? '');
  h.update('\u0000');
  h.update((doc.identifiers ?? []).join('\u0001'));
  return h.digest('hex');
}

/** Tokenize the four text fields into the 8 FTS column payloads: orig stream
 *  per field + sub stream per field (per-field sub keeps title-weight for
 *  subword hits and makes cross-field phrase chaining impossible). */
function buildFtsColumns(doc: Pick<Doc, 'title' | 'summary' | 'note' | 'meta'>): string[] {
  const fields = [doc.title, doc.summary ?? '', doc.note ?? '', doc.meta ?? ''];
  const origCols: string[] = [];
  const subCols: string[] = [];
  for (const field of fields) {
    const { orig, sub } = tokenize(field);
    origCols.push(orig.join(' '));
    subCols.push(sub.join(' '));
  }
  return [...origCols, ...subCols];
}

/** Prepared statement with the default loose bind signature — ReturnType of
 *  the generic prepare() cannot be spread into. */
type Stmt = Statement<unknown[]>;

export function createWriter(db: SearchDb): Writer {
  const selectExisting = db.prepare(
    `SELECT id, hash, updated_at FROM doc WHERE kind = ? AND ref = ?`,
  );
  const touchUpdatedAt = db.prepare(`UPDATE doc SET updated_at = ? WHERE id = ?`);
  const updateDoc = db.prepare(
    `UPDATE doc SET title = ?, summary = ?, note = ?, meta = ?, updated_at = ?, hash = ?
     WHERE id = ?`,
  );
  const insertDoc = db.prepare(
    `INSERT INTO doc (kind, ref, title, summary, note, meta, updated_at, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteFts = db.prepare(`DELETE FROM doc_fts WHERE rowid = ?`);
  const insertFts = db.prepare(
    `INSERT INTO doc_fts (rowid, title, summary, note, meta, tsub, ssub, nsub, msub)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteIdent = db.prepare(`DELETE FROM ident WHERE doc_id = ?`);
  const insertIdent = db.prepare(
    `INSERT OR IGNORE INTO ident (token, doc_id, field) VALUES (?, ?, ?)`,
  );
  const deleteVec = db.prepare(`DELETE FROM doc_vec WHERE doc_id = ?`);
  const deleteDoc = db.prepare(`DELETE FROM doc WHERE id = ?`);

  const upsertTx = db.transaction((doc: Doc, hash: string): UpsertResult => {
    const existing = selectExisting.get(doc.kind, doc.ref) as
      | { id: number; hash: string; updated_at: number }
      | undefined;

    if (existing && existing.hash === hash) {
      if (existing.updated_at !== doc.updatedAt) {
        touchUpdatedAt.run(doc.updatedAt, existing.id);
      }
      return { docId: existing.id, changed: false };
    }

    let docId: number;
    if (existing) {
      deleteFts.run(existing.id);
      updateDoc.run(
        doc.title, doc.summary ?? '', doc.note ?? '', doc.meta ?? '',
        doc.updatedAt, hash, existing.id,
      );
      docId = existing.id;
    } else {
      const info = insertDoc.run(
        doc.kind, doc.ref, doc.title, doc.summary ?? '', doc.note ?? '',
        doc.meta ?? '', doc.updatedAt, hash,
      );
      docId = Number(info.lastInsertRowid);
    }

    insertFts.run(docId, ...buildFtsColumns(doc));

    deleteIdent.run(docId);
    for (const raw of doc.identifiers ?? []) {
      const token = raw.trim().toLowerCase();
      if (token) insertIdent.run(token, docId, 'ident');
    }

    deleteVec.run(docId);
    return { docId, changed: true };
  });

  const removeTx = db.transaction((kind: string, ref: string): boolean => {
    const existing = selectExisting.get(kind, ref) as { id: number } | undefined;
    if (!existing) return false;
    deleteFts.run(existing.id);
    deleteDoc.run(existing.id); // doc_vec + ident cascade (foreign_keys=ON)
    return true;
  });

  function upsert(doc: Doc): UpsertResult {
    return upsertTx(doc, contentHash(doc));
  }

  const REBUILD_BATCH = 500;

  async function rebuildAll(
    docs: Iterable<Doc> | AsyncIterable<Doc>,
  ): Promise<{ inserted: number }> {
    db.exec(`
      DELETE FROM ident;
      DELETE FROM doc_vec;
      DELETE FROM doc;
      DROP TABLE IF EXISTS doc_fts;
    `);
    db.exec(FTS_DDL);
    let inserted = 0;
    let batch: Doc[] = [];
    const insertBatch = db.transaction((items: Doc[]) => {
      for (const doc of items) {
        upsertTx(doc, contentHash(doc));
        inserted++;
      }
    });
    for await (const doc of docs) {
      batch.push(doc);
      if (batch.length >= REBUILD_BATCH) {
        insertBatch(batch);
        batch = [];
      }
    }
    if (batch.length > 0) insertBatch(batch);
    return { inserted };
  }

  const insertVec = db.prepare(
    `INSERT OR REPLACE INTO doc_vec (doc_id, seq, vec) VALUES (?, ?, ?)`,
  );
  const docExists = db.prepare(`SELECT 1 FROM doc WHERE id = ?`);
  const writeVectorsTx = db.transaction((docId: number, vectors: Int8Array[]) => {
    // The doc may have been removed between the embed request and this write.
    if (!docExists.get(docId)) return;
    deleteVec.run(docId);
    for (let seq = 0; seq < vectors.length; seq++) {
      insertVec.run(docId, seq, Buffer.from(vectors[seq].buffer, vectors[seq].byteOffset, vectors[seq].byteLength));
    }
  });

  // The missing-vectors walk, in two bounded statements.
  //
  // Step 1 takes the next <= scanLimit ids in walk order. It is a COVERING read
  // of doc_updated_id (an index on a rowid table already carries `id`), so it
  // never touches a doc row — note/session bodies stay on disk. `updated_at <=
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
  // row — that lookup is why the old light-phase query was the slower of the
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
   *  shape — and with it the prepared plan — never churns. */
  const vecProbeStmts = new Map<number, Stmt>();
  function vecProbeFor(width: number): Stmt {
    let stmt = vecProbeStmts.get(width);
    if (!stmt) {
      stmt = db.prepare(
        `SELECT doc_id FROM doc_vec WHERE seq = 0
         AND doc_id IN (${Array.from({ length: width }, () => '?').join(',')})`,
      );
      vecProbeStmts.set(width, stmt);
    }
    return stmt;
  }
  const missingBodyStmts = new Map<number, Stmt>();
  function missingBodiesFor(count: number): Stmt {
    let stmt = missingBodyStmts.get(count);
    if (!stmt) {
      stmt = db.prepare(
        `SELECT id, kind, ref, title, summary, note FROM doc
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
    const vectored = new Set(
      (vecProbeFor(scanLimit).all(...probeIds) as Array<{ doc_id: number }>)
        .map((r) => r.doc_id),
    );
    const missing = rows.filter((r) => !vectored.has(r.id));
    // Only the first `limit` missing docs are handed out, so the cursor stops at
    // the last row this call actually consumed — never past unprocessed work.
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
      for (const row of head) { // walk order, not the rowid order of the IN fetch
        const body = byId.get(row.id);
        if (body && !excluded?.has(body.kind)) docs.push(body);
      }
    }
    return {
      docs,
      cursor: { updatedAt: consumed.updated_at, id: consumed.id },
      drained,
      scanned: rows.length,
    };
  }

  function reindexFtsFromDocs(): { reindexed: number } {
    const rows = db.prepare(
      `SELECT id, title, summary, note, meta FROM doc ORDER BY id`,
    ).all() as Array<{ id: number; title: string; summary: string; note: string; meta: string }>;
    let reindexed = 0;
    const insertBatch = db.transaction((items: typeof rows) => {
      for (const row of items) {
        insertFts.run(row.id, ...buildFtsColumns(row));
        reindexed++;
      }
    });
    for (let i = 0; i < rows.length; i += REBUILD_BATCH) {
      insertBatch(rows.slice(i, i + REBUILD_BATCH));
    }
    return { reindexed };
  }

  return {
    upsert,
    remove: removeTx,
    rebuildAll,
    reindexFtsFromDocs,
    writeVectors: (docId, vectors) => writeVectorsTx(docId, vectors),
    listDocsMissingVectors,
  };
}

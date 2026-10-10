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
 *      (with an embedder, the vectors of passages whose text did not change
 *      move to their new seq instead: vector-reuse.ts)
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
import { tokenize } from './tokenizer.js';
import { FTS_DDL, type SearchDb } from './db.js';
import { createVectorReuse, type PassagesOf } from './vector-reuse.js';
import {
  createMissingVecWalk, type MissingVecCursor, type MissingVecOptions, type MissingVecPage,
} from './missing-vectors.js';

export {
  MISSING_VEC_SCAN_LIMIT, type MissingVecCursor, type MissingVecOptions, type MissingVecPage,
} from './missing-vectors.js';

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
  /** Vectors a content change kept because their passage text did not change. */
  reusedVectors?: number;
}

export interface WriterOptions {
  /** A doc's passage texts in seq order, under the index's passage policy (the
   *  same function the backfill embeds from). Given: a content change keeps
   *  the vectors of unchanged passages. Omitted (keyword-only): all dropped. */
  passagesOf?: PassagesOf;
  /** Told the id of every doc whose text or vectors a write changed (null: any
   *  doc may have, after a rebuild). Called inside the write's transaction, so
   *  it must only take note; a rolled-back write leaves a harmless extra note. */
  onChange?: DocChangeListener;
}

export type DocChangeListener = (docId: number | null) => void;

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
  /** Replace a doc's vectors (seq = array index). No-op, and false, when the
   *  doc vanished or its content hash is no longer `expectedHash` (the vectors
   *  were computed from text an upsert has since replaced). */
  writeVectors(docId: number, vectors: Int8Array[], expectedHash?: string): boolean;
  /**
   * Resumable write, for docs whose passages cannot all be embedded in one
   * quiet window. `vectors` maps seq -> vec for the seqs computed in THIS
   * attempt; `total` is the passage count under the current policy.
   *
   * Inserts those seqs, then writes seq 0 and drops seq >= total ONLY once every
   * seq in 1..total-1 is present. Until seq 0 lands the doc still answers the
   * `seq = 0` probe as missing, so the walk's predicate keeps its exact meaning
   * and a half-embedded doc simply re-lists and resumes. With `expectedHash`
   * set and the doc's hash since moved on, nothing is written (`stale`).
   *
   * This exists because the backfill used to discard every vector computed for
   * the in-flight doc when a query arrived. With one chunked kind that wasted a
   * session; with every kind chunked a 40-passage doc under intermittent
   * searching could embed, discard and repeat forever.
   */
  writeVectorsResumable(
    docId: number,
    vectors: Map<number, Int8Array>,
    total: number,
    expectedHash?: string,
  ): { complete: boolean; stale?: boolean };
  /** Seqs already stored for a doc — the resume point. */
  storedVecSeqs(docId: number): Set<number>;
  /** The passages the caller split a doc's text into at content hash `hash`
   *  (the backfill, before it embeds them): the doc's next change does not
   *  split that text again (vector-reuse.ts). No-op without passagesOf. */
  notePassages(docId: number, kind: string, hash: string, passages: string[]): void;
  /** Drop a doc's zero-vector marker (quarantine or empty-doc sentinel) so the
   *  doc reads as missing again. No-op when its hash is not `expectedHash`. */
  clearZeroMarker(docId: number, expectedHash: string): void;
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
export function buildFtsColumns(doc: Pick<Doc, 'title' | 'summary' | 'note' | 'meta'>): string[] {
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

export function createWriter(db: SearchDb, options: WriterOptions = {}): Writer {
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
  const insertVec = db.prepare(
    `INSERT OR REPLACE INTO doc_vec (doc_id, seq, vec) VALUES (?, ?, ?)`,
  );
  // A doc written here is no longer the copy its source sent (replica.ts).
  const deleteTag = db.prepare(`DELETE FROM replica_tag WHERE doc_id = ?`);
  const reuser = options.passagesOf ? createVectorReuse(db, options.passagesOf) : null;
  const changed = options.onChange ?? (() => {});

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

    // Read BEFORE the update: the stored seqs describe the old text.
    const reuse = existing && reuser ? reuser.collect(existing.id) : null;
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
    deleteTag.run(docId);
    changed(docId);
    if (!reuse || !reuser) return { docId, changed: true };
    return { docId, changed: true, reusedVectors: reuser.restore(docId, doc, hash, reuse) };
  });

  const removeTx = db.transaction((kind: string, ref: string): boolean => {
    const existing = selectExisting.get(kind, ref) as { id: number } | undefined;
    if (!existing) return false;
    deleteFts.run(existing.id);
    deleteDoc.run(existing.id); // doc_vec + ident + replica_tag cascade (foreign_keys=ON)
    changed(existing.id);
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
      DELETE FROM replica_tag;
      DELETE FROM doc;
      DROP TABLE IF EXISTS doc_fts;
    `);
    db.exec(FTS_DDL);
    changed(null);
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

  const docHash = db.prepare(`SELECT hash FROM doc WHERE id = ?`);
  const clearZero = db.prepare(
    `DELETE FROM doc_vec WHERE doc_id = ? AND seq = 0 AND vec = zeroblob(length(vec))`,
  );
  /** The doc as these vectors' caller saw it: 'gone', 'stale' (an upsert
   *  replaced its text while the passages were embedding) or 'ok'. */
  function vecTarget(docId: number, expectedHash?: string): 'gone' | 'stale' | 'ok' {
    const row = docHash.get(docId) as { hash: string } | undefined;
    if (!row) return 'gone';
    return expectedHash !== undefined && row.hash !== expectedHash ? 'stale' : 'ok';
  }
  const writeVectorsTx = db.transaction((docId: number, vectors: Int8Array[], expectedHash?: string): boolean => {
    // The doc may have been removed or rewritten between the embed request
    // and this write; its new text gets its own vectors on the next walk.
    if (vecTarget(docId, expectedHash) !== 'ok') return false;
    deleteVec.run(docId);
    for (let seq = 0; seq < vectors.length; seq++) {
      insertVec.run(docId, seq, Buffer.from(vectors[seq].buffer, vectors[seq].byteOffset, vectors[seq].byteLength));
    }
    changed(docId);
    return true;
  });

  const buf = (v: Int8Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  const selectVecSeqs = db.prepare(`SELECT seq FROM doc_vec WHERE doc_id = ?`);
  const deleteVecFrom = db.prepare(`DELETE FROM doc_vec WHERE doc_id = ? AND seq >= ?`);
  const writeVectorsResumableTx = db.transaction((
    docId: number,
    vectors: Map<number, Int8Array>,
    total: number,
    expectedHash?: string,
  ): { complete: boolean; stale?: boolean } => {
    const target = vecTarget(docId, expectedHash);
    if (target === 'gone') return { complete: true };
    if (target === 'stale') return { complete: false, stale: true };
    // seq 0 is written LAST and only when complete, so it never appears on a
    // partially embedded doc. Stash it until the end.
    const seq0 = vectors.get(0);
    for (const [seq, vec] of vectors) {
      if (seq === 0) continue;
      insertVec.run(docId, seq, buf(vec));
    }
    if (vectors.size > 0) changed(docId);
    const present = new Set<number>();
    for (const row of selectVecSeqs.all(docId) as Array<{ seq: number }>) present.add(row.seq);
    for (let seq = 1; seq < total; seq++) {
      if (!present.has(seq)) return { complete: false };
    }
    if (!seq0) return { complete: false };
    insertVec.run(docId, 0, buf(seq0));
    // Leftovers from a longer previous layout (same content, so upsert did not
    // clear them) would otherwise linger and be rescored.
    deleteVecFrom.run(docId, total);
    return { complete: true };
  });

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
    writeVectors: (docId, vectors, expectedHash) => writeVectorsTx(docId, vectors, expectedHash),
    writeVectorsResumable: (docId, vectors, total, expectedHash) =>
      writeVectorsResumableTx(docId, vectors, total, expectedHash),
    clearZeroMarker: (docId, expectedHash) => {
      if (vecTarget(docId, expectedHash) === 'ok' && clearZero.run(docId).changes > 0) changed(docId);
    },
    storedVecSeqs: (docId) => {
      const out = new Set<number>();
      for (const row of selectVecSeqs.all(docId) as Array<{ seq: number }>) out.add(row.seq);
      return out;
    },
    notePassages: (docId, kind, hash, passages) => reuser?.remember(docId, kind, hash, passages),
    listDocsMissingVectors: createMissingVecWalk(db),
  };
}

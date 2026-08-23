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
 */

import { createHash } from 'node:crypto';
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
   *  changed doc's vectors, so this scan also self-heals staleness.
   *
   *  Pass the previous batch's `cursor` back in to resume the walk where it
   *  stopped: the ids-only keyset query rides the doc_updated_id index, so a
   *  full drain costs one index walk TOTAL instead of a full table scan (with
   *  every note body dragged through a sort) per batch — the batches run on
   *  the host thread of a live web server. Note bodies are fetched by id for
   *  just the returned batch. */
  listDocsMissingVectors(limit: number, cursor?: MissingVecCursor | null): {
    docs: Array<{
      id: number; kind: string; ref: string; title: string; summary: string; note: string;
    }>;
    cursor: MissingVecCursor | null;
  };
}

/** Keyset position in the missing-vectors walk (updated_at DESC, id DESC). */
export interface MissingVecCursor {
  updatedAt: number;
  id: number;
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

  const missingVecIdsStmt = db.prepare(
    `SELECT d.id, d.updated_at FROM doc d
     WHERE NOT EXISTS (SELECT 1 FROM doc_vec v WHERE v.doc_id = d.id)
     ORDER BY d.updated_at DESC, d.id DESC
     LIMIT ?`,
  );
  const missingVecIdsAfterStmt = db.prepare(
    `SELECT d.id, d.updated_at FROM doc d
     WHERE (d.updated_at < ? OR (d.updated_at = ? AND d.id < ?))
       AND NOT EXISTS (SELECT 1 FROM doc_vec v WHERE v.doc_id = d.id)
     ORDER BY d.updated_at DESC, d.id DESC
     LIMIT ?`,
  );

  function listDocsMissingVectors(
    limit: number,
    cursor?: MissingVecCursor | null,
  ): ReturnType<Writer['listDocsMissingVectors']> {
    const idRows = (cursor
      ? missingVecIdsAfterStmt.all(cursor.updatedAt, cursor.updatedAt, cursor.id, limit)
      : missingVecIdsStmt.all(limit)) as Array<{ id: number; updated_at: number }>;
    if (idRows.length === 0) return { docs: [], cursor: cursor ?? null };
    const last = idRows[idRows.length - 1];
    const docs = db.prepare(
      `SELECT id, kind, ref, title, summary, note FROM doc
       WHERE id IN (${idRows.map(() => '?').join(',')})`,
    ).all(...idRows.map((r) => r.id)) as Array<{
      id: number; kind: string; ref: string; title: string; summary: string; note: string;
    }>;
    return { docs, cursor: { updatedAt: last.updated_at, id: last.id } };
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

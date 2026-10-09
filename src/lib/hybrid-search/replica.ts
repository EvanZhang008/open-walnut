/**
 * Index-to-index copy: a second host keeps a copy of a source index (doc rows
 * and their vectors) without embedding anything itself. The source pays for
 * passage inference once; the copy only ever embeds queries.
 *
 * Source side: `replicaStates` names every doc with its content hash and the
 * state of its vectors (cheap: no body, no vector blob beyond seq 0), and
 * `exportReplicaDocs` reads the docs a copy asked for, vectors included.
 *
 * Copy side: `importReplicaDocs` writes each doc as the source has it (its
 * hash, its identifier tokens, its vectors) under the same write protocol as
 * writer.ts, re-tokenizing FTS locally, and stamps it with the caller's tag
 * (replica_tag). Any local write to the doc (upsert) drops the stamp, so a
 * caller comparing stamps against the source's manifest asks for it again.
 *
 * One rule decides vectors. A doc whose text did not change (same hash) keeps
 * the vectors it has when the source sends it with fewer: a source that lost
 * its vectors (a rebuild, a policy bump) re-embeds for hours, and the copy
 * should not go blind meanwhile. A complete set (seq 0 present) always wins.
 */

import type { Statement } from 'better-sqlite3';
import type { SearchDb } from './db.js';
import { buildFtsColumns } from './writer.js';
import type { DocChangeListener } from './writer.js';

/** Vectors of a doc: 'v' complete, 'z' complete but only the zero marker
 *  (quarantined, or a doc with no text), 'n' none yet or partial. */
export type ReplicaVecState = 'n' | 'z' | 'v';

export interface ReplicaStateRow {
  id: number;
  kind: string;
  ref: string;
  hash: string;
  vec: ReplicaVecState;
}

export interface ReplicaDoc {
  kind: string;
  ref: string;
  title: string;
  summary: string;
  note: string;
  meta: string;
  updatedAt: number;
  hash: string;
  /** Exact-identifier tokens as the source stores them (already lowercased). */
  idents: string[];
  /** The source's vectors, by seq; empty when it has none yet. */
  vectors: Array<{ seq: number; vec: Buffer }>;
}

export interface ReplicaTagRow {
  id: number;
  kind: string;
  ref: string;
  tag: string;
}

const vecStateSql = `(SELECT CASE WHEN v.vec = zeroblob(length(v.vec)) THEN 'z' ELSE 'v' END
  FROM doc_vec v WHERE v.doc_id = d.id AND v.seq = 0)`;

/**
 * One slice of the source's doc states in id order, after `afterId`. Each row
 * reads the doc's hash (the last column: a long body's overflow pages) and one
 * seq-0 probe, so a caller on a live event loop walks the table in small
 * slices; a cold slice of 64 costs tens of milliseconds.
 */
export function replicaStates(db: SearchDb, afterId: number, limit: number): ReplicaStateRow[] {
  const rows = db.prepare(
    `SELECT d.id, d.kind, d.ref, d.hash, ${vecStateSql} AS vec FROM doc d
     WHERE d.id > ? ORDER BY d.id LIMIT ?`,
  ).all(afterId, limit) as Array<Omit<ReplicaStateRow, 'vec'> & { vec: 'z' | 'v' | null }>;
  return rows.map((r) => ({ ...r, vec: r.vec ?? 'n' }));
}

/** The states of these docs; an id with no row is gone (removed). */
export function replicaStatesOf(db: SearchDb, ids: number[]): ReplicaStateRow[] {
  if (ids.length === 0) return [];
  const rows = db.prepare(
    `SELECT d.id, d.kind, d.ref, d.hash, ${vecStateSql} AS vec FROM doc d
     WHERE d.id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as Array<Omit<ReplicaStateRow, 'vec'> & { vec: 'z' | 'v' | null }>;
  return rows.map((r) => ({ ...r, vec: r.vec ?? 'n' }));
}

type Stmt = Statement<unknown[]>;
/** Export statements, prepared once per connection: a first copy asks for every doc. */
const exportStmts = new WeakMap<SearchDb, { doc: Stmt; idents: Stmt; vecs: Stmt }>();

/** The docs a copy asked for, as stored (absent keys are skipped). */
export function exportReplicaDocs(db: SearchDb, keys: Array<{ kind: string; ref: string }>): ReplicaDoc[] {
  let stmts = exportStmts.get(db);
  if (!stmts) {
    stmts = {
      doc: db.prepare(`SELECT id, kind, ref, title, summary, note, meta, updated_at, hash FROM doc WHERE kind = ? AND ref = ?`),
      idents: db.prepare(`SELECT token FROM ident WHERE doc_id = ? ORDER BY token`),
      vecs: db.prepare(`SELECT seq, vec FROM doc_vec WHERE doc_id = ? ORDER BY seq`),
    };
    exportStmts.set(db, stmts);
  }
  const { doc: selectDoc, idents: selectIdents, vecs: selectVecs } = stmts;
  const out: ReplicaDoc[] = [];
  for (const key of keys) {
    const row = selectDoc.get(key.kind, key.ref) as
      | { id: number; kind: string; ref: string; title: string; summary: string; note: string; meta: string; updated_at: number; hash: string }
      | undefined;
    if (!row) continue;
    out.push({
      kind: row.kind,
      ref: row.ref,
      title: row.title,
      summary: row.summary,
      note: row.note,
      meta: row.meta,
      updatedAt: row.updated_at,
      hash: row.hash,
      idents: (selectIdents.all(row.id) as Array<{ token: string }>).map((r) => r.token),
      vectors: (selectVecs.all(row.id) as Array<{ seq: number; vec: Buffer }>).map((r) => ({ seq: r.seq, vec: r.vec })),
    });
  }
  return out;
}

/** One slice of the copy's stamps in id order (docs with no stamp are left out). */
export function replicaTags(db: SearchDb, afterId: number, limit: number): ReplicaTagRow[] {
  return db.prepare(
    `SELECT d.id, d.kind, d.ref, t.tag FROM replica_tag t JOIN doc d ON d.id = t.doc_id
     WHERE t.doc_id > ? ORDER BY t.doc_id LIMIT ?`,
  ).all(afterId, limit) as ReplicaTagRow[];
}

/** The stamps of these docs (a doc with no stamp, or no row, is left out). */
export function replicaTagsOf(db: SearchDb, ids: number[]): ReplicaTagRow[] {
  if (ids.length === 0) return [];
  return db.prepare(
    `SELECT d.id, d.kind, d.ref, t.tag FROM replica_tag t JOIN doc d ON d.id = t.doc_id
     WHERE t.doc_id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as ReplicaTagRow[];
}

export interface ReplicaImportResult {
  stored: number;
  /** Docs whose text was unchanged and whose own (more complete) vectors were kept. */
  keptVectors: number;
}

export interface ReplicaWriter {
  importDocs(docs: Array<ReplicaDoc & { tag: string }>): ReplicaImportResult;
}

export function createReplicaWriter(db: SearchDb, onChange: DocChangeListener = () => {}): ReplicaWriter {
  const selectExisting = db.prepare(`SELECT id, hash, updated_at FROM doc WHERE kind = ? AND ref = ?`);
  const touch = db.prepare(`UPDATE doc SET updated_at = ? WHERE id = ?`);
  const updateDoc = db.prepare(
    `UPDATE doc SET title = ?, summary = ?, note = ?, meta = ?, updated_at = ?, hash = ? WHERE id = ?`,
  );
  const insertDoc = db.prepare(
    `INSERT INTO doc (kind, ref, title, summary, note, meta, updated_at, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteFts = db.prepare(`DELETE FROM doc_fts WHERE rowid = ?`);
  const insertFts = db.prepare(
    `INSERT INTO doc_fts (rowid, title, summary, note, meta, tsub, ssub, nsub, msub) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deleteIdent = db.prepare(`DELETE FROM ident WHERE doc_id = ?`);
  const insertIdent = db.prepare(`INSERT OR IGNORE INTO ident (token, doc_id, field) VALUES (?, ?, 'ident')`);
  const hasSeq0 = db.prepare(`SELECT 1 FROM doc_vec WHERE doc_id = ? AND seq = 0`);
  const deleteVec = db.prepare(`DELETE FROM doc_vec WHERE doc_id = ?`);
  const insertVec = db.prepare(`INSERT OR REPLACE INTO doc_vec (doc_id, seq, vec) VALUES (?, ?, ?)`);
  const setTag = db.prepare(
    `INSERT INTO replica_tag (doc_id, tag) VALUES (?, ?) ON CONFLICT(doc_id) DO UPDATE SET tag = excluded.tag`,
  );

  const importTx = db.transaction((docs: Array<ReplicaDoc & { tag: string }>): ReplicaImportResult => {
    let stored = 0;
    let keptVectors = 0;
    for (const doc of docs) {
      const existing = selectExisting.get(doc.kind, doc.ref) as { id: number; hash: string; updated_at: number } | undefined;
      let docId: number;
      let replaceVectors = true;
      if (existing && existing.hash === doc.hash) {
        // Same text: the FTS and identifier rows already describe it.
        docId = existing.id;
        if (existing.updated_at !== doc.updatedAt) touch.run(doc.updatedAt, docId);
        const incomingComplete = doc.vectors.some((v) => v.seq === 0);
        if (!incomingComplete && hasSeq0.get(docId)) {
          replaceVectors = false;
          keptVectors++;
        }
      } else {
        // writer.ts's protocol: FTS row out, doc row in place (rowid kept), FTS
        // row back from the new text, identifier rows rewritten.
        if (existing) {
          deleteFts.run(existing.id);
          updateDoc.run(doc.title, doc.summary, doc.note, doc.meta, doc.updatedAt, doc.hash, existing.id);
          docId = existing.id;
        } else {
          const info = insertDoc.run(doc.kind, doc.ref, doc.title, doc.summary, doc.note, doc.meta, doc.updatedAt, doc.hash);
          docId = Number(info.lastInsertRowid);
        }
        insertFts.run(docId, ...buildFtsColumns(doc));
        deleteIdent.run(docId);
        for (const token of doc.idents) if (token) insertIdent.run(token, docId);
      }
      if (replaceVectors) {
        deleteVec.run(docId);
        for (const v of doc.vectors) insertVec.run(docId, v.seq, v.vec);
      }
      setTag.run(docId, doc.tag);
      onChange(docId);
      stored++;
    }
    return { stored, keptVectors };
  });

  return { importDocs: (docs) => importTx(docs) };
}

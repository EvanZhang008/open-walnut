/**
 * hybrid-search storage — one SQLite file, four tables + FTS5 index.
 *
 * Layout (see README.md for the full design):
 *   doc      raw text + metadata; the ONLY source for snippets, rescoring and
 *            rebuilds (FTS is contentless and cannot return text)
 *   doc_fts  contentless FTS5 (`content=''` + `contentless_delete=1`) whose
 *            columns hold OUR pre-tokenized streams, not raw text
 *   doc_vec  int8 embedding blobs, (doc_id, seq) — seq 0 is the digest the
 *            recall lane scans, seq>0 the passages that cover the body;
 *            seq 0 is written LAST so its presence means "fully vectored"
 *   ident    exact-identifier lane (ids, ticket numbers, SHAs, URLs)
 *   meta     version stamps; mismatch forces a rebuild
 *   replica_tag  on an index fed from another index (replica.ts): the source's
 *            stamp for each doc as it arrived; empty on a source index
 *   spelling_fix  each word's stored-typo verdict for its hour (query.ts
 *            spellingCorrections), so a restart does not look every word up again
 *
 * The FTS tokenizer is unicode61 with `tokenchars '-_.'` so the orig stream's
 * joined tokens (`acme-gateway-dev`, `v1.2.3`) survive as single FTS tokens.
 * Apostrophes are NOT tokenchars (two quoting layers make escaping fragile);
 * both sides tokenize symmetrically, so `don't` splits identically in docs
 * and queries and still phrase-matches.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database, { type Database as DatabaseType } from '../sqlite.js';
import { ensureLateIndexes, hasIndex, type LateIndex, type LateIndexReport } from '../sqlite-late-index.js';
import { PASSAGE_POLICY_VERSION } from './chunk.js';

export type SearchDb = DatabaseType;

export const SCHEMA_VERSION = 1;

/** FTS layout version, independent of the doc table: bumping it re-tokenizes
 *  doc_fts from the stored doc rows (seconds) instead of re-reading every
 *  source (minutes). v2 = per-field sub columns — one flat `sub` column gave
 *  every subword hit the same 0.6 weight, so a title subword match could
 *  never outrank body mentions. */
export const FTS_VERSION = 2;

const FTS_TOKENIZE = `unicode61 remove_diacritics 2 tokenchars '-_.'`;

/** Shared with writer.ts's rebuildAll (drop + recreate beats a bulk DELETE).
 *  tsub/ssub/nsub/msub hold the sub-token stream of the matching orig field;
 *  per-field columns also make cross-field phrase chaining impossible. */
export const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS doc_fts USING fts5(
  title, summary, note, meta, tsub, ssub, nsub, msub,
  content='', contentless_delete=1,
  tokenize="${FTS_TOKENIZE}"
);`;

/** The covering index of a doc's short columns by id (DOC_LATE_INDEXES): a read by id names it
 *  in `INDEXED BY` (docHeadHint), since the planner takes the table's rowid for `id IN (...)`
 *  and reads every body. */
export const DOC_HEAD = 'doc_head';

/**
 * Covering indexes (added 2026-11-25): updated_at and hash sit after note in the row, so reading
 * them from the table walks every body's overflow pages (a few MB per hundred docs; 40 to 300 ms
 * a read on a cold 1.2 GB index). doc_head serves the reads by id (replica.ts states, docCards),
 * doc_kind_ref_updated the file sweep's (ref, updated_at) of one kind. Built after the open
 * (sqlite-late-index.ts): on the Mac's index each build reads 305 MB, 22 s on a cold disk.
 */
const DOC_LATE_INDEXES: LateIndex[] = [
  { name: DOC_HEAD, table: 'doc', sql: `CREATE INDEX IF NOT EXISTS ${DOC_HEAD} ON doc(id, kind, ref, hash, updated_at, title, (summary <> ''))`, warm: 'SELECT max(length(hash)) FROM doc' },
  { name: 'doc_kind_ref_updated', table: 'doc', sql: 'CREATE INDEX IF NOT EXISTS doc_kind_ref_updated ON doc(kind, ref, updated_at)', warm: 'SELECT max(updated_at) FROM doc' },
];

/** ` INDEXED BY doc_head` once the index is there, else nothing (the read works either way). */
export function docHeadHint(db: SearchDb): string {
  return hasIndex(db, DOC_HEAD) ? ` INDEXED BY ${DOC_HEAD}` : '';
}

const DDL = `
CREATE TABLE IF NOT EXISTS doc (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL,
  ref        TEXT NOT NULL,
  title      TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  note       TEXT NOT NULL DEFAULT '',
  meta       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  hash       TEXT NOT NULL,
  UNIQUE(kind, ref)
);
CREATE INDEX IF NOT EXISTS doc_kind_updated ON doc(kind, updated_at);
-- Backfill walk order: lets the missing-vectors keyset cursor resume mid-walk
-- instead of re-sorting the whole table (with note bodies) on every batch.
CREATE INDEX IF NOT EXISTS doc_updated_id ON doc(updated_at DESC, id DESC);
${FTS_DDL}

CREATE TABLE IF NOT EXISTS doc_vec (
  doc_id INTEGER NOT NULL REFERENCES doc(id) ON DELETE CASCADE,
  seq    INTEGER NOT NULL,
  vec    BLOB NOT NULL,
  PRIMARY KEY (doc_id, seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS ident (
  token  TEXT NOT NULL,
  doc_id INTEGER NOT NULL REFERENCES doc(id) ON DELETE CASCADE,
  field  TEXT NOT NULL,
  PRIMARY KEY (token, doc_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ident_doc ON ident(doc_id);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Each word's typo verdict (query.ts spellingCorrections), kept for its hour across restarts
-- (added 2026-11-25): a server that restarts every few minutes looked every word up again,
-- about 600 vocabulary lookups a rare word, 55 s of the loop in 3.5 hours of stalls.
CREATE TABLE IF NOT EXISTS spelling_fix (
  word TEXT PRIMARY KEY,
  fix  TEXT,
  rare INTEGER NOT NULL,
  at   INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS replica_tag (
  doc_id INTEGER PRIMARY KEY REFERENCES doc(id) ON DELETE CASCADE,
  tag    TEXT NOT NULL
);
`;

export interface OpenOptions {
  /** Absolute path, or ':memory:' for tests. */
  dbPath: string;
  /** Caller passes tokenizer.TOKENIZER_VERSION — stored and gated. */
  tokenizerVersion: number;
  /** Embedding model id, once an embedder is configured. Changing it clears
   *  doc_vec (re-embed) but keeps the keyword index. */
  embedModel?: string;
  /** Told when the indexes built after the open are done (or why not). */
  lateIndexReport?: LateIndexReport;
  /** Test seam only: override the passage-policy version being gated on.
   *  Production always uses chunk.ts's PASSAGE_POLICY_VERSION. */
  passagePolicyVersion?: number;
}

export interface OpenResult {
  db: SearchDb;
  /** True when a version gate wiped the index — the caller must re-feed all
   *  docs (search still works, it just returns nothing until then). */
  needsRebuild: boolean;
  /** True when only the FTS layer was dropped (tokenizer/FTS version bump):
   *  doc rows survived, so re-tokenizing them locally rebuilds the index —
   *  createSearchIndex does this automatically. */
  needsReindex: boolean;
  /** True when doc_vec was emptied (embed-model swap or passage-policy bump)
   *  but doc rows survived. The caller should kick a full backfill pass at once
   *  rather than waiting for the periodic self-heal to notice. */
  vectorsWiped: boolean;
}

export function getMeta(db: SearchDb, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMeta(db: SearchDb, key: string, value: string): void {
  db.prepare(`INSERT INTO meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export function deleteMeta(db: SearchDb, key: string): void {
  db.prepare(`DELETE FROM meta WHERE key = ?`).run(key);
}

/** Drop every content table (NOT meta) so a version bump re-feeds cleanly.
 *  contentless FTS5 has no 'rebuild' command — drop + recreate is the way. */
function wipeIndex(db: SearchDb): void {
  db.exec(`
    DROP TABLE IF EXISTS doc_fts;
    DELETE FROM ident;
    DELETE FROM doc_vec;
    DELETE FROM replica_tag;
    DELETE FROM spelling_fix;
    DELETE FROM doc;
  `);
  db.exec(DDL); // recreate doc_fts
}

/** Vectors went away (model swap, passage-policy bump): a replica's stamps
 *  said "this doc arrived with its vectors", so every doc must come again. */
function dropVectors(db: SearchDb): void {
  db.exec(`DELETE FROM doc_vec; DELETE FROM replica_tag;`);
}

export function openSearchDb(options: OpenOptions): OpenResult {
  // SQLite won't create parent directories, and its CANTOPEN error names no
  // path — ensure the directory instead of surfacing that riddle.
  if (options.dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
  }
  const db = new Database(options.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  // Without a busy timeout any second connection (a diagnostic script, a test
  // server on the same home) makes writes fail INSTANTLY with SQLITE_BUSY —
  // observed as vector-backfill writes dying with "database is locked".
  db.pragma('busy_timeout = 5000');
  // What a delete frees inside a page is zeroed at no extra I/O: a removed doc's text does not
  // linger in the file (a caller that must also clear free pages does that itself).
  db.pragma('secure_delete = FAST');
  db.exec(DDL);
  ensureLateIndexes(db, DOC_LATE_INDEXES, { report: options.lateIndexReport });

  let needsRebuild = false;
  let needsReindex = false;
  const storedSchema = getMeta(db, 'schema_version');
  const storedTokenizer = getMeta(db, 'tokenizer_version');
  const storedFts = getMeta(db, 'fts_version');
  const wantSchema = String(SCHEMA_VERSION);
  const wantTokenizer = String(options.tokenizerVersion);
  const wantFts = String(FTS_VERSION);
  const hasDocs = storedSchema !== undefined;

  if (hasDocs && storedSchema !== wantSchema) {
    // The doc table itself changed — stored rows can't be trusted as source.
    wipeIndex(db);
    needsRebuild = true;
  } else if (hasDocs && (storedTokenizer !== wantTokenizer || storedFts !== wantFts)) {
    // Tokenization/FTS layout changed but doc rows are intact: drop only the
    // FTS layer and let the caller re-tokenize from doc (seconds, not a full
    // source re-read).
    db.exec(`DROP TABLE IF EXISTS doc_fts;`);
    db.exec(FTS_DDL);
    needsReindex = true;
  }
  setMeta(db, 'schema_version', wantSchema);
  setMeta(db, 'tokenizer_version', wantTokenizer);
  setMeta(db, 'fts_version', wantFts);

  let vectorsWiped = false;
  if (options.embedModel !== undefined) {
    const storedModel = getMeta(db, 'embed_model');
    if (storedModel !== undefined && storedModel !== options.embedModel) {
      dropVectors(db); // keyword index survives a model swap
      vectorsWiped = true;
    }
    setMeta(db, 'embed_model', options.embedModel);
  }

  // Passage policy governs the LAYOUT of a doc's vectors. After a policy change
  // every stored vector describes text this policy would no longer produce, so
  // it must re-embed. Only doc_vec is dropped: `doc` rows are the SOURCE the
  // backfill re-embeds from, and the keyword index does not depend on passage
  // layout. Same shape as the embed-model gate above, and for the same reason a
  // wipeIndex() here would be wrong — task and session docs are fed by events
  // only, so an emptied `doc` table would remove untouched tasks from search
  // entirely until something happened to edit them.
  const storedPolicy = getMeta(db, 'passage_policy_version')
    // An index built before this gate existed holds v1 passages. Reading an
    // absent key as "fresh" on an EXISTING index would stamp the current version
    // over v1 vectors and make the whole migration a silent no-op: the backfill
    // only looks for docs with ZERO vectors, so a doc holding one stale vector
    // would never be revisited.
    ?? (hasDocs ? '1' : undefined);
  const wantPolicy = String(options.passagePolicyVersion ?? PASSAGE_POLICY_VERSION);
  if (storedPolicy !== undefined && storedPolicy !== wantPolicy) {
    dropVectors(db);
    vectorsWiped = true;
  }
  setMeta(db, 'passage_policy_version', wantPolicy);

  return { db, needsRebuild, needsReindex, vectorsWiped };
}

export interface IndexStats {
  docs: number;
  byKind: Record<string, number>;
  vectors: number;
  fileBytes: number;
  schemaVersion: number;
  tokenizerVersion: number;
  embedModel?: string;
}

export function countDocs(db: SearchDb): { docs: number; byKind: Record<string, number> } {
  const byKind: Record<string, number> = {};
  let docs = 0;
  for (const row of db.prepare(`SELECT kind, COUNT(*) AS n FROM doc GROUP BY kind`).all() as
    Array<{ kind: string; n: number }>) {
    byKind[row.kind] = row.n;
    docs += row.n;
  }
  return { docs, byKind };
}

export interface DocCard {
  id: number;
  kind: string;
  ref: string;
  title: string;
  updated_at: number;
  /** 1 when the doc has a summary. */
  has_summary: number;
}

/** The short columns of these docs (a result list's cards), from the doc_head index once it is
 *  built: no body is read. An id with no row is left out. */
export function docCards(db: SearchDb, ids: readonly number[]): DocCard[] {
  if (ids.length === 0) return [];
  return db.prepare(
    `SELECT id, kind, ref, title, updated_at, summary <> '' AS has_summary FROM doc${docHeadHint(db)}
     WHERE id IN (${ids.map(() => '?').join(',')})`,
  ).all(...ids) as DocCard[];
}

/** ref -> updated_at of every doc of one kind (a file sweep's comparison set), from the
 *  doc_kind_ref_updated index once it is built: no body is read. */
export function docStampsOfKind(db: SearchDb, kind: string): Map<string, number> {
  const rows = db.prepare(`SELECT ref, updated_at FROM doc WHERE kind = ?`).all(kind) as Array<{ ref: string; updated_at: number }>;
  return new Map(rows.map((r) => [r.ref, r.updated_at]));
}

/** One row read, where COUNT(*) walks the table. Plain prepare().get() with a
 *  falsy check: the same on every SQLite driver (a missing row is undefined in
 *  one and null in another). */
export function hasAnyDoc(db: SearchDb): boolean {
  return Boolean(db.prepare(`SELECT 1 AS one FROM doc LIMIT 1`).get());
}

export function collectStats(db: SearchDb): IndexStats {
  const { docs, byKind } = countDocs(db);
  const vectors = (db.prepare(`SELECT COUNT(*) AS n FROM doc_vec`).get() as { n: number }).n;
  const pageCount = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  return {
    docs,
    byKind,
    vectors,
    fileBytes: pageCount * pageSize,
    schemaVersion: Number(getMeta(db, 'schema_version') ?? 0),
    tokenizerVersion: Number(getMeta(db, 'tokenizer_version') ?? 0),
    embedModel: getMeta(db, 'embed_model'),
  };
}

/** Merge FTS b-tree segments; ~150ms after a bulk build for a ~5x query win. */
export function optimizeIndex(db: SearchDb): void {
  db.prepare(`INSERT INTO doc_fts(doc_fts) VALUES ('optimize')`).run();
}

/**
 * hybrid-search storage — one SQLite file, four tables + FTS5 index.
 *
 * Layout (see README.md for the full design):
 *   doc      raw text + metadata; the ONLY source for snippets, rescoring and
 *            rebuilds (FTS is contentless and cannot return text)
 *   doc_fts  contentless FTS5 (`content=''` + `contentless_delete=1`) whose
 *            columns hold OUR pre-tokenized streams, not raw text
 *   doc_vec  int8 embedding blobs, (doc_id, seq) — seq>0 only for chunked kinds
 *   ident    exact-identifier lane (ids, ticket numbers, SHAs, URLs)
 *   meta     version stamps; mismatch forces a rebuild
 *
 * The FTS tokenizer is unicode61 with `tokenchars '-_.'` so the orig stream's
 * joined tokens (`acme-gateway-dev`, `v1.2.3`) survive as single FTS tokens.
 * Apostrophes are NOT tokenchars (two quoting layers make escaping fragile);
 * both sides tokenize symmetrically, so `don't` splits identically in docs
 * and queries and still phrase-matches.
 */

import Database from 'better-sqlite3';

export type SearchDb = Database.Database;

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
`;

export interface OpenOptions {
  /** Absolute path, or ':memory:' for tests. */
  dbPath: string;
  /** Caller passes tokenizer.TOKENIZER_VERSION — stored and gated. */
  tokenizerVersion: number;
  /** Embedding model id, once an embedder is configured. Changing it clears
   *  doc_vec (re-embed) but keeps the keyword index. */
  embedModel?: string;
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
}

function getMeta(db: SearchDb, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMeta(db: SearchDb, key: string, value: string): void {
  db.prepare(`INSERT INTO meta(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** Drop every content table (NOT meta) so a version bump re-feeds cleanly.
 *  contentless FTS5 has no 'rebuild' command — drop + recreate is the way. */
function wipeIndex(db: SearchDb): void {
  db.exec(`
    DROP TABLE IF EXISTS doc_fts;
    DELETE FROM ident;
    DELETE FROM doc_vec;
    DELETE FROM doc;
  `);
  db.exec(DDL); // recreate doc_fts
}

export function openSearchDb(options: OpenOptions): OpenResult {
  const db = new Database(options.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(DDL);

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

  if (options.embedModel !== undefined) {
    const storedModel = getMeta(db, 'embed_model');
    if (storedModel !== undefined && storedModel !== options.embedModel) {
      db.exec(`DELETE FROM doc_vec;`); // keyword index survives a model swap
    }
    setMeta(db, 'embed_model', options.embedModel);
  }

  return { db, needsRebuild, needsReindex };
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

export function collectStats(db: SearchDb): IndexStats {
  const byKind: Record<string, number> = {};
  let docs = 0;
  for (const row of db.prepare(`SELECT kind, COUNT(*) AS n FROM doc GROUP BY kind`).all() as
    Array<{ kind: string; n: number }>) {
    byKind[row.kind] = row.n;
    docs += row.n;
  }
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

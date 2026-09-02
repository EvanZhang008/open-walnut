/**
 * notes-index.sqlite — the STRUCTURAL sidecar for the notes vault.
 *
 * Holds stable identity (id↔path), link/backlink edges, tag edges, and an FTS5
 * index for exact/substring search — replacing the three O(n) full-vault file
 * scans (search / backlinks / list) and the basename-collision bug class.
 *
 * Files on disk stay the source of truth; this DB is fully rebuildable
 * (see notes-indexer.ts rebuild path). Construction mirrors task-db.ts /
 * memory-index.ts: better-sqlite3, WAL, schema-version migration.
 *
 * This file is the STORAGE PRIMITIVE only — no fs reads, no frontmatter parsing,
 * no search index. The reconciler (notes-indexer.ts) drives writes; routes
 * drive reads.
 */
import Database, { type Database as DatabaseType } from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'

export const NOTES_INDEX_PATH = path.join(WALNUT_HOME, 'notes-index.sqlite')

/** Bump to force a full rebuild on next open (schema/semantics change).
 * The attachment_text tables need no bump — SCHEMA_SQL's IF NOT EXISTS adds
 * them on open, and a rebuild clears notes/links/tags only (attachment_text
 * SURVIVES: OCR is expensive and its rows are keyed by content hash). */
export const NOTES_INDEX_SCHEMA_VERSION = 3 // v3: headings lines carry ancestor paths ("Eye > prescription")

export type LinkStatus = 'resolved' | 'unresolved' | 'ambiguous'

export interface NoteRow {
  id: string
  path: string
  title: string
  content_hash: string
  body: string
  frontmatter: string | null
  created: string | null
  modified: string
  size: number
  /** Newline-joined section headings (## and deeper) for the heading search leg. */
  headings: string
}

/** A link edge as extracted + resolved by the reconciler. */
export interface LinkEdge {
  dstId: string | null
  dstName: string
  status: LinkStatus
  context: string
  /** Candidate target ids when status==='ambiguous' (JSON-serialized into the row). */
  candidates?: string[]
}

export interface TagEdge {
  tag: string
}

let db: DatabaseType | null = null
let initAttempted = false

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS notes (
  id           TEXT PRIMARY KEY,
  path         TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  body         TEXT NOT NULL,
  frontmatter  TEXT,
  created      TEXT,
  modified     TEXT NOT NULL,
  size         INTEGER NOT NULL,
  headings     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_notes_path  ON notes(path);
CREATE INDEX IF NOT EXISTS idx_notes_title ON notes(title COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS links (
  src_id     TEXT NOT NULL,
  dst_id     TEXT,
  dst_name   TEXT NOT NULL,
  status     TEXT NOT NULL,
  context    TEXT NOT NULL DEFAULT '',
  candidates TEXT,
  PRIMARY KEY (src_id, dst_name, context)
);
CREATE INDEX IF NOT EXISTS idx_links_dst ON links(dst_id);
CREATE INDEX IF NOT EXISTS idx_links_src ON links(src_id);

CREATE TABLE IF NOT EXISTS tags (
  note_id TEXT NOT NULL,
  tag     TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

-- External-content FTS5: stores only the index, not a second copy of the body.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, body,
  content = 'notes', content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- The 3 standard external-content triggers keep notes_fts coherent automatically.
-- An external-content FTS5 table is NOT auto-maintained: on UPDATE/DELETE we must
-- issue the FTS5 'delete' command WITH THE OLD column values, THEN insert new ones.
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, body) VALUES('delete', old.rowid, old.title, old.body);
  INSERT INTO notes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT);

-- Extracted text of binary attachments (PDF text layer / Vision OCR). Keyed by
-- vault-relative path; content_hash lets us skip unchanged files and never
-- re-run a failed/succeeded extraction for the same bytes.
CREATE TABLE IF NOT EXISTS attachment_text (
  path         TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  text         TEXT NOT NULL DEFAULT '',
  method       TEXT NOT NULL,
  status       TEXT NOT NULL,
  mtime        TEXT NOT NULL,
  size         INTEGER NOT NULL,
  extracted_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS attachment_fts USING fts5(
  text,
  content = 'attachment_text', content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS attach_ai AFTER INSERT ON attachment_text BEGIN
  INSERT INTO attachment_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER IF NOT EXISTS attach_ad AFTER DELETE ON attachment_text BEGIN
  INSERT INTO attachment_fts(attachment_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER IF NOT EXISTS attach_au AFTER UPDATE ON attachment_text BEGIN
  INSERT INTO attachment_fts(attachment_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO attachment_fts(rowid, text) VALUES (new.rowid, new.text);
END;
`

/**
 * Open (or create) the structural sidecar. Lazily initialized on first call.
 * On a schema-version mismatch the caller (initNotesIndex) triggers a rebuild;
 * here we simply (re)create tables and record the version.
 */
export function getNotesIndexDb(): DatabaseType | null {
  if (db) return db
  if (initAttempted) return db
  initAttempted = true
  try {
    fs.mkdirSync(path.dirname(NOTES_INDEX_PATH), { recursive: true })
    const handle = new Database(NOTES_INDEX_PATH)
    handle.pragma('journal_mode = WAL')
    handle.pragma('busy_timeout = 5000')
    handle.pragma('synchronous = NORMAL')
    handle.exec(SCHEMA_SQL)
    // v1→v2: section-heading search leg needs a headings column on pre-existing
    // DBs (CREATE TABLE IF NOT EXISTS won't add it). Content is backfilled by the
    // schema-version rebuild that initNotesIndex triggers.
    const hasHeadings = (handle.prepare(`PRAGMA table_info(notes)`).all() as Array<{ name: string }>)
      .some((c) => c.name === 'headings')
    if (!hasHeadings) handle.exec(`ALTER TABLE notes ADD COLUMN headings TEXT NOT NULL DEFAULT ''`)
    setMeta(handle, 'schema_version', String(NOTES_INDEX_SCHEMA_VERSION))
    db = handle
    return db
  } catch (err) {
    log.memory.error('notes-index: failed to open DB', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

export function closeNotesIndexDb(): void {
  if (db) {
    try { db.close() } catch { /* ignore */ }
    db = null
  }
  initAttempted = false
}

/** Read the persisted schema_version of the on-disk DB (without forcing tables). */
export function readSchemaVersion(): number | null {
  try {
    if (!fs.existsSync(NOTES_INDEX_PATH)) return null
    const handle = new Database(NOTES_INDEX_PATH, { readonly: true })
    try {
      const row = handle
        .prepare(`SELECT value FROM index_meta WHERE key='schema_version'`)
        .get() as { value: string } | undefined
      return row ? Number(row.value) : null
    } finally {
      handle.close()
    }
  } catch {
    return null
  }
}

function setMeta(handle: DatabaseType, key: string, value: string): void {
  handle
    .prepare(`INSERT INTO index_meta(key, value) VALUES(?, ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
    .run(key, value)
}

export function setIndexMeta(key: string, value: string): void {
  const d = getNotesIndexDb()
  if (!d) return
  setMeta(d, key, value)
}

export function getIndexMeta(key: string): string | null {
  const d = getNotesIndexDb()
  if (!d) return null
  const row = d.prepare(`SELECT value FROM index_meta WHERE key=?`).get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

// ── Writes (used by the reconciler, inside one db.transaction) ──────────────

/**
 * Upsert a note row + replace its link/tag edges, all in a single transaction.
 * The FTS triggers keep notes_fts coherent automatically.
 */
export function upsertNote(note: NoteRow, links: LinkEdge[], tags: TagEdge[]): void {
  const d = getNotesIndexDb()
  if (!d) return
  const tx = d.transaction(() => {
    // The file at this path now carries `note.id` (files are source of truth).
    // Evict any STALE row that still occupies this path under a DIFFERENT id —
    // otherwise the path UNIQUE constraint throws and the note silently fails to
    // index (e.g. the §8.3 two-machine id divergence, an AI/manual id rewrite, or
    // a move whose new-path upsert lands before the old-path delete reconciles).
    // Inbound edges to the evicted id are marked unresolved (re-resolved below).
    const stale = d.prepare(`SELECT id FROM notes WHERE path=? AND id!=?`).get(note.path, note.id) as
      | { id: string }
      | undefined
    if (stale) {
      d.prepare(`DELETE FROM links WHERE src_id=?`).run(stale.id)
      d.prepare(`DELETE FROM tags WHERE note_id=?`).run(stale.id)
      d.prepare(`DELETE FROM notes WHERE id=?`).run(stale.id)
      d.prepare(`UPDATE links SET dst_id=NULL, status='unresolved' WHERE dst_id=?`).run(stale.id)
    }
    d.prepare(
      `INSERT INTO notes (id, path, title, content_hash, body, frontmatter, created, modified, size, headings)
       VALUES (@id, @path, @title, @content_hash, @body, @frontmatter, @created, @modified, @size, @headings)
       ON CONFLICT(id) DO UPDATE SET
         path=excluded.path, title=excluded.title, content_hash=excluded.content_hash,
         body=excluded.body, frontmatter=excluded.frontmatter, created=excluded.created,
         modified=excluded.modified, size=excluded.size, headings=excluded.headings`,
    ).run(note)

    // Replace outgoing edges for this source note.
    d.prepare(`DELETE FROM links WHERE src_id=?`).run(note.id)
    const insLink = d.prepare(
      `INSERT OR IGNORE INTO links (src_id, dst_id, dst_name, status, context, candidates)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    for (const l of links) {
      insLink.run(
        note.id,
        l.dstId,
        l.dstName,
        l.status,
        l.context,
        l.candidates && l.candidates.length ? JSON.stringify(l.candidates) : null,
      )
    }

    d.prepare(`DELETE FROM tags WHERE note_id=?`).run(note.id)
    const insTag = d.prepare(`INSERT OR IGNORE INTO tags (note_id, tag) VALUES (?, ?)`)
    for (const t of tags) insTag.run(note.id, t.tag)

    // Re-resolve previously-unresolved inbound edges that named this note.
    // Never resolve an edge to its own source note (a self-link is not a backlink).
    const baseName = note.path.replace(/\.md$/, '')
    d.prepare(
      `UPDATE links SET dst_id=?, status='resolved'
       WHERE dst_id IS NULL AND status='unresolved' AND src_id != ?
         AND (dst_name=? COLLATE NOCASE OR dst_name=? COLLATE NOCASE OR dst_name=? COLLATE NOCASE)`,
    ).run(note.id, note.id, note.title, note.path, baseName)
  })
  tx()
}

/**
 * Delete a note by path (deletion path). Keeps inbound edges honest by marking
 * them unresolved rather than dropping them.
 */
export function deleteNoteByPath(relPath: string): string | null {
  const d = getNotesIndexDb()
  if (!d) return null
  let removedId: string | null = null
  const tx = d.transaction(() => {
    const row = d.prepare(`SELECT id FROM notes WHERE path=?`).get(relPath) as
      | { id: string }
      | undefined
    if (!row) return
    removedId = row.id
    d.prepare(`DELETE FROM links WHERE src_id=?`).run(row.id)
    d.prepare(`DELETE FROM tags WHERE note_id=?`).run(row.id)
    d.prepare(`DELETE FROM notes WHERE id=?`).run(row.id)
    // Inbound edges → unresolved (target gone) so backlinks stay truthful.
    d.prepare(
      `UPDATE links SET dst_id=NULL, status='unresolved' WHERE dst_id=?`,
    ).run(row.id)
  })
  tx()
  return removedId
}

/**
 * Re-resolve EVERY link edge against the full notes table. Used after a cold
 * rebuild's first pass, when all targets finally exist: a name that matches
 * exactly one note resolves; >1 → ambiguous (with candidate ids); 0 → unresolved.
 * Path-form names (containing '/') resolve by path. Self-links are skipped.
 */
export function reresolveAllEdges(): void {
  const d = getNotesIndexDb()
  if (!d) return
  const rows = d
    .prepare(`SELECT DISTINCT src_id, dst_name FROM links`)
    .all() as Array<{ src_id: string; dst_name: string }>
  const byName = d.prepare(
    `SELECT id, path FROM notes
     WHERE title = ? COLLATE NOCASE OR path = ? COLLATE NOCASE
        OR path = ? COLLATE NOCASE OR path LIKE ? ESCAPE '\\' COLLATE NOCASE`,
  )
  const byPath = d.prepare(
    `SELECT id FROM notes WHERE path = ? COLLATE NOCASE OR path = ? COLLATE NOCASE`,
  )
  const upd = d.prepare(
    `UPDATE links SET dst_id=?, status=?, candidates=? WHERE src_id=? AND dst_name=?`,
  )
  const tx = d.transaction(() => {
    for (const r of rows) {
      const name = r.dst_name.trim()
      let dstId: string | null = null
      let status: LinkStatus = 'unresolved'
      let candidates: string | null = null
      if (name.includes('/')) {
        const withMd = name.endsWith('.md') ? name : name + '.md'
        const hit = byPath.get(name, withMd) as { id: string } | undefined
        if (hit && hit.id !== r.src_id) { dstId = hit.id; status = 'resolved' }
      } else {
        const base = name.replace(/\.md$/, '')
        const likeBase = '%/' + base.replace(/[\\%_]/g, (m) => '\\' + m) + '.md'
        const matches = (
          byName.all(base, base, base + '.md', likeBase) as Array<{ id: string }>
        ).filter((m) => m.id !== r.src_id)
        if (matches.length === 1) {
          dstId = matches[0].id
          status = 'resolved'
        } else if (matches.length > 1) {
          status = 'ambiguous'
          candidates = JSON.stringify(matches.map((m) => m.id))
        }
      }
      upd.run(dstId, status, candidates, r.src_id, r.dst_name)
    }
  })
  tx()
}

/**
 * Re-point inbound link edges from a losing id to a winning id and drop the
 * losing note row + its outgoing edges/tags — the index side of the
 * earliest-created-wins merge (§8.3 layer 3). Links key on the target id, so the
 * re-point is a bounded `UPDATE links SET dst_id=winner WHERE dst_id=loser`.
 * Ambiguous-edge candidate lists that name the loser are rewritten to the winner.
 * Returns the number of inbound edges re-pointed.
 */
export function repointLinks(loserId: string, winnerId: string): number {
  const d = getNotesIndexDb()
  if (!d || loserId === winnerId) return 0
  let repointed = 0
  const tx = d.transaction(() => {
    const res = d.prepare(`UPDATE links SET dst_id=? WHERE dst_id=?`).run(winnerId, loserId)
    repointed = res.changes
    // Rewrite ambiguous candidate lists that referenced the loser id.
    const ambiguous = d
      .prepare(`SELECT rowid, candidates FROM links WHERE candidates IS NOT NULL`)
      .all() as Array<{ rowid: number; candidates: string }>
    const updCand = d.prepare(`UPDATE links SET candidates=? WHERE rowid=?`)
    for (const row of ambiguous) {
      try {
        const cand = JSON.parse(row.candidates) as string[]
        if (!cand.includes(loserId)) continue
        const next = [...new Set(cand.map((c) => (c === loserId ? winnerId : c)))]
        updCand.run(JSON.stringify(next), row.rowid)
      } catch { /* leave malformed candidates untouched */ }
    }
    // Drop the loser note + its own outgoing edges/tags (the winner keeps its own).
    d.prepare(`DELETE FROM links WHERE src_id=?`).run(loserId)
    d.prepare(`DELETE FROM tags WHERE note_id=?`).run(loserId)
    d.prepare(`DELETE FROM notes WHERE id=?`).run(loserId)
  })
  tx()
  return repointed
}

export interface CollisionEntry {
  id: string
  path: string
  created: string | null
}

/**
 * Surface DIVERGENT-COPY collisions for the earliest-created-wins merge (§8.3):
 * two+ DISTINCT notes (different ids) whose title AND body are byte-identical.
 * That is the signature of one logical note that got two ids on two machines and
 * was git-merged into two copies — NOT two genuinely-distinct same-titled notes
 * (whose bodies differ), which must stay separate. Keyed on `title|body` so we
 * never force-merge real distinct notes. The body stored here excludes
 * frontmatter, so the divergent id line does not perturb the equality. Returns
 * only colliding groups (>1 id).
 */
export function divergentCopyGroups(): CollisionEntry[][] {
  const d = getNotesIndexDb()
  if (!d) return []
  const rows = d
    .prepare(`SELECT id, path, title, body, created FROM notes`)
    .all() as Array<{ id: string; path: string; title: string; body: string; created: string | null }>
  const groups = new Map<string, CollisionEntry[]>()
  for (const r of rows) {
    const key = `${r.title.trim().toLowerCase()}\u0000${r.body}`
    const g = groups.get(key) ?? []
    g.push({ id: r.id, path: r.path, created: r.created })
    groups.set(key, g)
  }
  return [...groups.values()].filter((g) => g.length > 1)
}

/** Update just the path of a note (move/rename — links key on id, survive).
 * content_hash is RESET so the follow-up reconcile doesn't hash-skip: the
 * indexed doc is keyed by path, so a move must re-point it (the old path's doc
 * is removed by the ENOENT reconcile). With the hash preserved, the skip made
 * moved notes vanish from semantic search until their next edit. */
export function updateNotePath(fromRel: string, toRel: string): boolean {
  const d = getNotesIndexDb()
  if (!d) return false
  const res = d.prepare(`UPDATE notes SET path=?, content_hash='' WHERE path=?`).run(toRel, fromRel)
  return res.changes > 0
}

export function getNoteByPath(relPath: string): NoteRow | undefined {
  const d = getNotesIndexDb()
  if (!d) return undefined
  return d.prepare(`SELECT * FROM notes WHERE path=?`).get(relPath) as
    | NoteRow
    | undefined
}

// ── Attachment text (PDF/OCR sidecar rows) ──────────────────────────────────

export interface AttachmentTextRow {
  path: string
  content_hash: string
  text: string
  method: string
  status: string
  mtime: string
  size: number
}

export function getAttachmentMeta(relPath: string): Pick<AttachmentTextRow, 'content_hash' | 'status'> | undefined {
  const d = getNotesIndexDb()
  if (!d) return undefined
  return d.prepare(`SELECT content_hash, status FROM attachment_text WHERE path=?`).get(relPath) as
    | Pick<AttachmentTextRow, 'content_hash' | 'status'>
    | undefined
}

export function listAttachmentMeta(): Array<Pick<AttachmentTextRow, 'path' | 'mtime' | 'size' | 'status'>> {
  const d = getNotesIndexDb()
  if (!d) return []
  return d.prepare(`SELECT path, mtime, size, status FROM attachment_text`).all() as Array<
    Pick<AttachmentTextRow, 'path' | 'mtime' | 'size' | 'status'>
  >
}

export function upsertAttachmentText(row: Omit<AttachmentTextRow, 'extracted_at'>): void {
  const d = getNotesIndexDb()
  if (!d) return
  d.prepare(
    `INSERT INTO attachment_text (path, content_hash, text, method, status, mtime, size, extracted_at)
     VALUES (@path, @content_hash, @text, @method, @status, @mtime, @size, datetime('now'))
     ON CONFLICT(path) DO UPDATE SET
       content_hash=excluded.content_hash, text=excluded.text, method=excluded.method,
       status=excluded.status, mtime=excluded.mtime, size=excluded.size,
       extracted_at=excluded.extracted_at`,
  ).run(row)
}

export function deleteAttachmentText(relPath: string): void {
  const d = getNotesIndexDb()
  if (!d) return
  d.prepare(`DELETE FROM attachment_text WHERE path=?`).run(relPath)
}

export interface AttachmentHit {
  path: string
  text: string
  stringScore: number
}

/**
 * Search extracted attachment text (FTS + CJK/substring LIKE fallback).
 * Attachment hits carry the LOW body band (0.45 word / 0.40 substring) — the
 * text is machine-extracted, noisier than authored notes, so authored content
 * always outranks it; but a receipt/letter/screenshot becomes findable at all.
 */
export function attachmentSearch(q: string, limit: number, options: StringSearchOptions = {}): AttachmentHit[] {
  const d = getNotesIndexDb()
  if (!d) return []
  const out: AttachmentHit[] = []
  const seen = new Set<string>()
  const exclA = exclusionSql('a.path', options.excludeFolders ?? [])
  const excl = exclusionSql('path', options.excludeFolders ?? [])
  const ftsQuery = escapeFts(q)
  if (ftsQuery) {
    try {
      const rows = d
        .prepare(
          `SELECT a.path, a.text FROM attachment_fts f
           JOIN attachment_text a ON a.rowid = f.rowid
           WHERE attachment_fts MATCH ?${exclA.sql} ORDER BY bm25(attachment_fts) LIMIT ?`,
        )
        .all(ftsQuery, ...exclA.params, limit) as Array<{ path: string; text: string }>
      for (const r of rows) {
        seen.add(r.path)
        out.push({ path: r.path, text: r.text, stringScore: 0.45 })
      }
    } catch { /* malformed MATCH — LIKE below still runs */ }
  }
  if (out.length < limit) {
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`
    const rows = d
      .prepare(`SELECT path, text FROM attachment_text WHERE text LIKE ? ESCAPE '\\'${excl.sql} LIMIT ?`)
      .all(like, ...excl.params, limit) as Array<{ path: string; text: string }>
    for (const r of rows) {
      if (seen.has(r.path)) continue
      out.push({ path: r.path, text: r.text, stringScore: hasCjk(q) ? 0.45 : 0.4 })
      if (out.length >= limit) break
    }
  }
  return out
}

export interface NoteSyncMeta {
  path: string
  modified: string
  size: number
}

/** (path, mtime, size) for every indexed note — the drift scan's comparison set. */
export function listNoteSyncMeta(): NoteSyncMeta[] {
  const d = getNotesIndexDb()
  if (!d) return []
  return d.prepare(`SELECT path, modified, size FROM notes`).all() as NoteSyncMeta[]
}

/** Refresh the stat columns on a hash-skip so an mtime-only touch (id back-write,
 * `touch`, git checkout) doesn't re-appear in every boot's drift scan. */
export function touchNoteStat(relPath: string, modified: string, size: number): void {
  const d = getNotesIndexDb()
  if (!d) return
  d.prepare(`UPDATE notes SET modified=?, size=? WHERE path=?`).run(modified, size, relPath)
}

export function getNoteHash(relPath: string): string | undefined {
  const d = getNotesIndexDb()
  if (!d) return undefined
  const row = d.prepare(`SELECT content_hash FROM notes WHERE path=?`).get(relPath) as
    | { content_hash: string }
    | undefined
  return row?.content_hash
}

export function getNoteIdByPath(relPath: string): string | undefined {
  const d = getNotesIndexDb()
  if (!d) return undefined
  const row = d.prepare(`SELECT id FROM notes WHERE path=?`).get(relPath) as
    | { id: string }
    | undefined
  return row?.id
}

/**
 * Resolve a frontmatter id → the note's vault-relative path. The inverse of
 * getNoteIdByPath: note_search answers with `id` FIRST on every hit, so an
 * agent that hands that id back must get the note, not "invalid path".
 */
export function getNotePathById(id: string): string | undefined {
  const d = getNotesIndexDb()
  if (!d) return undefined
  const row = d.prepare(`SELECT path FROM notes WHERE id=?`).get(id) as { path: string } | undefined
  return row?.path
}

/**
 * Resolve a name (title OR basename) → matching note ids (case-insensitive).
 * Matches like Obsidian: `[[Title]]` resolves on the note's display title OR its
 * filename basename (so `[[dup]]` matches `a/dup.md`). The basename match uses a
 * trailing `/name.md` LIKE plus an exact `name.md` for root-level files.
 */
export function findNoteIdsByName(name: string): Array<{ id: string; path: string }> {
  const d = getNotesIndexDb()
  if (!d) return []
  const base = name.replace(/\.md$/, '')
  const baseMd = base + '.md'
  // Escape LIKE wildcards in the basename so a literal `_`/`%` doesn't glob.
  const likeBase = '%/' + base.replace(/[\\%_]/g, (m) => '\\' + m) + '.md'
  return d
    .prepare(
      `SELECT id, path FROM notes
       WHERE title = ? COLLATE NOCASE
          OR path = ? COLLATE NOCASE
          OR path = ? COLLATE NOCASE
          OR path LIKE ? ESCAPE '\\' COLLATE NOCASE`,
    )
    .all(base, base, baseMd, likeBase) as Array<{ id: string; path: string }>
}

/** Resolve a path form `[[folder/Title]]` → note id (exact, collision-free). */
export function findNoteIdByPathForm(relPath: string): string | undefined {
  const d = getNotesIndexDb()
  if (!d) return undefined
  const withMd = relPath.endsWith('.md') ? relPath : relPath + '.md'
  const row = d
    .prepare(`SELECT id FROM notes WHERE path=? COLLATE NOCASE OR path=? COLLATE NOCASE`)
    .get(relPath, withMd) as { id: string } | undefined
  return row?.id
}

// ── Reads (used by routes) ──────────────────────────────────────────────────

export interface StringHit {
  id: string
  path: string
  title: string
  body: string
  /**
   * Relevance in a banded [0,1] scale so the route can rank string hits
   * meaningfully (was hardcoded 1 → every exact hit tied). Bands are disjoint
   * and ordered so a title match ALWAYS outranks a body match:
   *   title/basename exact 1.0 · prefix .96 · word .93 · CJK/long-substr .90
   *   FOLDER-name match .88–.89 · section HEADING word match .87 · tag .86
   *   body FTS .50–.85 (by bm25) · title mid-token substr .30
   *   LIKE body fallback: CJK .50 · word .25 · mid-token .10
   * Title mid-token substrings ("sin" in "Business") were 0.90 — above every
   * body band — so 3-letter queries drowned true hits under coincidences.
   */
  stringScore: number
  /**
   * Set when the hit was matched by its FOLDER path rather than by title/body
   * (query "dairy" → every note under `Areas/Journal/Dairy/`). The route surfaces
   * these grouped under the folder so the answer reads as "this folder" instead
   * of an undifferentiated list of date-named notes.
   */
  folderMatch?: string
  /** Set when the hit matched a SECTION HEADING (`## SIN`) — shown in the UI row. */
  headingMatch?: string
  /** Set when the hit came from the fuzzy-corrected retry: the spelling that
   *  actually appears in the note ("marina" for typed "marnia"). The snippet
   *  highlighter needs it — the TYPED tokens don't occur in this body. */
  correctedQuery?: string
  /** Note's last-modified ISO timestamp — feeds the recency tiebreak. */
  modified?: string
  /** Set when the hit matched one of the note's tags. */
  matchedTags?: string[]
}

/** True when the string contains CJK — no word boundaries exist, so substring IS the match unit. */
function hasCjk(s: string): boolean {
  return /[㐀-鿿豈-﫿぀-ヿ가-힯]/u.test(s)
}

/** Query → tag-slug form, mirroring notes-indexer's normalizeTag (kept local:
 * the indexer imports from this file, so importing back would be a cycle). */
function normalizeTagSlug(raw: string): string {
  return raw.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-')
}

// ── Folder exclusion (user-configured, query-time) ──────────────────────────

export interface StringSearchOptions {
  /** Vault-relative folder prefixes to exclude (e.g. ['archive']). Applied in
   *  SQL so excluded rows never consume the LIMIT window. Content stays
   *  indexed — this is a view filter, not an index filter. */
  excludeFolders?: string[]
  /** Internal: set on the fuzzy retry so a corrected query can never recurse
   *  into a second round of correction. */
  noFuzzy?: boolean
}

/** Normalize exclusion entries: trim slashes/whitespace, drop empties. */
export function normalizeExcludeFolders(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((e) => String(e).trim().replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
}

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m)
}

/** SQL fragment excluding paths under any of the folders. SQLite LIKE is
 *  case-insensitive for ASCII, matching how users type folder names. */
function exclusionSql(col: string, excludes: string[]): { sql: string; params: string[] } {
  if (excludes.length === 0) return { sql: '', params: [] }
  const conds = excludes.map(() => `${col} LIKE ? ESCAPE '\\'`).join(' OR ')
  return { sql: ` AND NOT (${conds})`, params: excludes.map((e) => likeEscape(e) + '/%') }
}

/** JS-side mirror of exclusionSql for post-filtering non-SQL result sets
 *  (the semantic leg's absolute→relative paths). */
export function isPathExcluded(relPath: string, excludes: string[]): boolean {
  if (excludes.length === 0) return false
  const p = relPath.toLowerCase()
  return excludes.some((e) => p.startsWith(e.toLowerCase() + '/'))
}

/**
 * Function words that carry no retrieval signal in a natural-language query
 * ("trying to have a baby", "is it worth breaking the mortgage"). Used by the
 * relaxed FTS pass and the token-wise folder leg — NEVER applied to note
 * content, only to the user's query tokens.
 */
const QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'was', 'are', 'has', 'had', 'not', 'you', 'your',
  'this', 'that', 'with', 'from', 'into', 'over', 'under', 'about', 'after',
  'before', 'between', 'during', 'without', 'within', 'what', 'when', 'where',
  'why', 'how', 'who', 'which', 'can', 'could', 'should', 'would', 'will',
  'have', 'having', 'been', 'being', 'than', 'then', 'them', 'they', 'their',
  'there', 'here', 'our', 'but', 'all', 'any', 'some', 'more', 'most', 'out',
  'off', 'per', 'via', 'does', 'did', 'done', 'get', 'got', 'its', 'his',
  'her', 'him', 'she', 'were', 'notes', 'note',
  // Authoring chrome in agent/sentence phrasing ("full evaluation of tesla
  // stock WRITTEN in august") — never note content, only breaks coverage.
  'written', 'wrote', 'created', 'updated', 'edited', 'saved',
])

/** Content-bearing query tokens: lowercase, ≥3 chars (CJK: ≥2 — a Chinese
 *  word is typically two characters), minus function words. Exported as the
 *  ONE query-tokenization truth — the search route's snippet highlighter and
 *  the client's title highlighter must mark the same words this index
 *  matched on, not re-derive their own token rules. */
export function contentTokens(q: string): string[] {
  return q.toLowerCase().trim().split(/\s+/)
    .filter((t) => (t.length >= 3 || (t.length >= 2 && hasCjk(t))) && !QUERY_STOPWORDS.has(t))
}

/** Folder names use '-'/'_' as word separators ("canada-immigration"). One
 *  normal form so a spaced query can match a hyphenated segment and back. */
function normalizeSeparators(s: string): string {
  return s.replace(/[-_]+/g, ' ')
}

/** Words of one path segment ("Should I break variable mortgage" → 5 words). */
function segmentWords(seg: string): string[] {
  return normalizeSeparators(seg.toLowerCase()).split(/\s+/).filter(Boolean)
}

/** Query token vs segment/vocab word, inflection-tolerant: exact, or one is a
 *  prefix of the other with the shorter side ≥5 chars ("break"/"breaking") —
 *  short words never prefix-claim ("the" must not match "theory"). */
function tokenMatchesWord(tok: string, word: string): boolean {
  if (tok === word) return true
  const [short, long] = tok.length <= word.length ? [tok, word] : [word, tok]
  return short.length >= 5 && long.startsWith(short)
}

/**
 * Banded relevance for a hit given the query. Returns a title-band score when
 * the query matches the title (so titles always beat body matches), else null
 * to let the caller assign the appropriate body band.
 */
function titleScore(title: string, q: string): number | null {
  const t = title.toLowerCase()
  const ql = q.toLowerCase()
  if (!ql) return null
  if (t === ql) return 1.0
  if (t.startsWith(ql)) return 0.96
  // word-boundary occurrence (whole word, not mid-token like "accidental")
  if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(ql)}([^\\p{L}\\p{N}]|$)`, 'u').test(t)) return 0.93
  // word-PREFIX occurrence ("datapoint" in "Datapoints", "achieve" in "achievements")
  if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(ql)}`, 'u').test(t)) return 0.92
  if (t.includes(ql)) {
    // CJK has no word boundaries — a substring hit IS the word hit. Same for
    // long Latin queries (≥5 chars), where a coincidental mid-token embedding
    // is unlikely ("pollo" in "Apollo"). But SHORT Latin substrings are almost
    // always noise ("sin" in "Business"/"using"/"missing") — those buried real
    // matches under a wall of 0.90s. Park them BELOW every body band.
    if (hasCjk(ql) || ql.length >= 5) return 0.9
    return 0.3
  }
  // Multi-word query whose words are all in the title but not adjacent
  // ("work datapoint" → title "Work Achievement Datapoints"). Each token must
  // appear as a word-prefix; score just below a contiguous substring (.90) so a
  // title that holds every query word still outranks any body-only match.
  const tokens = ql.split(/\s+/).filter(Boolean)
  if (tokens.length > 1) {
    const allInTitle = tokens.every((tok) =>
      new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(tok)}`, 'u').test(t),
    )
    if (allInTitle) return 0.88
    // The QUERY covers the whole TITLE ("dna test results" ⊇ title "DNA
    // Test"; "masters application resume" ⊇ "Resume-Application"): the user
    // typed the note's full name plus extra words. Stronger than any folder
    // membership (0.875-0.89), weaker than a word-boundary phrase hit (0.93).
    // ≥2 content words so a one-word title can't claim every query naming it.
    const titleWords = t.split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !QUERY_STOPWORDS.has(w))
    // Title-side abbreviation: an authored short label covered by a longer
    // query token ("Gov document" found by "goverment document", "eval" by
    // "evaluation"). Only valid HERE, where every other title word must also
    // be covered — as a general matcher it would let "app" claim "apple".
    const coversWord = (tok: string, w: string): boolean =>
      tokenMatchesWord(tok, w)
      || (w.length >= 3 && tok.length >= w.length + 3 && tok.startsWith(w))
    if (
      titleWords.length >= 2 &&
      titleWords.every((w) => tokens.some((tok) => coversWord(tok, w)))
    ) return 0.91
  }
  return null
}

/**
 * Title-band score across BOTH the display title and the filename basename,
 * whichever is stronger. A note whose FILE is literally `SIN number.md` must
 * rank as a title hit for "sin" even when its display title (first H1, e.g.
 * "Social Insurance Number Application Completed") never says "SIN" — users
 * name files by what they'll search for; ignoring the basename threw that
 * signal away.
 */
function nameScore(title: string, relPath: string, q: string): number | null {
  const fromTitle = titleScore(title, q)
  const base = relPath.split('/').pop()?.replace(/\.md$/i, '') ?? ''
  const fromBase = base && base !== title ? titleScore(base, q) : null
  if (fromTitle == null) return fromBase
  if (fromBase == null) return fromTitle
  return Math.max(fromTitle, fromBase)
}

/**
 * Word-boundary match against the note's SECTION HEADINGS (newline-joined
 * `##`+ lines captured at reconcile time). Sits between the folder bands
 * (.88–.89) and the best body-FTS band (.85): `## SIN` is a deliberate,
 * author-written label — stronger evidence than any body mention, weaker than
 * the note being titled/named that. Returns the matched heading for the UI.
 */
function headingScore(headings: string, q: string, title = ''): { band: number; heading: string } | null {
  if (!headings) return null
  const ql = q.toLowerCase().trim()
  if (!ql) return null
  const cjk = hasCjk(ql)
  // Lines are ancestor paths ("Eye > prescription"); headingMatch must be the
  // LEAF — it anchors the snippet to the section's own text in the body.
  const leaf = (h: string): string => h.split(' > ').pop() ?? h
  for (const h of headings.split('\n')) {
    const hl = h.toLowerCase()
    if (cjk ? hl.includes(ql) : new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(ql)}`, 'u').test(hl)) {
      return { band: 0.87, heading: leaf(h) }
    }
  }
  // Token-wise across one path line, with the note TITLE as the virtual root
  // (the title IS the H1): "goals review log" names the `## Review log`
  // section of GOALS.md; "eye prescription" a `### prescription` under
  // `## Eye`. No single heading holds the phrase, the composed path does.
  // Slightly under the whole-phrase band so an exact heading still wins.
  const toks = contentTokens(ql)
  if (toks.length >= 2) {
    const titleWords = title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
    for (const h of headings.split('\n')) {
      const words = [...titleWords, ...h.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)]
      if (toks.every((t) => words.some((w) => tokenMatchesWord(t, w)))) {
        return { band: 0.868, heading: leaf(h) }
      }
    }
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Banded relevance for a FOLDER-name match, scored on path segments so the query
 * matches a real directory rather than an arbitrary path substring. Bands sit
 * just BELOW every title band (≥0.90) and just ABOVE the best body-FTS band
 * (0.85): a note actually titled "Dairy" should still outrank the notes merely
 * stored in a Dairy/ folder, but folder membership beats any body mention.
 */
function folderScore(segments: string[], q: string): number | null {
  const ql = q.toLowerCase().trim()
  if (!ql) return null
  // Separator-normalized forms so "canada immigration" matches the segment
  // "canada-immigration" (and a hyphenated query matches a spaced folder).
  const qn = normalizeSeparators(ql)
  let best: number | null = null
  for (const seg of segments) {
    const s = seg.toLowerCase()
    const sn = normalizeSeparators(s)
    let band: number | null = null
    if (s === ql || sn === qn) band = 0.89
    else if (s.startsWith(ql) || sn.startsWith(qn)) band = 0.888
    else if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(ql)}`, 'u').test(s)) band = 0.885
    // Mid-token folder substring: only meaningful for CJK / long queries (same
    // rationale as titleScore — "sin" inside "Business/" is noise, not a folder).
    else if ((hasCjk(ql) || ql.length >= 5) && (s.includes(ql) || sn.includes(qn))) band = 0.88
    if (band != null && (best == null || band > best)) best = band
  }
  return best
}

/** The deepest folder path whose segment matched — the group label for the UI.
 * Uses the same match rule as folderScore so a noise substring ("sin" inside a
 * "Business/" segment) can't be promoted into a folder group. */
function matchedFolderPath(segments: string[], q: string): string | undefined {
  const ql = q.toLowerCase().trim()
  if (!ql) return undefined
  for (let i = segments.length - 1; i >= 0; i--) {
    if (folderScore([segments[i]], q) != null) return segments.slice(0, i + 1).join('/')
  }
  return undefined
}

/**
 * Escape an FTS5 query: wrap each whitespace-delimited token in double quotes
 * (doubling internal quotes) so operators/punctuation can't break the MATCH.
 * Mirrors the care taken in memory-search.ts's sanitizeForVec.
 */
export function escapeFts(q: string): string {
  const tokens = q.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return ''
  // Prefix-match each token (`"tok"*`) so a query word matches longer words it
  // begins — "datapoint" hits "Datapoints", "achieve" hits "achievement". Without
  // this, FTS5 only matched whole tokens, so a plural/inflected title silently
  // failed (the note existed but search "found nothing"). AND across tokens is
  // implicit, so multi-word queries need every token present (still prefix).
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ')
}

// ── Fuzzy correction: typo in the QUERY ("glucoma") or in the NOTE ("Bevar") ──

// Both caches are keyed by the DB INSTANCE as well as the TTL: a close/reopen
// (index rebuild, schema bump, vault switch) makes a new instance, and serving
// the previous vault's words for up to 60s corrected queries toward spellings
// that no longer exist anywhere.
interface VaultVocab { db: DatabaseType; counts: Map<string, number>; list: string[]; builtAt: number }
let vocabCache: VaultVocab | null = null
const VOCAB_TTL_MS = 60_000

/** Latin words of every note title + path segment, WITH occurrence counts
 *  (the vault's own spelling, typos included — that's the point: correcting
 *  the query TOWARD the vault finds notes whose author misspelled them, and
 *  counts let us prefer the majority spelling when both exist). ~15-25k words. */
function getVaultVocab(d: DatabaseType): VaultVocab | null {
  if (vocabCache && vocabCache.db === d && Date.now() - vocabCache.builtAt < VOCAB_TTL_MS) return vocabCache
  try {
    const rows = d.prepare('SELECT title, path FROM notes').all() as Array<{ title: string; path: string }>
    const counts = new Map<string, number>()
    for (const r of rows) {
      for (const w of `${r.title} ${r.path}`.toLowerCase().split(/[^a-z0-9]+/)) {
        if (w.length >= 3 && w.length <= 24 && !/^\d+$/.test(w)) {
          counts.set(w, (counts.get(w) ?? 0) + 1)
        }
      }
    }
    vocabCache = { db: d, counts, list: [...counts.keys()], builtAt: Date.now() }
    return vocabCache
  } catch {
    return null
  }
}

/** Test hook: a rebuilt index (fresh WALNUT_HOME) must not see stale words. */
export function resetVaultVocabForTests(): void {
  vocabCache = null
}

/** Banded Levenshtein: distance if ≤ max, else null (early row-min bailout). */
function editDistanceAtMost(a: string, b: string, max: number): number | null {
  if (Math.abs(a.length - b.length) > max) return null
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      cur.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return null
    prev = cur
  }
  return prev[b.length] <= max ? prev[b.length] : null
}

/**
 * Rewrite query tokens the vault has never seen toward their nearest vault
 * word. Three forms, cheapest evidence first: token already a PREFIX of a
 * vault word → leave it (FTS `"tok"*` already matches); a vault word is a
 * PREFIX of the token (note says "impro", query says "improvement") → shrink
 * to the vault form; else edit distance ≤1 (short) / ≤2. Returns the corrected
 * query, or null when nothing changed.
 */
function correctQueryTokens(q: string, d: DatabaseType): string | null {
  const vocab = getVaultVocab(d)
  if (!vocab || vocab.counts.size === 0) return null
  let changed = false
  const corrected = q.trim().split(/\s+/).map((raw) => {
    const tok = raw.toLowerCase()
    if (tok.length < 4 || hasCjk(tok) || QUERY_STOPWORDS.has(tok)) return raw
    if (!/^[a-z0-9'-]+$/.test(tok)) return raw
    const tokCount = vocab.counts.get(tok) ?? 0
    if (tokCount > 0) {
      // The token IS a vault word — but the vault may hold both a typo'd and a
      // correct spelling ("glucoma" in one old note, "glaucoma" everywhere
      // else). Only a distance-1 neighbour that clearly DOMINATES the token's
      // own count may add its results; anything weaker leaves the query alone.
      let best: string | null = null
      let bestCount = 0
      for (const w of vocab.list) {
        const c = vocab.counts.get(w) ?? 0
        if (c < Math.max(2, 2 * tokCount) || c <= bestCount) continue
        if (editDistanceAtMost(tok, w, 1) === 1) { best = w; bestCount = c }
      }
      if (!best) return raw
      changed = true
      return best
    }
    if (vocab.list.some((w) => w.startsWith(tok))) return raw
    let best: string | null = null
    let bestDist = Infinity
    let bestPrefix = -1
    let bestCount = 0
    const maxDist = tok.length <= 5 ? 1 : 2
    // Equal-distance ties MUST break on real signal — longest common prefix
    // (typos rarely hit the first letters), then vault count. Breaking on
    // vocab-list order made the winner depend on the notes table's physical
    // row order: an index rebuild reshuffled it and a query word silently
    // started correcting to an unrelated same-distance word.
    const commonPrefix = (a: string, b: string): number => {
      let i = 0
      while (i < a.length && i < b.length && a[i] === b[i]) i++
      return i
    }
    for (const w of vocab.list) {
      let dist: number
      if (w.length >= 4 && w.length < tok.length && tok.startsWith(w)) {
        // Prefix-shrink: better than a distance-2 guess, worse than distance-1.
        dist = 1.5
      } else {
        const d = editDistanceAtMost(tok, w, maxDist)
        if (d == null || d === 0) continue
        dist = d
      }
      const pfx = commonPrefix(tok, w)
      const cnt = vocab.counts.get(w) ?? 0
      if (
        dist < bestDist
        || (dist === bestDist && (pfx > bestPrefix || (pfx === bestPrefix && cnt > bestCount)))
      ) {
        best = w
        bestDist = dist
        bestPrefix = pfx
        bestCount = cnt
      }
    }
    if (!best) return raw
    changed = true
    return best
  })
  return changed ? corrected.join(' ') : null
}

// ── Direct folder-name search (folders with no notes are otherwise invisible) ──

interface FolderList { db: DatabaseType; list: string[]; builtAt: number }
let folderListCache: FolderList | null = null

/** Every folder path that exists in the vault, derived from note AND
 *  attachment paths — a folder holding only PDFs has zero note rows, so the
 *  note-driven folder leg can never surface it. Cached briefly. */
function getFolderList(d: DatabaseType): FolderList {
  if (folderListCache && folderListCache.db === d && Date.now() - folderListCache.builtAt < VOCAB_TTL_MS) return folderListCache
  const dirs = new Set<string>()
  for (const sql of ['SELECT path FROM notes', 'SELECT path FROM attachment_text']) {
    try {
      for (const r of d.prepare(sql).all() as Array<{ path: string }>) {
        const segs = r.path.split('/')
        for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'))
      }
    } catch { /* attachment table may not exist on old indexes */ }
  }
  folderListCache = { db: d, list: [...dirs], builtAt: Date.now() }
  return folderListCache
}

/** Test hook (paired with resetVaultVocabForTests). */
export function resetFolderListForTests(): void {
  folderListCache = null
}

/**
 * Folders whose OWN name matches the query — independent of whether they
 * contain any notes. Same match rules as the folder leg (whole-query segment
 * match, or ≥2 content tokens hitting words of the name), plus the fuzzy
 * correction pass when the literal query matches nothing.
 */
export function searchFolders(q: string, limit = 5, options: StringSearchOptions = {}): string[] {
  const d = getNotesIndexDb()
  if (!d) return []
  const folders = getFolderList(d)
  const excludes = options.excludeFolders ?? []
  const tryMatch = (query: string): string[] => {
    const hits: string[] = []
    const toks = contentTokens(query)
    for (const f of folders.list) {
      if (isPathExcluded(f + '/', excludes) || isPathExcluded(f, excludes)) continue
      const last = f.split('/').pop() ?? f
      let matched = folderScore([last], query) != null
      if (!matched && toks.length >= 2) {
        const words = segmentWords(last)
        matched = words.length >= 2
          && toks.filter((t) => words.some((w) => tokenMatchesWord(t, w))).length >= 2
      }
      if (matched) {
        hits.push(f)
        if (hits.length >= limit) break
      }
    }
    return hits
  }
  let res = tryMatch(q)
  if (res.length === 0 && !options.noFuzzy && !hasCjk(q)) {
    const corrected = correctQueryTokens(q, d)
    if (corrected && corrected !== q.trim().toLowerCase()) res = tryMatch(corrected)
  }
  return res
}

/**
 * Exact/substring string search over the structural index.
 * FTS5 first (sublinear token/prefix match), then a capped LIKE fallback for
 * mid-token substrings FTS5 cannot match (e.g. 'pollo' in 'Apollo').
 */
export function stringSearch(q: string, limit: number, options: StringSearchOptions = {}): StringHit[] {
  const d = getNotesIndexDb()
  if (!d) return []
  // Max-merge bookkeeping: several legs can hit the SAME note, and leg order
  // is evidence order, not score order — the title leg's weak partial (0.75)
  // must not block the folder leg's 0.873 or the fuzzy retry's corrected title
  // band for that note. Every leg funnels through addHit(); the best band
  // wins, and structural annotations (folderMatch/headingMatch/tags) merge in.
  const byId = new Map<string, StringHit>()
  const addHit = (hit: StringHit): void => {
    const prev = byId.get(hit.id)
    if (!prev) {
      byId.set(hit.id, hit)
      return
    }
    if (hit.stringScore > prev.stringScore) {
      byId.set(hit.id, {
        ...hit,
        folderMatch: hit.folderMatch ?? prev.folderMatch,
        headingMatch: hit.headingMatch ?? prev.headingMatch,
        matchedTags: hit.matchedTags ?? prev.matchedTags,
        correctedQuery: hit.correctedQuery ?? prev.correctedQuery,
      })
    } else {
      if (hit.folderMatch && !prev.folderMatch) prev.folderMatch = hit.folderMatch
      if (hit.headingMatch && !prev.headingMatch) prev.headingMatch = hit.headingMatch
      if (hit.matchedTags && !prev.matchedTags) prev.matchedTags = hit.matchedTags
      if (hit.correctedQuery && !prev.correctedQuery) prev.correctedQuery = hit.correctedQuery
    }
  }
  const excl = exclusionSql('path', options.excludeFolders ?? [])

  type RawHit = { id: string; path: string; title: string; body: string; headings?: string; rank?: number; modified?: string }

  // Name-first leg: pull notes whose TITLE or FILENAME matches, scored by
  // nameScore, BEFORE the FTS body leg. The FTS leg is `ORDER BY bm25 LIMIT n` —
  // ranked purely by body relevance — so a note with a perfect title but a
  // short/sparse body (e.g. a 300-byte "Achievement.md") would get a weak bm25
  // and be truncated out of the window entirely, never reaching the JS re-rank.
  // Capturing name matches up front guarantees they're in the result set and
  // rank at their title band. Matching `path` catches basename-only hits
  // (file `SIN number.md` whose display title never says "SIN").
  const titleLike = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`
  // Prefetch on EVERY content token, not just the first — "my daily rhythm"
  // must pull the note titled "RHYTHM" into the candidate set even though the
  // full phrase and the first word both miss it. Function words are skipped
  // ('%my%' would pull 60 arbitrary rows); ≤4 tokens keeps the OR bounded.
  const prefetchToks = contentTokens(q).slice(0, 4)
  if (prefetchToks.length === 0) {
    const raw = q.trim().split(/\s+/)[0] ?? ''
    if (raw) prefetchToks.push(raw)
  }
  const tokLikes = prefetchToks.map((t) => `%${t.replace(/[\\%_]/g, (m) => '\\' + m)}%`)
  // limit*6 window: the OR over tokens returns rows in table order, and a
  // common title word ("resume") can fill a small window with one folder's
  // files before the note the query actually names is even scanned. Each
  // token probes the PATH too — a note whose display title is unrelated (a
  // resume's H1 is the person's name) is still named by its FILENAME.
  const titleRows = d
    .prepare(
      `SELECT id, path, title, body, modified FROM notes
       WHERE (title LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'${" OR title LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\'".repeat(tokLikes.length)})${excl.sql}
       LIMIT ?`,
    )
    .all(titleLike, titleLike, ...tokLikes.flatMap((t) => [t, t]), ...excl.params, limit * 6) as RawHit[]
  // Mid-token substring hits (band ≤0.30) are collected but NOT marked seen and
  // only appended AFTER the strong legs: a later leg (heading/FTS body) may score
  // the same note higher, and they must never crowd word matches out of `out`.
  const weakNameHits: StringHit[] = []
  const qContentTokens = contentTokens(q)
  let partialTitleHits = 0
  let partialTitleWeak = 0
  for (const r of titleRows) {
    let band = nameScore(r.title, r.path, q)
    // Partial-title band: a multi-word query where SOME content token is a
    // real title/filename word ("my daily rhythm" → note titled "RHYTHM")
    // still names the note — full-phrase and all-words-in-title failed, but
    // one deliberate title word beats any body-only match. Graded so a title
    // that IS the token (0.858) outranks one merely containing it (0.855);
    // the whole band sits under tag (0.86), above the best body-FTS (0.85).
    // Capped: incidental one-word overlaps must never flood the list.
    if (band == null && qContentTokens.length >= 2 && partialTitleHits < 8) {
      let bestTok = 0
      let bestTokWord = ''
      for (const tok of qContentTokens) {
        const s = nameScore(r.title, r.path, tok) ?? 0
        if (s > bestTok) { bestTok = s; bestTokWord = tok }
      }
      if (bestTok >= 0.92) {
        // Supported = every OTHER content token also appears somewhere in the
        // note. One title word + the rest of the query present is a real name
        // hit; one title word alone ("gap" naming an unrelated note for query
        // "insurence gap") is a coincidence and must rank under the corrected/
        // relaxed full-evidence bands.
        const hay = `${r.title}\n${r.path}\n${r.body}`.toLowerCase()
        // A month NAME in the query supports against the month NUMBER in a
        // dated filename ("written in august" / "四月 日记" ⇒ …-2026-08.md).
        const monthNum = (tok: string): string | undefined => ({
          january: '1', february: '2', march: '3', april: '4', june: '6', july: '7',
          august: '8', september: '9', october: '10', november: '11', december: '12',
          一月: '1', 二月: '2', 三月: '3', 四月: '4', 五月: '5', 六月: '6', 七月: '7',
          八月: '8', 九月: '9', 十月: '10', 十一月: '11', 十二月: '12',
        } as Record<string, string>)[tok] // english 'may' omitted: too common as a verb
        const tokSupported = (tok: string): boolean => {
          if (hay.includes(tok)) return true
          const m = monthNum(tok)
          return m !== undefined && new RegExp(`[-_./ ]0?${m}(?=\\D|$)`).test(hay)
        }
        // Long sentence queries tolerate ONE unsupported word: "full
        // evaluation of tesla stock written in august" names a note that
        // never says "stock". Short queries keep the strict rule — with two
        // tokens, one miss IS the "insurence gap" coincidence.
        const misses = qContentTokens
          .filter((tok) => tok !== bestTokWord && !tokSupported(tok)).length
        const supported = misses === 0 || (qContentTokens.length >= 5 && misses === 1)
        // Separate caps: unsupported 0.75s are the flood risk, and counting
        // them against the shared cap let 8 table-order-earlier "stock" rows
        // starve the one real supported name hit scanned after them.
        if (supported) {
          band = bestTok >= 0.96 ? 0.858 : bestTok >= 0.93 ? 0.856 : 0.855
          partialTitleHits++
        } else if (partialTitleWeak < 8) {
          band = 0.75
          partialTitleWeak++
        } else {
          band = null
        }
      }
    }
    if (band == null) continue // matched a token but not as a scorable name hit
    const hit = { id: r.id, path: r.path, title: r.title, body: r.body, stringScore: band, modified: r.modified }
    if (band <= 0.3) {
      weakNameHits.push(hit)
    } else {
      addHit(hit)
    }
  }

  // Heading leg: notes whose SECTION HEADINGS contain the query as a word
  // ("## SIN" in a grab-bag "Gov document" note). An author-written label —
  // outranks any body mention (band .87), sits below name/folder bands.
  // Whole-phrase prefetch, plus a per-token AND prefetch for the cross-level
  // case ("eye prescription" = `### prescription` under `## Eye`): the phrase
  // never appears contiguously, but every token does — headingScore then
  // verifies the tokens land in ONE ancestor-path line.
  const headingToks = contentTokens(q)
  const headingRowsById = new Map<string, RawHit>()
  for (const r of d
    .prepare(
      `SELECT id, path, title, body, headings, modified FROM notes
       WHERE headings LIKE ? ESCAPE '\\'${excl.sql}
       LIMIT ?`,
    )
    .all(titleLike, ...excl.params, limit * 2) as RawHit[]) headingRowsById.set(r.id, r)
  if (headingToks.length >= 2) {
    // Each token may sit in the headings OR the title (the virtual root).
    const conds = headingToks.map(() => `(headings LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')`).join(' AND ')
    for (const r of d
      .prepare(
        `SELECT id, path, title, body, headings, modified FROM notes
         WHERE ${conds}${excl.sql}
         LIMIT ?`,
      )
      .all(...headingToks.flatMap((t) => [`%${likeEscape(t)}%`, `%${likeEscape(t)}%`]), ...excl.params, limit * 2) as RawHit[]) {
      headingRowsById.set(r.id, r)
    }
  }
  for (const r of headingRowsById.values()) {
    const hs = headingScore(r.headings ?? '', q, r.title)
    if (!hs) continue
    addHit({
      id: r.id, path: r.path, title: r.title, body: r.body,
      stringScore: hs.band, headingMatch: hs.heading, modified: r.modified,
    })
  }

  // Tag leg: notes tagged with the query (normalized slug form). Tags are
  // deliberate curation — band .86, just under headings.
  const tagSlug = normalizeTagSlug(q)
  if (tagSlug) {
    const tagExcl = exclusionSql('n.path', options.excludeFolders ?? [])
    const tagRows = d
      .prepare(
        `SELECT n.id, n.path, n.title, n.body, n.modified FROM tags t JOIN notes n ON n.id = t.note_id
         WHERE (t.tag = ? OR t.tag LIKE ? ESCAPE '\\')${tagExcl.sql}
         LIMIT ?`,
      )
      .all(tagSlug, tagSlug.replace(/[\\%_]/g, (m) => '\\' + m) + '/%', ...tagExcl.params, limit) as RawHit[]
    for (const r of tagRows) {
      addHit({ id: r.id, path: r.path, title: r.title, body: r.body, stringScore: 0.86, matchedTags: [tagSlug], modified: r.modified })
    }
  }

  // Folder leg: a query matching a FOLDER NAME in the path must return that
  // folder's notes. Without this, searching "dairy" returned only notes whose
  // title/body says "dairy" — never the 100+ journal entries that literally LIVE
  // in `Areas/Journal/Dairy/` (their titles are dates). Users read that as
  // "search can't find my notes". Matching is on path SEGMENTS only, so the
  // query can't accidentally match a mid-path substring of the filename.
  // Multi-word queries also match folders TOKEN-wise: "walnut promo" must
  // surface the walnut/ folder's notes even though no path contains the whole
  // phrase — the folder name + a topic word is how people actually scope a
  // vault search, and requiring the full phrase made this leg silently dead
  // for every multi-word query. Noise bound: a token only counts when it
  // EXACTLY equals a path segment (no prefix/substring), so short common words
  // can't drag whole folders in. Residual tokens that also appear in the
  // note's title/body lift that note above its folder siblings.
  const folderTokens = contentTokens(q)
  const tokenWise = folderTokens.length >= 2
  const folderLikeParams = [
    `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`,
    ...(tokenWise ? folderTokens.map((t) => `%${t.replace(/[\\%_]/g, (m) => '\\' + m)}%`) : []),
  ]
  const folderRows = d
    .prepare(
      `SELECT id, path, title, body, modified FROM notes
       WHERE (${folderLikeParams.map(() => `path LIKE ? ESCAPE '\\'`).join(' OR ')})${excl.sql}
       ORDER BY path
       LIMIT ?`,
    )
    .all(...folderLikeParams, ...excl.params, limit * 4) as RawHit[]
  // Token-wise folder rows are capped: ONE shared word ("reference") can pull
  // a 50-note folder, and at 0.875 apiece those fill the whole return window,
  // crowding out every weaker-band leg (the fuzzy retry most of all). The
  // folders[] row upstream carries the full count; a sample is enough.
  // Whole-query folder matches stay uncapped — those are precise.
  let folderTokenHits = 0
  for (const r of folderRows) {
    const segments = r.path.split('/').slice(0, -1) // folders only, drop the filename
    let band = folderScore(segments, q)
    let matchedQ = q
    let explicitFolder: string | undefined
    if (band == null && tokenWise && folderTokenHits < 12) {
      for (const tok of folderTokens) {
        if (!segments.some((s) => normalizeSeparators(s.toLowerCase()) === tok)) continue
        // Exact-segment token match: base band sits below every whole-query
        // folder band (0.88–0.89) and above headings (0.87). A residual token
        // found in the note upgrades it toward the folder band — in the TITLE
        // slightly above in the body, so "health doctor" ranks the note NAMED
        // doctor above the folder siblings that merely mention one.
        const residuals = folderTokens.filter((t) => t !== tok)
        const titleHay = r.title.toLowerCase()
        const residualInTitle = residuals.some((t) => titleHay.includes(t))
        const bodyHay = r.body.toLowerCase()
        const residualInBody = residuals.some((t) => bodyHay.includes(t))
        band = residualInTitle ? 0.8795 : residualInBody ? 0.879 : 0.875
        matchedQ = tok
        break
      }
    }
    if (band == null && tokenWise && folderTokenHits < 12) {
      // Word-WITHIN-segment match for sentence-named folders ("Should I break
      // variable mortgage/"). Needs ≥2 query tokens hitting words of the SAME
      // segment (inflection-tolerant) — a single shared word is noise. Band
      // sits just under the exact-segment token band.
      for (let i = segments.length - 1; i >= 0; i--) {
        const words = segmentWords(segments[i])
        if (words.length < 2) continue
        const matched = folderTokens.filter((tok) => words.some((w) => tokenMatchesWord(tok, w)))
        if (matched.length < 2) continue
        band = matched.length >= 3 ? 0.874 : 0.873
        explicitFolder = segments.slice(0, i + 1).join('/')
        break
      }
    }
    if (band == null) continue
    if (band < 0.88) folderTokenHits++ // token-wise bands only; see cap above
    addHit({
      id: r.id,
      path: r.path,
      title: r.title,
      body: r.body,
      stringScore: band,
      folderMatch: explicitFolder ?? matchedFolderPath(segments, matchedQ),
      modified: r.modified,
    })
  }

  const ftsQuery = escapeFts(q)
  if (ftsQuery) {
    try {
      // bm25() returns a score where MORE NEGATIVE = more relevant. We pull it
      // (as `rank`) so we can map body relevance into a real band instead of
      // discarding it (the old code ordered by rank then threw the number away).
      const ftsExcl = exclusionSql('n.path', options.excludeFolders ?? [])
      const rows = d
        .prepare(
          `SELECT n.id, n.path, n.title, n.body, n.modified, bm25(notes_fts) AS rank
           FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
           WHERE notes_fts MATCH ?${ftsExcl.sql}
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, ...ftsExcl.params, limit) as RawHit[]
      // Normalize bm25 across this result set: best (most-negative) → 0.85,
      // worst → 0.50, so FTS body matches occupy [0.50, 0.85], always below
      // title bands (≥0.90) and above the LIKE fallback (≤0.25).
      const ranks = rows.map((r) => r.rank ?? 0)
      const best = Math.min(...ranks)
      const worst = Math.max(...ranks)
      const span = worst - best
      for (const r of rows) {
        const nameBand = nameScore(r.title, r.path, q)
        let score: number
        if (nameBand != null && nameBand > 0.3) {
          score = nameBand
        } else {
          const norm = span > 0 ? (worst - (r.rank ?? 0)) / span : 1 // 1=best
          score = 0.5 + 0.35 * norm
        }
        addHit({ id: r.id, path: r.path, title: r.title, body: r.body, stringScore: score, modified: r.modified })
      }
    } catch (err) {
      // Malformed MATCH shouldn't happen after escapeFts, but never throw.
      log.memory.debug('notes-index: FTS match failed, using LIKE only', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Relaxed FTS pass: implicit-AND dies on natural-language queries — "trying
  // to have a baby" demands "to"* AND "a"* AND … in one note, so the leg
  // returns nothing for exactly the phrasings humans type. Re-run with the
  // content tokens only, banded strictly BELOW the full-query FTS best (0.85)
  // so a full-phrase match always outranks its relaxation. A row whose TITLE
  // or FILENAME is one of the content tokens ("my daily rhythm" → RHYTHM.md)
  // gets a fixed 0.855 — combined title+body evidence, still under every
  // tag/heading/folder/title band.
  const relaxedTokens = contentTokens(q)
  const rawTokenCount = q.trim().split(/\s+/).filter(Boolean).length
  if (relaxedTokens.length >= 1 && relaxedTokens.length < rawTokenCount && !hasCjk(q)) {
    try {
      const relaxedMatch = relaxedTokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ')
      const ftsExcl = exclusionSql('n.path', options.excludeFolders ?? [])
      const rows = d
        .prepare(
          `SELECT n.id, n.path, n.title, n.body, n.modified, bm25(notes_fts) AS rank
           FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
           WHERE notes_fts MATCH ?${ftsExcl.sql}
           ORDER BY rank
           LIMIT ?`,
        )
        .all(relaxedMatch, ...ftsExcl.params, limit) as RawHit[]
      const ranks = rows.map((r) => r.rank ?? 0)
      const best = Math.min(...ranks)
      const worst = Math.max(...ranks)
      const span = worst - best
      for (const r of rows) {
        const relaxedQ = relaxedTokens.join(' ')
        const nameBand = nameScore(r.title, r.path, relaxedQ)
        let score: number
        if (nameBand != null && nameBand > 0.3) {
          score = nameBand
        } else if (relaxedTokens.some((tok) => (nameScore(r.title, r.path, tok) ?? 0) >= 0.93)) {
          score = 0.855
        } else {
          const norm = span > 0 ? (worst - (r.rank ?? 0)) / span : 1
          score = 0.5 + 0.33 * norm // [0.50, 0.83] — always under the full-query band
        }
        addHit({ id: r.id, path: r.path, title: r.title, body: r.body, stringScore: score, modified: r.modified })
      }
    } catch (err) {
      log.memory.debug('notes-index: relaxed FTS pass failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Capped LIKE fallback for mid-token substring FTS5 can't match (e.g. 'pollo'
  // in 'Apollo') AND for CJK. FTS5's unicode61 tokenizer treats a CJK run as ONE
  // token, so Chinese/Japanese body text essentially never FTS-matches — for CJK
  // queries this leg is the PRIMARY body path, must always run, and scores at
  // the FTS body floor (0.5) instead of the noise band.
  const cjkQuery = hasCjk(q)
  if (byId.size < limit || cjkQuery) {
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`
    const rows = d
      .prepare(
        `SELECT id, path, title, body, modified FROM notes
         WHERE (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')${excl.sql}
         LIMIT ?`,
      )
      .all(like, like, ...excl.params, limit) as RawHit[]
    for (const r of rows) {
      if (byId.has(r.id)) continue // fallback never outbids a real leg
      const nameBand = nameScore(r.title, r.path, q)
      // Body-only LIKE hit: CJK gets the FTS-floor band (this IS its body leg);
      // Latin word-boundary hits 0.25; raw mid-token substrings 0.10 so noise
      // like "accidental" for query "dental" sorts below every true word match.
      const bodyBand = cjkQuery
        ? 0.5
        : new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(q.toLowerCase())}`, 'u').test(r.body.toLowerCase())
          ? 0.25
          : 0.1
      addHit({ id: r.id, path: r.path, title: r.title, body: r.body, stringScore: nameBand ?? bodyBand, modified: r.modified })
    }
  }

  // Per-token AND-LIKE for CJK/mixed multi-word queries. FTS5's unicode61
  // treats a contiguous CJK run as ONE token (so "律师"* cannot match inside
  // "给律师发邮件") and the whole-phrase LIKE above requires the query's exact
  // spacing — "h1b 律师 邮件" with all three somewhere in one note matched
  // nothing. Every content token must appear (title or body); CJK body floor.
  if (cjkQuery) {
    const likeToks = contentTokens(q).slice(0, 4)
    if (likeToks.length >= 2) {
      const conds = likeToks
        .map(() => `(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`)
        .join(' AND ')
      const params = likeToks.flatMap((t) => {
        const l = `%${likeEscape(t)}%`
        return [l, l]
      })
      const rows = d
        .prepare(`SELECT id, path, title, body, modified FROM notes WHERE ${conds}${excl.sql} LIMIT ?`)
        .all(...params, ...excl.params, limit) as RawHit[]
      for (const r of rows) {
        const nameBand = nameScore(r.title, r.path, q)
        addHit({ id: r.id, path: r.path, title: r.title, body: r.body, stringScore: nameBand ?? 0.5, modified: r.modified })
      }
    }
  }

  // Weak name hits (mid-token title substrings) join only now, after every
  // stronger leg had its chance to claim the same note at a better band.
  for (const w of weakNameHits) {
    if (byId.has(w.id)) continue
    byId.set(w.id, w)
  }

  // Fuzzy retry: when the legs above produced no structural hit, correct
  // unknown query tokens toward the vault's own vocabulary and run the whole
  // search once more ("glucoma" → "glaucoma"; "history" → the note's own typo
  // "histroy"). Guardrails, each one a measured failure: (a) only keyword-ish
  // queries — a stopword-heavy sentence is paraphrase territory and correction
  // just invents junk ("trying to have a baby" once became a folder full of
  // stock notes); (b) "strong" means a structural band (≥0.87) — counting
  // body/partial hits let 60 incidental rows suppress the retry; (c) corrected
  // hits are remapped into [0.60, 0.80] (order-preserving) so a guessed word
  // can never outrank ANY band the literal query earned, semantic included.
  if (!options.noFuzzy && !hasCjk(q)) {
    const allTokenCount = q.trim().split(/\s+/).filter(Boolean).length
    const keywordish = qContentTokens.length * 2 >= allTokenCount
    // ≥0.88 = whole-query title/folder bands only. Token-wise folder rows
    // (0.873-0.8795) are one shared word of scoping evidence — "calory
    // reference" pulling five reference/ rows must not convince us the query
    // needs no spelling help.
    let structuralHits = 0
    for (const h of byId.values()) if (h.stringScore >= 0.88) structuralHits++
    if (keywordish && structuralHits < 3) {
      const corrected = correctQueryTokens(q, d)
      if (corrected && corrected !== q.trim().toLowerCase()) {
        let added = 0
        for (const h of stringSearch(corrected, limit, { ...options, noFuzzy: true })) {
          if (added >= 15) break
          added++
          // addHit max-merges, so a note the literal query only reached weakly
          // (an unsupported partial) still gets its corrected-query band.
          addHit({ ...h, stringScore: 0.6 + 0.2 * Math.min(1, h.stringScore), correctedQuery: corrected })
        }
      }
    }
  }

  // Highest relevance first; EQUAL bands break by recency (newest first).
  // Title-word queries routinely tie a whole family of notes at one band
  // (a street name → 8 notes at .93) — without this, order degrades to SQL
  // row order and the note touched yesterday sorts below years-old ones.
  const out = [...byId.values()]
  out.sort(
    (a, b) => b.stringScore - a.stringScore || (b.modified ?? '').localeCompare(a.modified ?? ''),
  )
  return out.slice(0, Math.max(limit, 1) * 2)
}

/**
 * True number of notes under a folder path (recursive). The search route can't
 * derive this from its own hit list — that list is capped by the query window, so
 * "Journal — 233 notes" would really mean "233 rows I happened to fetch". This
 * counts the index directly so the folder row states a real vault fact.
 */
export function countNotesUnderFolder(folderPath: string): number {
  const d = getNotesIndexDb()
  if (!d) return 0
  const prefix = folderPath.replace(/\/+$/, '') + '/'
  const row = d
    .prepare(`SELECT COUNT(*) AS n FROM notes WHERE path LIKE ? ESCAPE '\\'`)
    .get(prefix.replace(/[\\%_]/g, (m) => '\\' + m) + '%') as { n: number } | undefined
  return row?.n ?? 0
}

export interface BacklinkRow {
  id: string
  path: string
  title: string
  context: string
  status: LinkStatus
  candidates: string | null
}

/** Backlinks: source notes whose edges resolve to this target id. */
export function backlinksForId(dstId: string): BacklinkRow[] {
  const d = getNotesIndexDb()
  if (!d) return []
  return d
    .prepare(
      `SELECT n.id, n.path, n.title, l.context, l.status, l.candidates
       FROM links l JOIN notes n ON n.id = l.src_id
       WHERE l.dst_id = ?
       ORDER BY n.title COLLATE NOCASE`,
    )
    .all(dstId) as BacklinkRow[]
}

/** Ambiguous inbound edges that list this id among their candidates. */
export function ambiguousBacklinksForId(dstId: string): BacklinkRow[] {
  const d = getNotesIndexDb()
  if (!d) return []
  const rows = d
    .prepare(
      `SELECT n.id, n.path, n.title, l.context, l.status, l.candidates
       FROM links l JOIN notes n ON n.id = l.src_id
       WHERE l.status='ambiguous' AND l.candidates IS NOT NULL`,
    )
    .all() as BacklinkRow[]
  return rows.filter((r) => {
    try {
      const cand = JSON.parse(r.candidates || '[]') as string[]
      return cand.includes(dstId)
    } catch {
      return false
    }
  })
}

export interface ForwardLinkRow {
  dst_id: string | null
  dst_name: string
  status: LinkStatus
  path: string | null
  title: string | null
}

export function forwardLinksForId(srcId: string): ForwardLinkRow[] {
  const d = getNotesIndexDb()
  if (!d) return []
  return d
    .prepare(
      `SELECT l.dst_id, l.dst_name, l.status, n.path, n.title
       FROM links l LEFT JOIN notes n ON n.id = l.dst_id
       WHERE l.src_id = ?`,
    )
    .all(srcId) as ForwardLinkRow[]
}

export interface ListRow {
  id: string
  title: string
  path: string
}

export function listNotes(): ListRow[] {
  const d = getNotesIndexDb()
  if (!d) return []
  return d
    .prepare(`SELECT id, title, path FROM notes ORDER BY title COLLATE NOCASE`)
    .all() as ListRow[]
}

export function tagCounts(): Array<{ tag: string; count: number }> {
  const d = getNotesIndexDb()
  if (!d) return []
  return d
    .prepare(
      `SELECT tag, COUNT(*) as count FROM tags GROUP BY tag ORDER BY count DESC, tag ASC`,
    )
    .all() as Array<{ tag: string; count: number }>
}

export interface TagNoteRow {
  id: string
  title: string
  path: string
  body: string
  modified: string
}

export function notesForTag(tag: string): TagNoteRow[] {
  const d = getNotesIndexDb()
  if (!d) return []
  return d
    .prepare(
      `SELECT n.id, n.title, n.path, n.body, n.modified
       FROM tags t JOIN notes n ON n.id = t.note_id
       WHERE t.tag = ?
       ORDER BY n.modified DESC`,
    )
    .all(tag) as TagNoteRow[]
}

/** Paths of notes carrying a tag — used by targeted tag rename. */
export function notePathsForTag(tag: string): string[] {
  const d = getNotesIndexDb()
  if (!d) return []
  const rows = d
    .prepare(
      `SELECT n.path FROM tags t JOIN notes n ON n.id = t.note_id WHERE t.tag = ?`,
    )
    .all(tag) as Array<{ path: string }>
  return rows.map((r) => r.path)
}

export function docCount(): number {
  const d = getNotesIndexDb()
  if (!d) return 0
  const row = d.prepare(`SELECT COUNT(*) as c FROM notes`).get() as { c: number }
  return row.c
}

/** On-disk size of the sidecar (DB + WAL) for observability. */
export function dbSizeBytes(): number {
  let total = 0
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      total += fs.statSync(NOTES_INDEX_PATH + suffix).size
    } catch { /* file may not exist */ }
  }
  return total
}

/** Drop all rows (used by the atomic rebuild before re-walking the vault). */
export function clearAll(): void {
  const d = getNotesIndexDb()
  if (!d) return
  const tx = d.transaction(() => {
    d.prepare(`DELETE FROM links`).run()
    d.prepare(`DELETE FROM tags`).run()
    d.prepare(`DELETE FROM notes`).run()
  })
  tx()
}

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
 * no QMD. The reconciler (notes-indexer.ts) drives writes; routes drive reads.
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
export const NOTES_INDEX_SCHEMA_VERSION = 2

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
    const key = `${r.title.trim().toLowerCase()} ${r.body}`
    const g = groups.get(key) ?? []
    g.push({ id: r.id, path: r.path, created: r.created })
    groups.set(key, g)
  }
  return [...groups.values()].filter((g) => g.length > 1)
}

/** Update just the path of a note (move/rename — links key on id, survive).
 * content_hash is RESET so the follow-up reconcile doesn't hash-skip: the QMD
 * semantic doc is keyed by path, so a move must re-point it (the old path's
 * doc gets deactivated by the ENOENT reconcile). With the hash preserved, the
 * skip made moved notes vanish from semantic search until their next edit. */
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
function headingScore(headings: string, q: string): { band: number; heading: string } | null {
  if (!headings) return null
  const ql = q.toLowerCase().trim()
  if (!ql) return null
  const cjk = hasCjk(ql)
  for (const h of headings.split('\n')) {
    const hl = h.toLowerCase()
    if (cjk ? hl.includes(ql) : new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(ql)}`, 'u').test(hl)) {
      return { band: 0.87, heading: h }
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
  let best: number | null = null
  for (const seg of segments) {
    const s = seg.toLowerCase()
    let band: number | null = null
    if (s === ql) band = 0.89
    else if (s.startsWith(ql)) band = 0.888
    else if (new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(ql)}`, 'u').test(s)) band = 0.885
    // Mid-token folder substring: only meaningful for CJK / long queries (same
    // rationale as titleScore — "sin" inside "Business/" is noise, not a folder).
    else if ((hasCjk(ql) || ql.length >= 5) && s.includes(ql)) band = 0.88
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

/**
 * Exact/substring string search over the structural index.
 * FTS5 first (sublinear token/prefix match), then a capped LIKE fallback for
 * mid-token substrings FTS5 cannot match (e.g. 'pollo' in 'Apollo').
 */
export function stringSearch(q: string, limit: number, options: StringSearchOptions = {}): StringHit[] {
  const d = getNotesIndexDb()
  if (!d) return []
  const seen = new Set<string>()
  const out: StringHit[] = []
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
  const firstTok = q.trim().split(/\s+/)[0] ?? ''
  const firstTokLike = `%${firstTok.replace(/[\\%_]/g, (m) => '\\' + m)}%`
  const titleRows = d
    .prepare(
      `SELECT id, path, title, body, modified FROM notes
       WHERE (title LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')${excl.sql}
       LIMIT ?`,
    )
    .all(titleLike, firstTokLike, titleLike, ...excl.params, limit * 2) as RawHit[]
  // Mid-token substring hits (band ≤0.30) are collected but NOT marked seen and
  // only appended AFTER the strong legs: a later leg (heading/FTS body) may score
  // the same note higher, and they must never crowd word matches out of `out`.
  const weakNameHits: StringHit[] = []
  for (const r of titleRows) {
    const band = nameScore(r.title, r.path, q)
    if (band == null) continue // matched a token but not as a scorable name hit
    if (seen.has(r.id)) continue
    const hit = { id: r.id, path: r.path, title: r.title, body: r.body, stringScore: band, modified: r.modified }
    if (band <= 0.3) {
      weakNameHits.push(hit)
    } else {
      seen.add(r.id)
      out.push(hit)
    }
  }

  // Heading leg: notes whose SECTION HEADINGS contain the query as a word
  // ("## SIN" in a grab-bag "Gov document" note). An author-written label —
  // outranks any body mention (band .87), sits below name/folder bands.
  const headingRows = d
    .prepare(
      `SELECT id, path, title, body, headings, modified FROM notes
       WHERE headings LIKE ? ESCAPE '\\'${excl.sql}
       LIMIT ?`,
    )
    .all(titleLike, ...excl.params, limit * 2) as RawHit[]
  for (const r of headingRows) {
    if (seen.has(r.id)) continue
    const hs = headingScore(r.headings ?? '', q)
    if (!hs) continue
    seen.add(r.id)
    out.push({
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
      if (seen.has(r.id)) continue
      seen.add(r.id)
      out.push({ id: r.id, path: r.path, title: r.title, body: r.body, stringScore: 0.86, matchedTags: [tagSlug], modified: r.modified })
    }
  }

  // Folder leg: a query matching a FOLDER NAME in the path must return that
  // folder's notes. Without this, searching "dairy" returned only notes whose
  // title/body says "dairy" — never the 100+ journal entries that literally LIVE
  // in `Areas/Journal/Dairy/` (their titles are dates). Users read that as
  // "search can't find my notes". Matching is on path SEGMENTS only, so the
  // query can't accidentally match a mid-path substring of the filename.
  const folderRows = d
    .prepare(
      `SELECT id, path, title, body, modified FROM notes
       WHERE path LIKE ? ESCAPE '\\'${excl.sql}
       ORDER BY path
       LIMIT ?`,
    )
    .all(`%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`, ...excl.params, limit * 4) as RawHit[]
  for (const r of folderRows) {
    const segments = r.path.split('/').slice(0, -1) // folders only, drop the filename
    const band = folderScore(segments, q)
    if (band == null) continue
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push({
      id: r.id,
      path: r.path,
      title: r.title,
      body: r.body,
      stringScore: band,
      folderMatch: matchedFolderPath(segments, q),
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
        if (seen.has(r.id)) continue
        const nameBand = nameScore(r.title, r.path, q)
        let score: number
        if (nameBand != null && nameBand > 0.3) {
          score = nameBand
        } else {
          const norm = span > 0 ? (worst - (r.rank ?? 0)) / span : 1 // 1=best
          score = 0.5 + 0.35 * norm
        }
        seen.add(r.id)
        out.push({ id: r.id, path: r.path, title: r.title, body: r.body, stringScore: score, modified: r.modified })
      }
    } catch (err) {
      // Malformed MATCH shouldn't happen after escapeFts, but never throw.
      log.memory.debug('notes-index: FTS match failed, using LIKE only', {
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
  if (out.length < limit || cjkQuery) {
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`
    const rows = d
      .prepare(
        `SELECT id, path, title, body, modified FROM notes
         WHERE (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')${excl.sql}
         LIMIT ?`,
      )
      .all(like, like, ...excl.params, limit) as RawHit[]
    for (const r of rows) {
      if (seen.has(r.id)) continue
      const nameBand = nameScore(r.title, r.path, q)
      // Body-only LIKE hit: CJK gets the FTS-floor band (this IS its body leg);
      // Latin word-boundary hits 0.25; raw mid-token substrings 0.10 so noise
      // like "accidental" for query "dental" sorts below every true word match.
      const bodyBand = cjkQuery
        ? 0.5
        : new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(q.toLowerCase())}`, 'u').test(r.body.toLowerCase())
          ? 0.25
          : 0.1
      seen.add(r.id)
      out.push({ id: r.id, path: r.path, title: r.title, body: r.body, stringScore: nameBand ?? bodyBand, modified: r.modified })
    }
  }

  // Weak name hits (mid-token title substrings) join only now, after every
  // stronger leg had its chance to claim the same note at a better band.
  for (const w of weakNameHits) {
    if (seen.has(w.id)) continue
    seen.add(w.id)
    out.push(w)
  }

  // Highest relevance first; EQUAL bands break by recency (newest first).
  // Title-word queries routinely tie a whole family of notes at one band
  // (a street name → 8 notes at .93) — without this, order degrades to SQL
  // row order and the note touched yesterday sorts below years-old ones.
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

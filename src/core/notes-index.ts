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

/** Bump to force a full rebuild on next open (schema/semantics change). */
export const NOTES_INDEX_SCHEMA_VERSION = 1

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
  size         INTEGER NOT NULL
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
      `INSERT INTO notes (id, path, title, content_hash, body, frontmatter, created, modified, size)
       VALUES (@id, @path, @title, @content_hash, @body, @frontmatter, @created, @modified, @size)
       ON CONFLICT(id) DO UPDATE SET
         path=excluded.path, title=excluded.title, content_hash=excluded.content_hash,
         body=excluded.body, frontmatter=excluded.frontmatter, created=excluded.created,
         modified=excluded.modified, size=excluded.size`,
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
   *   title-exact 1.0 · title-prefix .96 · title-word .93 · title-substr .90
   *   body FTS .50–.85 (by bm25) · LIKE mid-token body-only fallback .10–.25
   */
  stringScore: number
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
  if (t.includes(ql)) return 0.9
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
export function stringSearch(q: string, limit: number): StringHit[] {
  const d = getNotesIndexDb()
  if (!d) return []
  const seen = new Set<string>()
  const out: StringHit[] = []

  type RawHit = { id: string; path: string; title: string; body: string; rank?: number }

  // Title-first leg: pull notes whose TITLE matches, scored by titleScore, BEFORE
  // the FTS body leg. The FTS leg is `ORDER BY bm25 LIMIT n` — ranked purely by
  // body relevance — so a note with a perfect title but a short/sparse body (e.g.
  // a 300-byte "Achievement.md") would get a weak bm25 and be truncated out of the
  // window entirely, never reaching the JS re-rank. Capturing title matches up
  // front guarantees they're in the result set and rank at their title band.
  const titleLike = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`
  const firstTok = q.trim().split(/\s+/)[0] ?? ''
  const titleRows = d
    .prepare(
      `SELECT id, path, title, body FROM notes
       WHERE title LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'
       LIMIT ?`,
    )
    .all(titleLike, `%${firstTok.replace(/[\\%_]/g, (m) => '\\' + m)}%`, limit) as RawHit[]
  for (const r of titleRows) {
    const band = titleScore(r.title, q)
    if (band == null) continue // matched a token but not as a scorable title hit
    if (seen.has(r.id)) continue
    seen.add(r.id)
    out.push({ id: r.id, path: r.path, title: r.title, body: r.body, stringScore: band })
  }

  const ftsQuery = escapeFts(q)
  if (ftsQuery) {
    try {
      // bm25() returns a score where MORE NEGATIVE = more relevant. We pull it
      // (as `rank`) so we can map body relevance into a real band instead of
      // discarding it (the old code ordered by rank then threw the number away).
      const rows = d
        .prepare(
          `SELECT n.id, n.path, n.title, n.body, bm25(notes_fts) AS rank
           FROM notes_fts f JOIN notes n ON n.rowid = f.rowid
           WHERE notes_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, limit) as RawHit[]
      // Normalize bm25 across this result set: best (most-negative) → 0.85,
      // worst → 0.50, so FTS body matches occupy [0.50, 0.85], always below
      // title bands (≥0.90) and above the LIKE fallback (≤0.25).
      const ranks = rows.map((r) => r.rank ?? 0)
      const best = Math.min(...ranks)
      const worst = Math.max(...ranks)
      const span = worst - best
      for (const r of rows) {
        if (seen.has(r.id)) continue
        const titleBand = titleScore(r.title, q)
        let score: number
        if (titleBand != null) {
          score = titleBand
        } else {
          const norm = span > 0 ? (worst - (r.rank ?? 0)) / span : 1 // 1=best
          score = 0.5 + 0.35 * norm
        }
        seen.add(r.id)
        out.push({ id: r.id, path: r.path, title: r.title, body: r.body, stringScore: score })
      }
    } catch (err) {
      // Malformed MATCH shouldn't happen after escapeFts, but never throw.
      log.memory.debug('notes-index: FTS match failed, using LIKE only', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Capped LIKE fallback for mid-token substring FTS5 can't match (e.g. 'pollo'
  // in 'Apollo') AND for CJK (no word tokens). Title matches here still get the
  // title band; body-only mid-token matches get the lowest band so noise like
  // "accidental" for query "dental" sorts below every true word match.
  if (out.length < limit) {
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`
    const rows = d
      .prepare(
        `SELECT id, path, title, body FROM notes
         WHERE (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
         LIMIT ?`,
      )
      .all(like, like, limit) as RawHit[]
    for (const r of rows) {
      if (out.length >= limit) break
      if (seen.has(r.id)) continue
      const titleBand = titleScore(r.title, q)
      // Body-only LIKE hit: lowest band, nudged by whether it's a word-boundary
      // hit (0.25) vs a raw mid-token substring (0.10).
      const bodyBand = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(q.toLowerCase())}`, 'u').test(r.body.toLowerCase())
        ? 0.25
        : 0.1
      seen.add(r.id)
      out.push({ id: r.id, path: r.path, title: r.title, body: r.body, stringScore: titleBand ?? bodyBand })
    }
  }

  // Highest relevance first within the string leg.
  out.sort((a, b) => b.stringScore - a.stringScore)
  return out
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

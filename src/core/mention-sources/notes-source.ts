/**
 * The built-in "@" source for the user's notes vault (registry.ts).
 *
 *   search  ''  → the notes edited most recently
 *           q   → the Notes page's word search (its keystroke path; no meaning rescore)
 *   resolve     → title, vault path, last edit and the note's opening text, plus the op
 *                 that reads the rest (a session on another host cannot open the file)
 *
 * The ref is the vault-relative path, the same key note_read takes.
 */

import { registerMentionSource, type MentionSourceItem } from './registry.js'

const EXCERPT_CHARS = 700

function plain(snippet: string): string {
  return snippet.replace(/<\/?mark>/g, '').replace(/\s+/g, ' ').trim()
}

function folderOf(relPath: string): string {
  const i = relPath.lastIndexOf('/')
  return i > 0 ? relPath.slice(0, i) : ''
}

function day(iso: string | undefined | null): string {
  return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : ''
}

async function recentNotes(limit: number): Promise<MentionSourceItem[]> {
  const { getNotesIndexDb } = await import('../notes-index.js')
  const db = getNotesIndexDb()
  if (!db) return []
  const rows = db.prepare('SELECT title, path, modified FROM notes ORDER BY modified DESC LIMIT ?')
    .all(limit) as Array<{ title: string; path: string; modified: string }>
  return rows.map((r) => ({
    ref: r.path,
    title: r.title || r.path,
    subtitle: [folderOf(r.path), day(r.modified) && `edited ${day(r.modified)}`].filter(Boolean).join(' · '),
    kind: 'note',
  }))
}

let registered = false

/** Register the core sources once per process (idempotent; run.ts calls it). */
export function ensureCoreMentionSources(): void {
  if (registered) return
  registerMentionSource('core', {
    id: 'notes',
    label: 'Notes',
    keyword: 'notes',
    aliases: ['note'],
    kinds: ['note'],
    order: 10,
    minChars: 0,
    timeoutMs: 3000,
    async search(q, { limit }) {
      if (!q) return recentNotes(limit)
      const { performNotesSearch } = await import('../../web/routes/notes-v2.js')
      // `string` is the keystroke path (double-digit ms); the picker looks notes up by name.
      const payload = await performNotesSearch({ q, limit, mode: 'string' })
      return payload.results.map((r) => ({
        ref: r.path,
        title: r.title || r.path,
        subtitle: [folderOf(r.path), plain(r.snippet)].filter(Boolean).join(' · '),
        kind: 'note',
        keys: [r.path.replace(/\.md$/, '').split('/').pop() ?? ''].filter(Boolean),
      }))
    },
    async resolve(ref) {
      const { getNotesIndexDb } = await import('../notes-index.js')
      const db = getNotesIndexDb()
      if (!db) return null
      const row = db.prepare('SELECT title, path, body, modified FROM notes WHERE path = ?')
        .get(ref) as { title: string; path: string; body: string; modified: string } | undefined
      if (!row) return null
      const body = row.body.replace(/^---\n[\s\S]*?\n---\n/, '').trim()
      const points = [...body]
      const excerpt = points.length > EXCERPT_CHARS ? `${points.slice(0, EXCERPT_CHARS).join('')}…` : body
      return [
        `Note "${row.title}" (vault path ${row.path}${day(row.modified) ? `, edited ${day(row.modified)}` : ''}; read all of it with note_read path="${row.path}").`,
        excerpt ? `Opening text: ${excerpt}` : 'The note is empty.',
      ].join(' ')
    },
  })
  registered = true
}

/** Tests: let the next ensureCoreMentionSources() register again (after clearMentionSources). */
export function __resetCoreMentionSources(): void {
  registered = false
}

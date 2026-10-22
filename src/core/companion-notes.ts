/**
 * Notes on the cloud companion (stage 4b and 4c of
 * docs/plan/walnut-companion-unified-replica.md).
 *
 *   reads    the box's notes reads (`/api/v1/notes*` when the Mac does not answer,
 *            `/api/notes-v2` always) take the Mac's copy (companion-host-replica.ts)
 *            once a whole manifest arrived, through the source a host replica reads
 *            (replica/notes-source.ts); search stays the box's own (its copy of the
 *            Mac's index, semantic included)
 *   writes   a note saved, created or deleted here is a `note` record in the
 *            companion's journal (companion-journal.ts journalNote), checked as a
 *            host checks one (offline-host-core.ts notePut: the lock hash against
 *            what the box shows, the size, the note's id from the Mac's copy); the
 *            Mac drains it with the notes merge (offline-merge/notes.ts)
 *   moves    a note moved or renamed here is a `note-move` record (4d,
 *            companion-note-paths.ts), shown in the overlay at its new path
 *   overlay  every copy read shows the pending saves and moves, in the order they
 *            were made (the copy's journal view), and one the Mac took until a copy
 *            round from after its ack stores the Mac's own result (or 10 minutes): the
 *            box never shows a note going back
 *
 * Cloud companion only.
 */

import { log } from '../logging/index.js'
import { COMPANION_REPLICA_HOME, companionCopyHolds, companionHostReplica, setCompanionCopyJournalView } from './companion-host-replica.js'
import { companionJournalBlobBody, companionJournalRecords, journalNote, macDrains } from './companion-journal.js'
import type { JournalRecord } from '../providers/offline-journal-core.js'
import { followerKind } from './server-role.js'

const NOTE_MAX_BYTES = 1024 * 1024
/** A save the Mac took is shown over the copy at most this long without a later round. */
const NOTE_AWAIT_MS = 10 * 60_000

type ShownNote = { body: string; h: string; n: number; m?: Record<string, unknown> }

/** Saves the Mac acked: key -> the Mac's clock at the ack, and the text this box showed. */
const awaited = new Map<string, { ackAt: number; at: number; shown: ShownNote | null }>()
let memo: { sig: string; view: Map<string, ShownNote | null> } | null = null

/** A vault-relative note key (`x.md`), or null for a path that is not one. */
export function noteKeyOf(raw: unknown): string | null {
  let s = typeof raw === 'string' ? raw.trim().split('\\').join('/').replace(/^\.\/+/, '').replace(/^\/+/, '') : ''
  if (!s || /[\u0000-\u001f\u007f]/.test(s)) return null
  if (!/\.md$/i.test(s)) s += '.md'
  if (s.split('/').some((seg) => seg === '..' || seg === '' || seg.startsWith('.'))) return null
  return s.length > 1024 ? null : s
}

function frontmatterId(body: string): string | undefined {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)
  const line = m ? /(?:^|\n)id:[ \t]*([^\r\n]*)/.exec(m[1]) : null
  const v = line ? line[1].trim().replace(/^["']|["']$/g, '') : ''
  return v || undefined
}

function noteTitle(key: string, body: string): string {
  const m = /^#\s+(.+)$/m.exec(body)
  return m ? m[1].trim() : (key.split('/').pop() ?? key).replace(/\.md$/i, '')
}

/** The pending note and note-move records, in the order they were made. */
function pendingNoteRecords(): JournalRecord[] {
  return companionJournalRecords().filter((r) => !r.dropped
    && ((r.kind === 'note' && typeof r.path === 'string') || (r.kind === 'note-move' && typeof r.from === 'string' && typeof r.to === 'string')))
}

/** The note keys a record names (a move names both of its paths). */
export function noteKeysOf(r: JournalRecord): string[] {
  if (r.kind === 'note' && typeof r.path === 'string') return [r.path]
  if (r.kind === 'note-move' && typeof r.from === 'string' && typeof r.to === 'string') return [r.from, r.to]
  return []
}

/** Keys a pending move names: a save there never folds into a record made before that move. */
export function keysPendingMoves(): Set<string> {
  const out = new Set<string>()
  for (const r of pendingNoteRecords()) if (r.kind === 'note-move') for (const k of noteKeysOf(r)) out.add(k)
  return out
}

/** A record as the box shows it, or undefined when its body is gone (the copy answers). */
function shownOf(key: string, r: JournalRecord): ShownNote | null | undefined {
  if (r.mode === 'delete') return null
  const buf = companionJournalBlobBody(r.oursBlob)
  if (!buf) return undefined
  const body = buf.toString('utf8')
  const id = frontmatterId(body) ?? (typeof r.noteId === 'string' ? r.noteId : undefined)
  const replica = companionHostReplica()
  return {
    body, h: replica ? replica.hashOf(body) : '', n: buf.length,
    m: { title: noteTitle(key, body), updatedAt: new Date(typeof r.at === 'number' ? r.at : Date.now()).toISOString(), ...(id ? { id } : {}) },
  }
}

/** The copy's own note at `key` (never the overlay: this runs inside it), as a move carries it. */
function copyShown(key: string, r: JournalRecord): ShownNote | null {
  const replica = companionHostReplica()
  const body = replica ? replica.copyBody(COMPANION_REPLICA_HOME, key) : null
  if (body === null || !replica) return null
  const id = frontmatterId(body) ?? (typeof r.noteId === 'string' ? r.noteId : undefined)
  return {
    body, h: replica.hashOf(body), n: Buffer.byteLength(body),
    m: { title: noteTitle(key, body), updatedAt: new Date(typeof r.at === 'number' ? r.at : Date.now()).toISOString(), ...(id ? { id } : {}) },
  }
}

/** Fold note and note-move records, in order, into a view (a key absent: the copy answers). */
function foldRecords(view: Map<string, ShownNote | null>, recs: JournalRecord[]): void {
  for (const r of recs) {
    if (r.kind === 'note') {
      const shown = shownOf(r.path as string, r)
      if (shown !== undefined) view.set(r.path as string, shown)
      continue
    }
    // A move: the note as this box shows it now goes to its new path, with its id.
    const from = r.from as string
    const to = r.to as string
    const cur = view.has(from) ? view.get(from)! : copyShown(from, r)
    if (cur) {
      const id = (cur.m && typeof cur.m.id === 'string' ? cur.m.id : undefined) ?? (typeof r.noteId === 'string' ? r.noteId : undefined)
      view.set(to, { ...cur, m: { ...(cur.m ?? {}), title: noteTitle(to, cur.body), ...(id ? { id } : {}) } })
    }
    view.set(from, null)
  }
}

/**
 * What every copy read shows over the copy: the saves and moves the Mac took and its copy
 * does not have yet, then the pending ones in the order they were made (a save after a
 * move lands on the path the move made).
 */
function noteOverlay(home: string): Map<string, ShownNote | null> | null {
  if (home !== COMPANION_REPLICA_HOME) return null
  const recs = pendingNoteRecords()
  if (recs.length === 0 && awaited.size === 0) { memo = null; return null }
  const sig = `${recs.map((r) => `${r.seq}:${r.rev ?? 1}`).join(',')}|${[...awaited.entries()].map(([k, a]) => `${k}@${a.ackAt}`).join(',')}`
  if (memo && memo.sig === sig) return memo.view
  const view = new Map<string, ShownNote | null>()
  for (const [key, a] of awaited) view.set(key, a.shown)
  foldRecords(view, recs)
  memo = { sig, view }
  return view
}

/** The note the box shows at `key` (the overlay, else the copy), with its id, or null. */
export function companionNoteAt(key: string): { body: string; id?: string } | null {
  const replica = companionHostReplica()
  if (!replica) return null
  const view = noteOverlay(COMPANION_REPLICA_HOME)
  if (view && view.has(key)) {
    const shown = view.get(key)!
    return shown ? { body: shown.body, ...(shown.m && typeof shown.m.id === 'string' ? { id: shown.m.id } : {}) } : null
  }
  const body = replica.copyBody(COMPANION_REPLICA_HOME, key)
  if (body === null) return null
  const row = replica.noteRow(COMPANION_REPLICA_HOME, key)
  const id = frontmatterId(body) ?? (row && row.m && typeof row.m.id === 'string' ? row.m.id : undefined)
  return { body, ...(id ? { id } : {}) }
}

/** Keys a copy manifest of `asOf` (the Mac's clock) must not replace or remove. */
function notesHeld(home: string, asOf: number): Set<string> {
  const out = new Set<string>(home === COMPANION_REPLICA_HOME ? pendingNoteRecords().flatMap(noteKeysOf) : [])
  for (const [key, a] of [...awaited]) {
    // Let go once a manifest from after the ack stores it, or after 10 minutes.
    if (asOf > a.ackAt || Date.now() - a.at > NOTE_AWAIT_MS) { awaited.delete(key); memo = null } else out.add(key)
  }
  return out
}

/**
 * The Mac acked these note records (its clock `macNow` once it applied them), before
 * the journal lets them go: each key is held, and shown as this box last showed it,
 * until a copy round from after the ack.
 */
export function companionNotesAcked(records: JournalRecord[], macNow: number): void {
  // What these records made (the Mac applied them), over what it took before: never the
  // records still pending, which fold over this again in order.
  const took = records.filter((r) => !r.dropped && noteKeysOf(r).length > 0).sort((a, b) => a.seq - b.seq)
  const view = new Map<string, ShownNote | null>()
  for (const [key, a] of awaited) view.set(key, a.shown)
  foldRecords(view, took)
  for (const r of took) {
    for (const key of noteKeysOf(r)) {
      if (view.has(key)) awaited.set(key, { ackAt: macNow, at: Date.now(), shown: view.get(key)! })
    }
  }
  memo = null
  if (records.length) log.session.info('companion notes: the Mac took the note changes; they show until its copy does', { notes: records.length })
}

let installed = false
/** The installed copy source, told when a write here moves what its list shows. */
let copySource: { forget?(): void } | null = null

/** A note write was kept here: the next tree or list shows it (not the 2-second-old list). */
export function companionNotesChanged(): void {
  memo = null
  copySource?.forget?.()
}

/**
 * Boot on the companion: the copy's journal view, and the notes source the box's
 * notes reads take once the copy is held (never its search).
 */
export async function installCompanionNotes(): Promise<void> {
  if (!companionHostReplica() || installed) return
  installed = true
  setCompanionCopyJournalView({ overlay: noteOverlay, held: notesHeld })
  const notes = await import('../replica/notes-source.js')
  const r = (): NonNullable<ReturnType<typeof companionHostReplica>> => {
    const copy = companionHostReplica()
    if (!copy) throw new Error('not a cloud companion')
    return copy
  }
  const source = notes.createCopyNotesSource({
    async list() {
      const l = r().list(COMPANION_REPLICA_HOME, 'notes')
      return l ? { entries: l.entries, asOf: l.asOf, manifestHash: l.manifestHash } : { entries: [], asOf: null, manifestHash: '' }
    },
    async read(key) { return r().read(COMPANION_REPLICA_HOME, 'notes', key) },
    async readMany(keys) { return r().readMany(COMPANION_REPLICA_HOME, 'notes', keys, 4 * 1024 * 1024) ?? { files: [], missing: keys, more: [] } },
  })
  copySource = source
  notes.installReplicaNotesSource(source, { active: () => companionCopyHolds('notes'), search: false })
}

/** The server stops: its notes reads go back to the disk vault (a test starts another in this process). */
export function uninstallCompanionNotes(): void {
  if (!installed) return
  installed = false
  copySource = null
  setCompanionCopyJournalView(null)
  void import('../replica/notes-source.js').then((n) => n.installReplicaNotesSource(null)).catch(() => {})
}

export type NoteSaveResult =
  | { ok: true; contentHash?: string; noteId?: string; updatedAt: string; seq: number; coalesced?: boolean }
  | { ok: false; code: string; message: string; detail?: Record<string, unknown> }

/** Is the note at `key` in the copy's keep (not under a folder the Mac leaves out, not too big)? */
export function companionNoteKept(key: string): boolean {
  const replica = companionHostReplica()
  if (!replica) return false
  const keep = replica.notesKeep(COMPANION_REPLICA_HOME)
  const lower = key.toLowerCase()
  return !keep.keepExclude.some((f) => { const lf = f.toLowerCase(); return lower === lf || lower.startsWith(`${lf}/`) })
    && !keep.tooBig.some((t) => t.toLowerCase() === lower)
}

/** The box takes note saves into its journal: the copy is held and the Mac drains notes. */
export function companionNotesWritable(): boolean {
  return followerKind() === 'companion' && companionCopyHolds('notes') && macDrains('note')
}

/**
 * Why the box takes no note change now, or null (it does, or this is not the companion).
 * A change the box cannot journal needs the Mac: it is never written to the box's disk,
 * which is no longer the Mac's vault once git sync stops writing it.
 */
export function companionNotesBlocked(): { why: 'kind_not_copied' | 'mac_too_old'; message: string } | null {
  if (followerKind() !== 'companion') return null
  if (!companionCopyHolds('notes')) return { why: 'kind_not_copied', message: 'This box keeps no copy of the notes yet; that needs your Mac.' }
  if (!macDrains('note')) return { why: 'mac_too_old', message: 'Your Mac runs an older Walnut that cannot take a note change later; it needs your Mac.' }
  return null
}

/**
 * The vault-root global notes (`global-notes.md`) as the box shows them (the pending save,
 * else the copy; none yet reads as empty, as on the Mac), `{needs}` when the box cannot
 * tell (no copy yet, or the Mac keeps the file to itself), null on anything but the companion.
 */
export function companionGlobalNotes(): { content: string } | { needs: 'kind_not_copied' | 'note_not_kept' } | null {
  if (followerKind() !== 'companion') return null
  if (!companionCopyHolds('notes')) return { needs: 'kind_not_copied' }
  if (!companionNoteKept(GLOBAL_NOTES_KEY)) return { needs: 'note_not_kept' }
  return { content: companionNoteAt(GLOBAL_NOTES_KEY)?.body ?? '' }
}

/** The global notes file's key in the copy (constants.ts GLOBAL_NOTES_FILE, vault-relative). */
export const GLOBAL_NOTES_KEY = 'global-notes.md'

/**
 * The string leg of the box's notes search (notes-v2.ts performNotesSearch): a keyword
 * search of the Mac's copy as the box shows it, in the string bands the disk index uses
 * (a title with the whole query, a title with every word, then the body by its score), and
 * the folders whose name holds the query with their notes counted in the copy. The box's
 * own notes index is off (the indexer reads a disk the Mac no longer writes). Its semantic
 * leg stays its copy of the Mac's search index. Null on anything but the companion; throws
 * needs-the-Mac while the box keeps no copy of the notes.
 */
export async function companionNotesSearch(q: string, limit: number): Promise<{
  rows: Array<{ id: string; path: string; title: string; snippet: string; stringScore: number }>
  folders: Array<{ path: string; noteCount: number }>
} | null> {
  if (followerKind() !== 'companion') return null
  const { replicaNotesSource } = await import('../replica/notes-source.js')
  const src = companionCopyHolds('notes') ? replicaNotesSource() : null
  const list = src ? companionHostReplica()?.list(COMPANION_REPLICA_HOME, 'notes') : null
  if (!src || !list) {
    const { NeedsLeaderError } = await import('./replication/needs-leader.js')
    throw new NeedsLeaderError('kind_not_copied')
  }
  const phrase = q.trim().toLowerCase()
  const tokens = phrase.split(/\s+/).filter(Boolean)
  const found = await src.search(q, limit)
  const top = found.results.reduce((n, r) => Math.max(n, r.score), 0) || 1
  const rows = found.results.map((r) => {
    const title = r.title.toLowerCase()
    const stringScore = title.includes(phrase) ? 0.92 : tokens.every((t) => title.includes(t)) ? 0.9 : 0.5 + 0.3 * Math.min(1, r.score / top)
    return { id: r.id, path: r.path, title: r.title, snippet: r.snippet, stringScore }
  })
  // Folders whose own name holds the query, each with every note under it (the disk index counts so too).
  const counts = new Map<string, number>()
  for (const e of list.entries) {
    const parts = e.k.split('/')
    for (let i = 1; i < parts.length; i++) {
      if (!parts[i - 1]!.toLowerCase().includes(phrase)) continue
      const dir = parts.slice(0, i).join('/')
      counts.set(dir, (counts.get(dir) ?? 0) + 1)
    }
  }
  const folders = [...counts].map(([p, noteCount]) => ({ path: p, noteCount }))
  folders.sort((a, b) => b.noteCount - a.noteCount || a.path.localeCompare(b.path))
  return { rows, folders: phrase ? folders.slice(0, 5) : [] }
}

/**
 * The newest `limit` notes directly in `folder` whose file name passes `want`, as the box
 * shows them (newest name first), for the diary context (context-sources.ts). `needs-mac`
 * while the box keeps no copy; null on anything but the companion.
 */
export function companionDiaryEntries(folder: string, want: (name: string) => boolean, limit: number): Array<{ name: string; body: string }> | 'needs-mac' | null {
  if (followerKind() !== 'companion') return null
  const list = companionCopyHolds('notes') ? companionHostReplica()?.list(COMPANION_REPLICA_HOME, 'notes') : null
  if (!list) return 'needs-mac'
  const prefix = `${folder}/`
  const names = list.entries.map((e) => e.k).filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && want(k.slice(prefix.length)))
  names.sort().reverse()
  const out: Array<{ name: string; body: string }> = []
  for (const k of names.slice(0, limit)) {
    const note = companionNoteAt(k)
    if (note) out.push({ name: k.slice(prefix.length), body: note.body })
  }
  return out
}

/**
 * One note save, create or delete on the box, checked against what the box shows (the
 * pending save, else the copy) and journaled as a `note` record. `expectedHash` (the
 * notes contentHash) is the lock: a mismatch answers `conflict` with
 * `{serverHash, serverContent}`, as the Mac's routes do, so the editor merges.
 */
export function companionNoteSave(req: { path: unknown; content?: unknown; expectedHash?: unknown; mode?: 'put' | 'delete'; createOnly?: boolean }): NoteSaveResult {
  const replica = companionHostReplica()
  if (!replica || !companionNotesWritable()) return { ok: false, code: 'needs_leader', message: 'This box keeps no copy of the notes yet; that needs your Mac.', detail: { why: 'kind_not_copied' } }
  const key = noteKeyOf(req.path)
  if (!key) return { ok: false, code: 'bad_request', message: 'a note save needs a vault-relative path' }
  const home = COMPANION_REPLICA_HOME
  if (!companionNoteKept(key)) {
    return { ok: false, code: 'needs_leader', message: 'This note is not kept on this box, so it can only be changed on your Mac.', detail: { why: 'note_not_kept' } }
  }
  const view = noteOverlay(home)
  const shown = view && view.has(key) ? view.get(key) : undefined
  const current = shown === undefined ? replica.copyBody(home, key) : shown === null ? null : shown.body
  const currentHash = current === null ? null : replica.hashOf(current)
  const expected = typeof req.expectedHash === 'string' && req.expectedHash ? req.expectedHash : null
  const content = req.mode === 'delete' ? null : req.content
  if (req.mode === 'delete') {
    if (current === null) return { ok: false, code: 'not_found', message: 'Note not found' }
  } else {
    if (typeof content !== 'string') return { ok: false, code: 'bad_request', message: 'content (string) is required' }
    if (Buffer.byteLength(content) > NOTE_MAX_BYTES) return { ok: false, code: 'needs_leader', message: 'Notes over 1 MB can only be changed on your Mac.', detail: { why: 'note_too_large' } }
    if (req.createOnly && current !== null) return { ok: false, code: 'conflict', message: 'Note already exists', detail: { serverHash: currentHash, serverContent: current } }
  }
  if (expected && current !== null && currentHash !== expected) {
    return { ok: false, code: 'conflict', message: 'Note was modified since it was read', detail: { serverHash: currentHash, serverContent: current } }
  }
  const mode = req.mode === 'delete' ? 'delete' as const : current === null ? 'create' as const : 'put' as const
  // The id the Mac's copy shows, never one from a pending save (a body the writer chose);
  // none where the box shows the copy's note gone (deleted or moved away).
  const copied = shown === null ? null : replica.copyBody(home, key)
  const noteId = (copied !== null ? frontmatterId(copied) : undefined) ?? (() => {
    const row = replica.noteRow(home, key)
    return row && row.m && typeof row.m.id === 'string' ? row.m.id : undefined
  })()
  const oursHash = typeof content === 'string' ? replica.hashOf(content) : null
  const saved = journalNote({
    path: key, ...(noteId ? { noteId } : {}), mode, baseHash: currentHash,
    base: current === null ? null : Buffer.from(current, 'utf8'), ours: typeof content === 'string' ? Buffer.from(content, 'utf8') : null, oursHash,
  }, keysPendingMoves().has(key) ? { coalesce: false } : {})
  if (!saved) return { ok: false, code: 'needs_leader', message: 'Your Mac runs an older Walnut that cannot take a note change later; it needs your Mac.', detail: { why: 'mac_too_old' } }
  if (!saved.ok) return { ok: false, code: saved.code, message: saved.message, ...(saved.retryAfterMs !== undefined ? { detail: { retryAfterMs: saved.retryAfterMs } } : {}) }
  // A newer save of an awaited note is pending again: its record shows it.
  awaited.delete(key)
  companionNotesChanged()
  return {
    ok: true, ...(oursHash ? { contentHash: oursHash } : {}), ...(noteId ? { noteId } : {}),
    updatedAt: new Date().toISOString(), seq: saved.seq, ...(saved.coalesced ? { coalesced: true } : {}),
  }
}

/** Tests: forget what the Mac acked. */
export function _resetCompanionNotesForTesting(): void {
  awaited.clear()
  memo = null
  installed = false
  copySource = null
}

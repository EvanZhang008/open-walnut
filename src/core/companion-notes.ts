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
 *   overlay  every copy read shows the pending saves (the copy's journal view), and
 *            a save the Mac took until a copy round from after its ack stores the
 *            Mac's own text (or 10 minutes): the box never shows a note going back
 *
 * Moves, folders, attachments and the box's other note paths are unchanged (its disk,
 * git sync): the copy shows their result once the Mac has it.
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

/** The pending note records, the latest per key. */
function pendingNotes(): Map<string, JournalRecord> {
  const out = new Map<string, JournalRecord>()
  for (const r of companionJournalRecords()) {
    if (r.kind === 'note' && typeof r.path === 'string' && !r.dropped) out.set(r.path, r)
  }
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

/** What every copy read shows over the copy: pending saves, then the ones awaiting a later round. */
function noteOverlay(home: string): Map<string, ShownNote | null> | null {
  if (home !== COMPANION_REPLICA_HOME) return null
  const recs = pendingNotes()
  if (recs.size === 0 && awaited.size === 0) { memo = null; return null }
  const sig = `${[...recs.values()].map((r) => `${r.seq}:${r.rev ?? 1}`).join(',')}|${[...awaited.entries()].map(([k, a]) => `${k}@${a.ackAt}`).join(',')}`
  if (memo && memo.sig === sig) return memo.view
  const view = new Map<string, ShownNote | null>()
  for (const [key, a] of awaited) view.set(key, a.shown)
  for (const [key, r] of recs) {
    const shown = shownOf(key, r)
    if (shown !== undefined) view.set(key, shown)
  }
  memo = { sig, view }
  return view
}

/** Keys a copy manifest of `asOf` (the Mac's clock) must not replace or remove. */
function notesHeld(home: string, asOf: number): Set<string> {
  const out = new Set<string>(home === COMPANION_REPLICA_HOME ? pendingNotes().keys() : [])
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
  for (const r of records) {
    if (r.kind !== 'note' || typeof r.path !== 'string') continue
    const shown = r.dropped ? undefined : shownOf(r.path, r)
    if (shown === undefined) continue
    awaited.set(r.path, { ackAt: macNow, at: Date.now(), shown })
  }
  memo = null
  if (records.length) log.session.info('companion notes: the Mac took the note changes; they show until its copy does', { notes: records.length })
}

let installed = false

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
  notes.installReplicaNotesSource(notes.createCopyNotesSource({
    async list() {
      const l = r().list(COMPANION_REPLICA_HOME, 'notes')
      return l ? { entries: l.entries, asOf: l.asOf, manifestHash: l.manifestHash } : { entries: [], asOf: null, manifestHash: '' }
    },
    async read(key) { return r().read(COMPANION_REPLICA_HOME, 'notes', key) },
    async readMany(keys) { return r().readMany(COMPANION_REPLICA_HOME, 'notes', keys, 4 * 1024 * 1024) ?? { files: [], missing: keys, more: [] } },
  }), { active: () => companionCopyHolds('notes'), search: false })
}

/** The server stops: its notes reads go back to the disk vault (a test starts another in this process). */
export function uninstallCompanionNotes(): void {
  if (!installed) return
  installed = false
  setCompanionCopyJournalView(null)
  void import('../replica/notes-source.js').then((n) => n.installReplicaNotesSource(null)).catch(() => {})
}

export type NoteSaveResult =
  | { ok: true; contentHash?: string; noteId?: string; updatedAt: string; seq: number; coalesced?: boolean }
  | { ok: false; code: string; message: string; detail?: Record<string, unknown> }

/** The box takes note saves into its journal: the copy is held and the Mac drains notes. */
export function companionNotesWritable(): boolean {
  return followerKind() === 'companion' && companionCopyHolds('notes') && macDrains('note')
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
  const keep = replica.notesKeep(home)
  const lower = key.toLowerCase()
  if (keep.keepExclude.some((f) => { const lf = f.toLowerCase(); return lower === lf || lower.startsWith(`${lf}/`) }) || keep.tooBig.some((t) => t.toLowerCase() === lower)) {
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
  // The id the Mac's copy shows, never one from a pending save (a body the writer chose).
  const copied = replica.copyBody(home, key)
  const noteId = (copied !== null ? frontmatterId(copied) : undefined) ?? (() => {
    const row = replica.noteRow(home, key)
    return row && row.m && typeof row.m.id === 'string' ? row.m.id : undefined
  })()
  const oursHash = typeof content === 'string' ? replica.hashOf(content) : null
  const saved = journalNote({
    path: key, ...(noteId ? { noteId } : {}), mode, baseHash: currentHash,
    base: current === null ? null : Buffer.from(current, 'utf8'), ours: typeof content === 'string' ? Buffer.from(content, 'utf8') : null, oursHash,
  })
  if (!saved) return { ok: false, code: 'needs_leader', message: 'Your Mac runs an older Walnut that cannot take a note change later; it needs your Mac.', detail: { why: 'mac_too_old' } }
  if (!saved.ok) return { ok: false, code: saved.code, message: saved.message, ...(saved.retryAfterMs !== undefined ? { detail: { retryAfterMs: saved.retryAfterMs } } : {}) }
  memo = null
  // A newer save of an awaited note is pending again: its record shows it.
  awaited.delete(key)
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
}

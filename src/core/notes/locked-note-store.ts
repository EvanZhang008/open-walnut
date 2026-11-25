/**
 * Locked notes on disk (docs/reference/locked-notes.md): lock a note, read and save its text,
 * remove its lock. The text is sealed with the locked-notes key (core/vault/locked-notes-key.ts,
 * AES-256-GCM with a fresh nonce on every save), so the file never holds it in the clear. Every
 * write replaces the file whole (temp, flush, rename): a cut ciphertext would lose the whole note.
 *
 * Only the person reaches these, through routes/vault-notes-v1.ts (a person's vault session), and
 * an agent only through an approval the person answered in an unlocked window (locked-note-ask.ts).
 * Every ordinary write path refuses a locked note (assertNotLocked in locked-note.ts), so an editor, an agent
 * or an older client can never put plain text, or anything else, over the ciphertext.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { open, seal } from '../vault/crypto.js'
import { findLockedNotesKey, isLockedNotesKeyItem, lockedNotesKeyForNewLock, type LockedNotesKey } from '../vault/locked-notes-key.js'
import { requireOpen, VaultError } from '../vault/state.js'
import { computeContentHash } from '../../utils/file-ops.js'
import { withUserFileLock } from '../../utils/user-file-lock.js'
import { withNoteId } from '../parse-frontmatter.js'
import { replaceAtomically } from '../drawings/vault-files.js'
import { noteRelOf, resolveNotePath } from './note-paths.js'
import { GLOBAL_NOTES_KEY, walnutOwnedNote } from './vault-files.js'
import {
  LockedNoteError, buildLockedNoteText, isLockedNoteText, lockedNoteAad, parseLockedNote, type LockedEnvelope,
} from './locked-note.js'

export { LockedNoteError, assertNotLocked, assertFileNotLocked } from './locked-note.js'

/** A locked note's text, like any note's (notes-v2.ts MAX_NOTE_SIZE). */
export const LOCKED_NOTE_MAX = 2_000_000

const enc = new TextEncoder()
const dec = new TextDecoder()

/** The note's file, or a 400. */
function fileOf(notePath: unknown): string {
  if (typeof notePath !== 'string' || !notePath.trim()) throw new LockedNoteError('path is required', 400, 'bad_path')
  const full = resolveNotePath(notePath)
  if (!full) throw new LockedNoteError('invalid path', 400, 'bad_path')
  return full.endsWith('.md') ? full : `${full}.md`
}

async function readFile(file: string): Promise<{ text: string; updatedAt: string }> {
  try {
    const text = await fsp.readFile(file, 'utf-8')
    const st = await fsp.stat(file)
    return { text, updatedAt: st.mtime.toISOString() }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new LockedNoteError('Note not found', 404, 'not_found')
    throw err
  }
}

function checkHash(text: string, expectedHash: unknown): void {
  if (typeof expectedHash !== 'string' || !expectedHash) return
  const currentHash = computeContentHash(text)
  if (currentHash !== expectedHash) throw new LockedNoteError('The note changed since it was read', 409, 'conflict', { currentHash })
}

function envelopeOf(text: string): { envelope: LockedEnvelope; id?: string } {
  const parsed = parseLockedNote(text)
  if (!parsed) throw new LockedNoteError('This note is not locked', 409, 'not_locked')
  if (!parsed.envelope) throw new LockedNoteError('This note was locked by a newer Walnut: update Walnut to open it', 409, 'locked_newer')
  return { envelope: parsed.envelope, ...(parsed.id ? { id: parsed.id } : {}) }
}

/**
 * The key that opens `envelope` and its plain text. The key the envelope names first; then every
 * other locked-notes key in the vault (an item brought back by an import gets a new id).
 */
async function openEnvelope(envelope: LockedEnvelope): Promise<{ key: LockedNotesKey; text: string }> {
  const tried = new Set<string>()
  const named = await findLockedNotesKey(envelope.key)
  const candidates: LockedNotesKey[] = named ? [named] : []
  const { items } = await requireOpen()
  for (const it of items.values()) {
    if (it.id === envelope.key || !isLockedNotesKeyItem(it)) continue
    const k = await findLockedNotesKey(it.id)
    if (k) candidates.push(k)
  }
  for (const k of candidates) {
    if (tried.has(k.itemId)) continue
    tried.add(k.itemId)
    try {
      const plain = await open(k.key, envelope, lockedNoteAad(envelope.key))
      return { key: k, text: dec.decode(plain) }
    } catch { /* not this key */ }
  }
  throw new LockedNoteError(
    'The key this note was locked with is not in Passwords. It is the item "Walnut locked notes key"; restore it (a backup of Passwords, the Passwords trash) to open the note.',
    410, 'locked_key_missing')
}

async function sealText(key: LockedNotesKey, text: string): Promise<LockedEnvelope> {
  const s = await seal(key.key, enc.encode(text), lockedNoteAad(key.itemId))
  return { key: key.itemId, iv: s.iv, ct: s.ct }
}

async function emitUpdated(file: string, contentHash: string): Promise<void> {
  const { bus, EventNames } = await import('../event-bus.js')
  // source format `notes/{path}` is a shared contract with notes-v2.ts and useNoteContent.ts
  bus.emit(EventNames.NOTES_UPDATED, { source: `notes/${noteRelOf(file).replace(/\.md$/, '')}`, contentHash }, ['web-ui'])
}

export interface LockedNoteRead { content: string; contentHash: string; updatedAt: string; path: string }
export interface LockedNoteWritten { contentHash: string; updatedAt: string; path: string }

/** The plain text of a locked note. `contentHash` is the file's (what a save names). */
export async function readLockedNote(notePath: unknown): Promise<LockedNoteRead> {
  const file = fileOf(notePath)
  const { text, updatedAt } = await withUserFileLock(file, () => readFile(file))
  const { envelope } = envelopeOf(text)
  const opened = await openEnvelope(envelope)
  return { content: opened.text, contentHash: computeContentHash(text), updatedAt, path: noteRelOf(file) }
}

/** Save a locked note's new text, sealed again; it stays locked. */
export async function writeLockedNote(notePath: unknown, content: unknown, expectedHash: unknown): Promise<LockedNoteWritten> {
  if (typeof content !== 'string') throw new LockedNoteError('content (string) is required', 400, 'bad_content')
  if (content.length > LOCKED_NOTE_MAX) throw new LockedNoteError(`Content too large (max ${LOCKED_NOTE_MAX} bytes)`, 413, 'too_large')
  if (isLockedNoteText(content)) throw new LockedNoteError('That text is a locked note\'s file, not its text', 400, 'bad_content')
  const file = fileOf(notePath)
  const out = await withUserFileLock(file, async () => {
    const { text } = await readFile(file)
    const { envelope, id } = envelopeOf(text)
    checkHash(text, expectedHash)
    const { key } = await openEnvelope(envelope)
    // Sealed under the key that opened it, named by that item's id now (an import may have moved it).
    const next = buildLockedNoteText({ ...(id ? { id } : {}), envelope: await sealText(key, content) })
    await replaceAtomically(file, next)
    return next
  })
  const contentHash = computeContentHash(out)
  await emitUpdated(file, contentHash)
  return { contentHash, updatedAt: (await fsp.stat(file)).mtime.toISOString(), path: noteRelOf(file) }
}

/** Lock a note: its text goes into the ciphertext, the file keeps only its id, the mark and the stub. */
export async function lockNote(notePath: unknown, expectedHash: unknown): Promise<LockedNoteWritten> {
  const file = fileOf(notePath)
  const rel = noteRelOf(file)
  if (path.basename(file) === GLOBAL_NOTES_KEY || walnutOwnedNote(rel)) {
    throw new LockedNoteError('Walnut writes this note itself, so it cannot be locked', 400, 'not_lockable')
  }
  // The key first (it may make the item): the file lock is never held across a vault write.
  const key = await lockedNotesKeyForNewLock()
  const out = await withUserFileLock(file, async () => {
    const { text } = await readFile(file)
    if (isLockedNoteText(text)) throw new LockedNoteError('This note is already locked', 409, 'already_locked')
    checkHash(text, expectedHash)
    if (text.length > LOCKED_NOTE_MAX) throw new LockedNoteError(`Note too large to lock (max ${LOCKED_NOTE_MAX} bytes)`, 413, 'too_large')
    // The id goes into the text too, so removing the lock gives back the note with the same id.
    const stamped = withNoteId(text, text)
    const next = buildLockedNoteText({ id: stamped.id, envelope: await sealText(key, stamped.content) })
    // The new file must open before it replaces the plain one: a wrong key here would lose the note.
    const check = await openEnvelope(envelopeOf(next).envelope)
    if (check.text !== stamped.content) throw new LockedNoteError('The locked copy did not read back', 500, 'lock_failed')
    await replaceAtomically(file, next)
    return next
  })
  const contentHash = computeContentHash(out)
  await emitUpdated(file, contentHash)
  return { contentHash, updatedAt: (await fsp.stat(file)).mtime.toISOString(), path: rel }
}

/** Remove a note's lock: its text goes back into the file in the clear. */
export async function removeNoteLock(notePath: unknown, expectedHash: unknown): Promise<LockedNoteWritten & { content: string }> {
  const file = fileOf(notePath)
  const plain = await withUserFileLock(file, async () => {
    const { text } = await readFile(file)
    const { envelope } = envelopeOf(text)
    checkHash(text, expectedHash)
    const { text: inner } = await openEnvelope(envelope)
    await replaceAtomically(file, inner)
    return inner
  })
  const contentHash = computeContentHash(plain)
  await emitUpdated(file, contentHash)
  return { content: plain, contentHash, updatedAt: (await fsp.stat(file)).mtime.toISOString(), path: noteRelOf(file) }
}

/** A VaultError or LockedNoteError as the route's answer. */
export function lockedNoteErrorBody(err: unknown): { status: number; body: Record<string, unknown> } | null {
  if (err instanceof LockedNoteError) return { status: err.status, body: { error: err.message, code: err.code, ...err.extra } }
  if (err instanceof VaultError) return { status: err.status, body: { error: err.message, code: err.code } }
  return null
}

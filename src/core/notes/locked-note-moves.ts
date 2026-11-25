/**
 * Where a locked or hidden note may go (docs/reference/locked-notes.md). Only the person moves,
 * renames or deletes one; no copy of a locked note's file is ever made (a copy would be a second
 * locked note nobody could edit), and only the person copies a hidden one; and neither ever goes to
 * a note Walnut writes itself (vault-files.ts walnutWritesNote), whose writers replace or delete
 * that file as theirs.
 *
 * The one rule for every way a vault file moves, is copied or goes: the notes routes (moveNote,
 * deleteNotesFolder in web/routes/notes-v2.ts, the note deletes there and in api-v1.ts) and the
 * Files panel (web/routes/file-ops.ts), for a note or a whole folder. Each throws a LockedNoteError
 * the caller maps to its own error shape. "Protected" here is the fail-closed mark test
 * (noteProtection): a file whose envelope an outside editor bent is still the person's.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { HIDDEN_NOTE_AGENT_TEXT, LOCKED_NOTE_AGENT_TEXT, LockedNoteError, noteProtection, type NoteProtection } from './locked-note.js'
import { notesRoot } from './note-paths.js'
import { walnutWritesNote } from './vault-files.js'

/** The mark sits in the first frontmatter block: a head this long always holds it. */
const HEAD_BYTES = 64 * 1024

/** Which mark the regular file at `abs` carries (only its head is read), or null. */
export async function fileProtection(abs: string): Promise<NoteProtection | null> {
  let fh: fsp.FileHandle
  try { fh = await fsp.open(abs, 'r') } catch { return null }
  try {
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
    return noteProtection(buf.subarray(0, bytesRead).toString('utf-8'))
  } catch {
    return null
  } finally {
    await fh.close().catch(() => {})
  }
}

/** Fail-closed, for every writer: the file carries the lock mark or the hidden mark. */
export async function fileLooksLocked(abs: string): Promise<boolean> {
  return (await fileProtection(abs)) !== null
}

/** `p` with symlinks resolved in its folders (never the last part), through the nearest one that exists. */
async function realParent(p: string): Promise<string> {
  const abs = path.resolve(p)
  const tail: string[] = [path.basename(abs)]
  for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
    try {
      return path.join(await fsp.realpath(dir), ...tail.reverse())
    } catch {
      if (path.dirname(dir) === dir) return abs
      tail.push(path.basename(dir))
    }
  }
}

async function realRoot(): Promise<string> {
  const root = path.resolve(notesRoot())
  try { return await fsp.realpath(root) } catch { return root }
}

const within = (child: string, root: string): boolean => {
  const rel = path.relative(root, child)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** The vault-relative path (forward slashes) of a real absolute path, or null outside the vault. */
function relIn(root: string, real: string): string | null {
  return within(real, root) ? path.relative(root, real).split(path.sep).join('/') : null
}

/** Every regular `.md` file at `start`: the file itself, or each one under the folder (links not followed). */
async function noteFilesAt(start: string): Promise<string[]> {
  let st
  try { st = await fsp.lstat(start) } catch { return [] }
  if (st.isFile()) return /\.md$/i.test(start) ? [start] : []
  if (!st.isDirectory()) return []
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(full)
    }
  }
  await walk(start)
  return out
}

interface Reach {
  /** The real path the change starts from. */
  from: string
  root: string
  /** The vault's notes it reaches: under `from`, or the whole vault when `from` holds it. */
  files: string[]
}

/** What a change of `abs` (a note or a folder, anywhere) reaches of the vault. */
async function reachOf(abs: string): Promise<Reach> {
  const [from, root] = await Promise.all([realParent(abs), realRoot()])
  const start = within(from, root) ? from : within(root, from) ? root : null
  return { from, root, files: start ? await noteFilesAt(start) : [] }
}

/** The first of `files` that is a locked or hidden note (and which), or null. `skip` passes over a kind. */
async function firstProtected(files: string[], skip?: NoteProtection): Promise<{ file: string; kind: NoteProtection } | null> {
  for (const file of files) {
    const kind = await fileProtection(file)
    if (kind && kind !== skip) return { file, kind }
  }
  return null
}

/** The first of `files` that is a locked or hidden note, or null. */
export async function firstLockedNote(files: string[]): Promise<string | null> {
  return (await firstProtected(files))?.file ?? null
}

const relName = (root: string, abs: string): string => relIn(root, abs) ?? abs

function agentRefusal(rel: string, what: string, kind: NoteProtection): LockedNoteError {
  return kind === 'locked'
    ? new LockedNoteError(`${rel} is a locked note: only its owner ${what} it, in Walnut. ${LOCKED_NOTE_AGENT_TEXT}`, 423, 'note_locked')
    : new LockedNoteError(`${rel} is a hidden note: only its owner ${what} it, in Walnut. ${HIDDEN_NOTE_AGENT_TEXT}`, 423, 'note_hidden')
}

/**
 * A move or rename of `from` (a note or a folder) to `to`: refused for anyone but the person when
 * it carries a locked or hidden note (423 `note_locked` / `note_hidden`), and for everyone when one
 * it carries would land on a note Walnut writes itself (400 `not_lockable`, as Lock and Hide refuse
 * that path).
 */
export async function assertLockedNoteMove(from: string, to: string, opts: { person: boolean }): Promise<void> {
  const reach = await reachOf(from)
  if (reach.files.length === 0) return
  if (!opts.person) {
    const hit = await firstProtected(reach.files)
    if (hit) throw agentRefusal(relName(reach.root, hit.file), 'moves or renames', hit.kind)
    return
  }
  await assertNotOntoWalnutNote(reach, to, 'Move')
}

/**
 * The person's move or copy: refused (400 `not_lockable`) when a locked or hidden note it carries
 * would land on a note Walnut writes itself, which Walnut reads raw and writes over (as Lock and
 * Hide refuse that path). Only the notes that would land on one are read.
 */
async function assertNotOntoWalnutNote(reach: Reach, to: string, verb: 'Move' | 'Copy'): Promise<void> {
  const dest = await realParent(to)
  const destRel = (f: string): string | null => relIn(reach.root, path.join(dest, path.relative(reach.from, f)))
  const owned = (f: string): boolean => { const r = destRel(f); return r !== null && walnutWritesNote(r) }
  const hit = await firstProtected(reach.files.filter(owned))
  if (!hit) return
  throw new LockedNoteError(
    `${relName(reach.root, hit.file)} is a ${hit.kind} note, and ${destRel(hit.file)} is a note Walnut writes itself, so a ${hit.kind} note cannot go there. ${verb} it somewhere else.`,
    400, 'not_lockable')
}

/** A delete of `abs` (a note or a folder): refused for anyone but the person when it holds a locked or hidden note. */
export async function assertLockedNoteDelete(abs: string, opts: { person: boolean }): Promise<void> {
  if (opts.person) return
  const reach = await reachOf(abs)
  const hit = await firstProtected(reach.files)
  if (hit) throw agentRefusal(relName(reach.root, hit.file), 'deletes', hit.kind)
}

/**
 * A copy of `abs` (a note or a folder) to `to`: refused for everyone when it holds a locked note,
 * for anyone but the person when it holds a hidden one (a copy is a read of its whole text), and
 * for the person when a hidden one would land on a note Walnut writes itself.
 */
export async function assertNoLockedNoteCopy(abs: string, opts: { person?: boolean; to?: string } = {}): Promise<void> {
  const reach = await reachOf(abs)
  const hit = await firstProtected(reach.files, opts.person ? 'hidden' : undefined)
  if (!hit) { if (opts.person && opts.to && reach.files.length) await assertNotOntoWalnutNote(reach, opts.to, 'Copy'); return }
  if (hit.kind === 'hidden') throw agentRefusal(relName(reach.root, hit.file), 'copies', 'hidden')
  throw new LockedNoteError(
    `${relName(reach.root, hit.file)} is a locked note, and a locked note's file is never copied: the copy could never be opened or edited. To copy its text, press Show on it in Walnut.`,
    423, 'note_locked')
}

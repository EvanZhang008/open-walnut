/**
 * A node's memory folder: the on-demand half of its prompt (2026-11-12, the user: "u can
 * create some kind memory folder u can add it there, all walnut CEO / VP need to do the
 * similar").
 *
 *   WALNUT_HOME/agent-memory/<taskId>/   one per task: Main, every VP and lead, any task
 *   WALNUT_HOME/agent-memory/_shared/    what is the same for everyone (the skills index and
 *                                        standing memory the persona moved), and a taskless session's
 *
 * Two kinds of file, one folder, one op pair (agent_memory_read / agent_memory_write with `file`):
 * - Walnut's: `<block>.md`, the rest of an always-loaded block that did not fit its cap
 *   (prompt-blocks.ts). Rewritten at each session start from the current text, only when it
 *   changed, and removed when the block fits again. A node never writes one.
 * - The node's own notes: any other `<name>.md`, for detail too long for its MEMORY.md
 *   (agent-memory.ts, which stays the short index and is read back after every compaction).
 *
 * Why not agentMemoryDir (constants.ts): that is per console AGENT (Personal AI, Mentor, ...), with
 * the global MEMORY.md / USER.md inside; a node is a task, so its folder is keyed like its own
 * MEMORY.md, Board and skills (agent-skills/<taskId>.json). A read looks in the task's folder, then
 * in _shared. Only the primary writes (the companion and replicas read nothing here: the folder is
 * the Mac's, like Threads and agent skills).
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { isCompanion } from '../server-role.js'
import { randomUUID } from 'node:crypto'
import { withFileLock } from '../../utils/file-lock.js'
import { byteLength, promptBlock, walnutFileKey, walnutFolderBlock, type PromptOverflow, type PromptPart } from './prompt-blocks.js'

export const SHARED_FOLDER = '_shared'
export const MEMORY_FILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}\.md$/
/** A node's own note files: a few long documents, not a second MEMORY.md per topic. */
export const OWN_NOTE_FILES_MAX = 20
export const OWN_NOTE_MAX_CHARS = 20_000

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export class MemoryFolderError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message) }
}

export function memoryFolderOf(taskId?: string | null): string {
  const key = taskId && taskId.trim() ? taskId.trim() : SHARED_FOLDER
  if (key !== SHARED_FOLDER && !TASK_ID_RE.test(key)) throw new MemoryFolderError('bad_request', 400, `Invalid task id: ${key}`)
  return path.join(WALNUT_HOME, 'agent-memory', key)
}

function checkName(name: string): string {
  const n = name.trim()
  if (!MEMORY_FILE_NAME_RE.test(n)) {
    throw new MemoryFolderError('bad_request', 400, `"${name}" is not a memory file name: lowercase letters, digits, dots and dashes, ending in .md`)
  }
  return n
}

async function writeIfChanged(file: string, text: string): Promise<boolean> {
  const now = await fsp.readFile(file, 'utf-8').catch(() => null)
  if (now === text) return false
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomUUID()}.tmp`
  await fsp.writeFile(tmp, text, 'utf-8')
  await fsp.rename(tmp, file)
  return true
}

/** A moved block as its folder file holds it: a heading, one line of what it is, the text. */
export function overflowFileText(o: PromptOverflow): string {
  return `# ${o.title}\n\n(Walnut keeps this file: the part of "${o.title}" that did not fit in your always-loaded `
    + 'prompt. Your prompt holds the head of it; this is the rest, current as of your session\'s start. It has the '
    + `same standing as the rest of your instructions.)\n\n${o.text.trim()}\n`
}

/**
 * A Walnut file no pointer of a new prompt names is kept this long after its last write: a running
 * session still holds the pointer of the prompt it was spawned with (a deploy that changes a moved
 * block gives the new prompt another file name), and the shared folder holds every agent's and
 * variant's persona files side by side. A file still pointed to is touched at each write.
 */
export const WALNUT_FILE_KEEP_MS = 7 * 24 * 3_600_000

/**
 * Write what one half of a prompt moved, and remove that half's Walnut files no pointer has named
 * for WALNUT_FILE_KEEP_MS. Best effort per file: never throws (the prompt's pointer still says what moved).
 */
export async function writeOverflows(taskId: string | null | undefined, part: PromptPart, overflows: readonly PromptOverflow[]): Promise<void> {
  if (isCompanion()) return
  const who = taskId || SHARED_FOLDER
  let dir: string
  try { dir = memoryFolderOf(taskId) } catch { return }
  const keep = new Set(overflows.map((o) => o.file))
  for (const o of overflows) {
    try {
      const file = path.join(dir, o.file)
      if (await writeIfChanged(file, overflowFileText(o))) {
        log.session.info('prompt block over its cap: rest moved to the memory folder', { taskId: who, block: o.id, file: o.file, movedChars: o.chars })
      } else {
        // Still pointed to: keep it out of the sweep.
        const now = new Date()
        await fsp.utimes(file, now, now).catch(() => {})
      }
    } catch (err) {
      log.session.warn('memory folder: writing a moved block failed', { taskId: who, block: o.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const names = await fsp.readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    const id = walnutFolderBlock(name)
    if (!id || keep.has(name) || promptBlock(id).part !== part) continue
    try {
      const st = await fsp.stat(path.join(dir, name))
      if (Date.now() - st.mtimeMs < WALNUT_FILE_KEEP_MS) continue
      await fsp.rm(path.join(dir, name), { force: true })
    } catch { /* the next start tries again */ }
  }
}

export interface MemoryFileInfo { name: string; bytes: number; at: string; walnut: boolean; shared: boolean }

async function listDir(dir: string, shared: boolean): Promise<MemoryFileInfo[]> {
  const names = await fsp.readdir(dir).catch(() => [] as string[])
  const out: MemoryFileInfo[] = []
  for (const name of names.filter((n) => MEMORY_FILE_NAME_RE.test(n)).sort()) {
    const st = await fsp.stat(path.join(dir, name)).catch(() => null)
    if (st?.isFile()) out.push({ name, bytes: st.size, at: st.mtime.toISOString(), walnut: !!walnutFolderBlock(name), shared })
  }
  return out
}

/** A folder key memoryFolderOf takes ('' for one it refuses: a placeholder, a path). */
const ownFolder = (taskId: string | null | undefined): string => {
  try { return taskId ? memoryFolderOf(taskId) : '' } catch { return '' }
}

/**
 * The task's files, then the shared ones it does not shadow. An id that is no task id (a routine's
 * placeholder, 2026-11-12 review: it threw here and cost every routine run its session context)
 * has no folder of its own: the shared files alone.
 */
export async function listMemoryFiles(taskId?: string | null): Promise<MemoryFileInfo[]> {
  if (isCompanion()) return []
  const dir = ownFolder(taskId)
  const own = dir ? await listDir(dir, false) : []
  const names = new Set(own.map((f) => f.name))
  const shared = (await listDir(memoryFolderOf(null), true)).filter((f) => !names.has(f.name))
  return [...own, ...shared]
}

export interface MemoryFileRead {
  name: string
  text: string
  at: string
  walnut: boolean
  shared: boolean
  /** A pointer named an older version of this block, which is gone: this is the block's current file. */
  replaces?: string
}

/**
 * A file of the task's folder, else the shared one. On a miss, and only for a block of the session
 * context, `regenerate` gives what the task's prompt moves now (its session context composed from
 * a spawn's inputs), and the file is written from it. A pointer to a version of a block that is
 * gone (its text changed and the old file was swept) is answered with the current file of the same
 * block and scope (a persona's console agent), saying so, never with not found.
 */
export async function readMemoryFile(
  taskId: string | null | undefined, name: string, opts: { regenerate?: () => Promise<readonly PromptOverflow[]> } = {},
): Promise<MemoryFileRead> {
  const n = checkName(name)
  const found = await readFrom(taskId, n)
  if (found) return found
  const key = walnutFileKey(n)
  if (!key) throw notFound(n)
  // Only a block of the session context is the task's to write again: a persona's file is the
  // shared folder's, written by the persona's own builder.
  const own = taskId && !isCompanion() && promptBlock(key.block).part === 'context' ? ownFolder(taskId) : ''
  const current = own && opts.regenerate ? await opts.regenerate().catch(() => [] as readonly PromptOverflow[]) : []
  const exact = current.find((x) => x.file === n)
  if (exact) {
    await writeIfChanged(path.join(own, n), overflowFileText(exact)).catch(() => false)
    const read = await readFrom(taskId, n)
    if (read) return read
  }
  // Another version of the same block and scope: the one the current prompt names, else the newest on disk.
  const now = current.find((x) => sameKey(x.file, key))
  if (now) {
    await writeIfChanged(path.join(own, now.file), overflowFileText(now)).catch(() => false)
    const read = await readFrom(taskId, now.file)
    if (read) return { ...read, replaces: n }
  }
  for (const f of (await listMemoryFiles(taskId)).filter((x) => sameKey(x.name, key)).sort((a, b) => b.at.localeCompare(a.at))) {
    const read = await readFrom(taskId, f.name)
    if (read) return { ...read, replaces: n }
  }
  throw notFound(n)
}

const sameKey = (name: string, key: { block: string; scope: string }): boolean => {
  const k = walnutFileKey(name)
  return !!k && k.block === key.block && k.scope === key.scope
}

function notFound(n: string): MemoryFolderError {
  return new MemoryFolderError('not_found', 404, isCompanion()
    ? `No file "${n}" here: memory folders are kept on the main computer, so read it while that computer is on.`
    : `No file "${n}" in this memory folder. agent_memory_read with no file lists what there is; a file Walnut `
      + 'moved there is written when a session of the task starts, and replaced when the moved text changes.')
}

async function readFrom(taskId: string | null | undefined, n: string): Promise<MemoryFileRead | null> {
  const own = ownFolder(taskId)
  const dirs: Array<[string, boolean]> = [...(own ? [[own, false] as [string, boolean]] : []), [memoryFolderOf(null), true]]
  for (const [dir, shared] of dirs) {
    const file = path.join(dir, n)
    const text = await fsp.readFile(file, 'utf-8').catch(() => null)
    if (text === null) continue
    const st = await fsp.stat(file).catch(() => null)
    return { name: n, text, at: st?.mtime.toISOString() ?? '', walnut: !!walnutFolderBlock(n), shared }
  }
  return null
}

/** Remove a task's memory folder (the task was deleted). Never the shared folder. */
export async function removeMemoryFolder(taskId: string): Promise<void> {
  if (isCompanion() || !taskId.trim()) return
  let dir: string
  try { dir = memoryFolderOf(taskId) } catch { return }
  if (path.basename(dir) === SHARED_FOLDER) return
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(`${dir}.notes.lock`, { recursive: true, force: true }).catch(() => {})
}

/** A node's own note: written whole; `content: ""` removes it. Walnut's file names are refused. */
export async function writeOwnNote(taskId: string, name: string, content: string): Promise<{ name: string; bytes: number; removed: boolean; count: number }> {
  if (isCompanion()) throw new MemoryFolderError('not_supported_cloud', 501, 'Memory folder files are written on the primary box')
  const n = checkName(name)
  if (walnutFolderBlock(n)) {
    throw new MemoryFolderError('walnut_file', 409, `"${n}" is Walnut's own file (the rest of a prompt section); pick another name for your note.`)
  }
  if (content.length > OWN_NOTE_MAX_CHARS) {
    throw new MemoryFolderError('note_too_long', 413, `This note would be ${content.length} characters, over the ${OWN_NOTE_MAX_CHARS} limit. Nothing was written: split it or write it shorter.`)
  }
  const dir = memoryFolderOf(taskId)
  const file = path.join(dir, n)
  // Under the folder's lock: two writes at once must not both pass the count and leave one note too many.
  await fsp.mkdir(path.dirname(dir), { recursive: true })
  return withFileLock(`${dir}.notes`, async () => {
    if (!content.trim()) {
      await fsp.rm(file, { force: true })
      return { name: n, bytes: 0, removed: true, count: (await listDir(dir, false)).filter((f) => !f.walnut).length }
    }
    const mine = (await listDir(dir, false)).filter((f) => !f.walnut)
    if (!mine.some((f) => f.name === n) && mine.length >= OWN_NOTE_FILES_MAX) {
      throw new MemoryFolderError('too_many_notes', 409, `This folder already holds ${OWN_NOTE_FILES_MAX} notes of yours: merge or remove one (content "") first.`)
    }
    await writeIfChanged(file, content.endsWith('\n') ? content : `${content}\n`)
    return { name: n, bytes: byteLength(content), removed: false, count: mine.length + (mine.some((f) => f.name === n) ? 0 : 1) }
  })
}

/** The always-loaded index of a node's own notes ('' with none): names and sizes only, read on demand. */
export function ownNotesIndexLine(files: readonly MemoryFileInfo[]): string {
  const mine = files.filter((f) => !f.walnut && !f.shared)
  if (!mine.length) return ''
  const list = mine.slice(0, 12).map((f) => `${f.name} (${f.bytes.toLocaleString('en-US')} B)`).join(', ')
  const more = mine.length > 12 ? `, and ${mine.length - 12} more` : ''
  return `Your memory folder holds your own notes: ${list}${more}. Read one with agent_memory_read {"file":"<name>"} when you need it.\n\n`
}

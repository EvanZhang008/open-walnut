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
import { byteLength, promptBlock, walnutFolderBlock, type PromptOverflow, type PromptPart } from './prompt-blocks.js'

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

/** A shared file a persona moved is kept this long after its last write: another agent or variant may still point to it. */
const SHARED_KEEP_MS = 7 * 24 * 3_600_000

/**
 * Write what one half of a prompt moved, and remove that half's Walnut files no pointer names any
 * more. In a task's folder only its own session context writes, so a file of that part not written
 * now is stale at once; the shared folder holds every agent's and variant's persona files side by
 * side (each name carries its text's hash), so one there goes only after a week unwritten.
 * Best effort per file: never throws (the prompt's pointer still says what moved).
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
        log.session.info('prompt block over its cap: rest moved to the memory folder', { taskId: who, block: o.id, file: o.file, movedBytes: o.bytes })
      } else if (!taskId) {
        // Still pointed to: keep it out of the week's sweep.
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
      if (!taskId) {
        const st = await fsp.stat(path.join(dir, name))
        if (Date.now() - st.mtimeMs < SHARED_KEEP_MS) continue
      }
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

/** The task's files, then the shared ones it does not shadow. */
export async function listMemoryFiles(taskId?: string | null): Promise<MemoryFileInfo[]> {
  if (isCompanion()) return []
  const own = taskId ? await listDir(memoryFolderOf(taskId), false) : []
  const names = new Set(own.map((f) => f.name))
  const shared = (await listDir(memoryFolderOf(null), true)).filter((f) => !names.has(f.name))
  return [...own, ...shared]
}

/**
 * `regenerate`: what the task's prompt moves now, for a Walnut file not written yet. A pointer can
 * reach a session before its file does (the instruction notice tells a running session the new
 * pointer, a compaction hook restates it), so a miss writes it from the current text.
 */
export async function readMemoryFile(
  taskId: string | null | undefined, name: string, opts: { regenerate?: () => Promise<readonly PromptOverflow[]> } = {},
): Promise<{ name: string; text: string; at: string; walnut: boolean; shared: boolean }> {
  const n = checkName(name)
  if (taskId && opts.regenerate && walnutFolderBlock(n) && !isCompanion()) {
    const file = path.join(memoryFolderOf(taskId), n)
    if (!(await fsp.stat(file).catch(() => null))) {
      const o = (await opts.regenerate().catch(() => [])).find((x) => x.file === n)
      if (o) await writeIfChanged(file, overflowFileText(o)).catch(() => false)
    }
  }
  const dirs: Array<[string, boolean]> = [...(taskId ? [[memoryFolderOf(taskId), false] as [string, boolean]] : []), [memoryFolderOf(null), true]]
  for (const [dir, shared] of dirs) {
    const file = path.join(dir, n)
    const text = await fsp.readFile(file, 'utf-8').catch(() => null)
    if (text === null) continue
    const st = await fsp.stat(file).catch(() => null)
    return { name: n, text, at: st?.mtime.toISOString() ?? '', walnut: !!walnutFolderBlock(n), shared }
  }
  throw new MemoryFolderError('not_found', 404, isCompanion()
    ? `No file "${n}" here: memory folders are kept on the main computer, so read it while that computer is on.`
    : `No file "${n}" in this memory folder. agent_memory_read with no file lists what there is; a file Walnut `
      + 'moved there is written when a session of the task starts, and replaced when the moved text changes.')
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
}

/** The always-loaded index of a node's own notes ('' with none): names and sizes only, read on demand. */
export function ownNotesIndexLine(files: readonly MemoryFileInfo[]): string {
  const mine = files.filter((f) => !f.walnut && !f.shared)
  if (!mine.length) return ''
  const list = mine.slice(0, 12).map((f) => `${f.name} (${f.bytes.toLocaleString('en-US')} B)`).join(', ')
  const more = mine.length > 12 ? `, and ${mine.length - 12} more` : ''
  return `Your memory folder holds your own notes: ${list}${more}. Read one with agent_memory_read {"file":"<name>"} when you need it.\n\n`
}

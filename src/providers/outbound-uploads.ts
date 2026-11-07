/**
 * Files a message names that live only on the machine Walnut runs on, shipped
 * to the remote host a session runs on before the message goes there.
 *
 * Two kinds of Walnut's own files can be named by a message to a session on
 * another machine:
 *   - an attachment uploaded before the session existed (the first message of a
 *     new session: `PUT /api/v1/uploads/:uploadId` lands it here as
 *     `<state>/uploads/up-<id>/<name>`), under the `[Files attached …]` header;
 *   - an oversized paste spilled to disk (`POST /api/pastes`, PASTES_DIR), under
 *     the `[Large text attached …]` header.
 * Both are named on their own `- <path>` line of a header block at the top of
 * the message (session-uploads.ts withFilePaths, web/src/api/paste-spill.ts),
 * which is how they are found: by line, so a file name with spaces is whole.
 * A path anywhere else in the text is left alone, and a listed path is read only
 * when it resolves (symlinks followed) inside Walnut's own upload folders:
 * `<state>/uploads`, `<state>/tasks/<task>/uploads` and the pastes folder. The
 * header is what the person meant to send; the folders are what may be sent.
 * Paths under `[Images attached …]` take the picture lane (fs.write) instead,
 * whatever folder they are in, so they are never listed here.
 *
 * The bytes go in UPLOAD_CHUNK_BYTES chunks through the host daemon's
 * `upload.part` (the same lane a phone's session upload takes), and the path is
 * rewritten to the one the host answers. Under the same upload id the host
 * answers a finished file's path again for its last chunk, so shipping twice is
 * safe. A file that could not be shipped keeps its local path with a note after
 * it, so the agent reads why it cannot open it instead of a bare missing path.
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { PASTES_DIR } from '../constants.js'
import { UPLOAD_CHUNK_BYTES, UPLOAD_ID_RE, isUploadName } from '../core/sessions/session-uploads.js'
import { localTaskDirRoot } from '../core/sessions/task-dir-place.js'
import { isTaskDirId } from '../lib/task-dir.js'

/** The daemon capability that takes `upload.part` (daemon-capabilities.ts). */
export const UPLOAD_PART_CAPABILITY = 'upload-part-v1'

/** A chunk can take a while over a slow tunnel; the phone lane gives each the same. */
const CHUNK_TIMEOUT_MS = 120_000

/**
 * How many times one ship resumes from where the host says it holds the file.
 * A host answers `gap` only for a chunk past what it holds, so after a resume
 * the next chunk fits; the cap stops a host that keeps contradicting itself.
 */
const MAX_RESUMES = 8

/**
 * The note a `- <path>` line gets when its file could not be copied to the host:
 * `- <local path> (could not be copied to this host: <reason>)`. The web strips
 * it to draw the card (web/src/api/file-upload.ts splitAttachmentHeaders).
 */
export const SHIP_FAILED_NOTE = ' (could not be copied to this host: '

/** A header line that opens a block of `- <path>` lines at the top of a message. */
const HEADER_RE = /^\[(Images|Files|Large text) attached[^\]]*\]$/

/** How many header blocks the top of a message may hold (pictures, files, a paste). */
const MAX_BLOCKS = 4

export type AttachmentKind = 'images' | 'files' | 'paste'

interface HeaderBlocks {
  blocks: Array<{ kind: AttachmentKind; paths: string[] }>
  /** The first line after the last block's path list. */
  end: number
}

function headerBlocks(lines: string[]): HeaderBlocks {
  const blocks: HeaderBlocks['blocks'] = []
  let i = 0
  let end = 0
  while (blocks.length < MAX_BLOCKS && i < lines.length) {
    const m = HEADER_RE.exec(lines[i].replace(/\r$/, ''))
    if (!m) break
    i++
    const paths: string[] = []
    while (i < lines.length && lines[i].startsWith('- ')) paths.push(lines[i++].slice(2).replace(/\r$/, ''))
    blocks.push({ kind: m[1] === 'Images' ? 'images' : m[1] === 'Files' ? 'files' : 'paste', paths })
    end = i
    if (i < lines.length && lines[i].replace(/\r$/, '') === '') i++
  }
  return { blocks, end }
}

/** The header blocks at the top of `text`, in order, each with its listed paths. */
export function attachmentBlocks(text: string): Array<{ kind: AttachmentKind; paths: string[] }> {
  return headerBlocks(text.split('\n')).blocks
}

/** Every path listed under a files or paste header: these take the chunked lane, never the picture one. */
export function attachedFilePaths(text: string): Set<string> {
  return new Set(attachmentBlocks(text).filter((b) => b.kind !== 'images').flatMap((b) => b.paths))
}

/** Where Walnut keeps the files it may ship (see the top of this file). */
export interface ShipRoots {
  /** Folders whose `up-<id>/<name>` children are uploads with no task (`<state>/uploads`). */
  uploads: string[]
  /** Task directory roots whose `<task>/uploads/up-<id>/<name>` are a task's uploads. */
  tasks: string[]
  /** Folders whose `<name>` children are spilled pastes. */
  pastes: string[]
}

/**
 * This machine's roots. The local daemon writes uploads beside its task
 * directory root, which it reports in its hello (`taskDirRoot`); a service
 * daemon may run with another env than this server, so both roots count.
 */
export function localShipRoots(daemonTaskDirRoot?: string | null): ShipRoots {
  const tasks = [...new Set([localTaskDirRoot(), ...(daemonTaskDirRoot ? [daemonTaskDirRoot] : [])])]
  return { tasks, uploads: tasks.map((t) => path.join(path.dirname(t), 'uploads')), pastes: [PASTES_DIR] }
}

export interface ShippableFile {
  /** The path as the message names it (the line to rewrite). */
  localPath: string
  /** The resolved file the bytes are read from. */
  readPath: string
  uploadId: string
  name: string
}

/** The Walnut-owned files `text` lists under a files or paste header at its top. */
export function findShippableFiles(text: string, roots: ShipRoots): ShippableFile[] {
  const out: ShippableFile[] = []
  const seen = new Set<string>()
  const real = {
    uploads: realRoots(roots.uploads),
    tasks: realRoots(roots.tasks),
    pastes: realRoots(roots.pastes),
  }
  for (const localPath of attachedFilePaths(text)) {
    if (seen.has(localPath)) continue
    seen.add(localPath)
    const file = shippable(localPath, real)
    if (file) out.push(file)
  }
  return out
}

function realRoots(dirs: string[]): string[] {
  const out = new Set<string>()
  for (const d of dirs) {
    try { out.add(fs.realpathSync(d)) } catch { /* not made yet: nothing under it to ship */ }
  }
  return [...out]
}

/** The parts of `p` under `root`, or null when it is not strictly inside. */
function partsUnder(root: string, p: string): string[] | null {
  const rel = path.relative(root, p)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep)
}

function shippable(localPath: string, roots: ShipRoots): ShippableFile | null {
  if (!path.isAbsolute(localPath) || localPath.split('/').includes('..')) return null
  let readPath: string
  try {
    readPath = fs.realpathSync(localPath)
    if (!fs.statSync(readPath).isFile()) return null
  } catch {
    return null
  }
  for (const root of roots.uploads) {
    const parts = partsUnder(root, readPath)
    if (parts?.length === 2 && UPLOAD_ID_RE.test(parts[0]) && isUploadName(parts[1])) {
      return { localPath, readPath, uploadId: parts[0], name: parts[1] }
    }
  }
  for (const root of roots.tasks) {
    const parts = partsUnder(root, readPath)
    if (parts?.length === 4 && isTaskDirId(parts[0]) && parts[1] === 'uploads' && UPLOAD_ID_RE.test(parts[2]) && isUploadName(parts[3])) {
      return { localPath, readPath, uploadId: parts[2], name: parts[3] }
    }
  }
  for (const root of roots.pastes) {
    const parts = partsUnder(root, readPath)
    if (parts?.length === 1 && isUploadName(parts[0])) {
      // One id per paste file, the same every time it is shipped.
      const uploadId = `up-paste-${createHash('sha256').update(parts[0]).digest('hex').slice(0, 24)}`
      if (UPLOAD_ID_RE.test(uploadId)) return { localPath, readPath, uploadId, name: parts[0] }
    }
  }
  return null
}

/** A daemon command, as DaemonConnection.send runs it (an `{ok:false}` reply resolves). */
export type DaemonSend = (cmd: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>

/**
 * Which session and task the file is for. The host files it under that task's
 * directory (daemon uploadsRootFor), so it goes when the task's directory goes;
 * without them it lands in the host's `<state>/uploads`, which only an age sweep
 * empties.
 */
export interface ShipOwner {
  sessionId?: string
  taskId?: string
  home?: string
}

export type ShipOutcome = { ok: true; path: string } | { ok: false; reason: string }

/**
 * Send one file to the host in chunks: its path there, or why the host would
 * not take it. Throws only on a transport failure.
 */
export async function shipFile(file: ShippableFile, send: DaemonSend, owner: ShipOwner = {}): Promise<ShipOutcome> {
  const handle = await fs.promises.open(file.readPath, 'r')
  try {
    const size = (await handle.stat()).size
    const sha256 = await sha256Of(handle, size)
    let offset = 0
    let resumes = 0
    for (;;) {
      const length = Math.min(UPLOAD_CHUNK_BYTES, size - offset)
      const chunk = Buffer.alloc(length)
      if (length > 0) await handle.read(chunk, 0, length, offset)
      const last = offset + length === size
      const res = await send('upload.part', {
        uploadId: file.uploadId, name: file.name, size, offset,
        data: chunk.toString('base64'),
        ...(last ? { sha256 } : {}),
        ...(owner.sessionId ? { sessionId: owner.sessionId } : {}),
        ...(owner.taskId ? { taskId: owner.taskId } : {}),
        ...(owner.home ? { home: owner.home } : {}),
      }, CHUNK_TIMEOUT_MS)
      if (res.ok !== true) {
        // `gap`: the host holds `have` bytes of this upload. All of it (a file
        // shipped before) answers its path to the last chunk; part of it (a ship
        // cut off earlier, or staging the host swept) goes on from there.
        const have = res.code === 'gap' && typeof res.have === 'number' && Number.isInteger(res.have) ? res.have : -1
        if (have >= 0 && have <= size && have !== offset && resumes < MAX_RESUMES) {
          resumes++
          offset = have
          continue
        }
        return { ok: false, reason: String(res.error ?? 'the host refused the file').replace(/^upload\.part failed: /, '') }
      }
      if (res.done === true && typeof res.path === 'string') return { ok: true, path: res.path }
      if (last) return { ok: false, reason: 'the host did not say where it saved the file' }
      offset = typeof res.staged === 'number' && res.staged > offset ? res.staged : offset + length
    }
  } finally {
    await handle.close()
  }
}

async function sha256Of(handle: fs.promises.FileHandle, size: number): Promise<string> {
  const hash = createHash('sha256')
  const buf = Buffer.alloc(Math.min(UPLOAD_CHUNK_BYTES, Math.max(size, 1)))
  for (let at = 0; at < size;) {
    const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - at), at)
    if (bytesRead === 0) break
    hash.update(buf.subarray(0, bytesRead))
    at += bytesRead
  }
  return hash.digest('hex')
}

/** A reason that fits on the note's one line and never closes it early. */
function noteReason(reason: string): string {
  const flat = reason.replace(/[()]/g, '').replace(/\s+/g, ' ').trim() || 'unknown error'
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat
}

/**
 * `text` with every shipped local path swapped for the host's, and every path
 * that failed kept with a note after it. Only the `- <path>` lines of the header
 * blocks at the top change (the lines findShippableFiles read); CRLF lines keep
 * their CR.
 */
export function rewriteShipped(text: string, shipped: Map<string, string>, failed: Map<string, string> = new Map()): string {
  if (shipped.size === 0 && failed.size === 0) return text
  const lines = text.split('\n')
  const { end } = headerBlocks(lines)
  for (let i = 0; i < end; i++) {
    const raw = lines[i]
    const cr = raw.endsWith('\r') ? '\r' : ''
    const line = cr ? raw.slice(0, -1) : raw
    if (!line.startsWith('- /')) continue
    const local = line.slice(2)
    const remote = shipped.get(local)
    const reason = failed.get(local)
    if (remote) lines[i] = `- ${remote}${cr}`
    else if (reason !== undefined) lines[i] = `- ${local}${SHIP_FAILED_NOTE}${noteReason(reason)})${cr}`
  }
  return lines.join('\n')
}

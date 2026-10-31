/**
 * Images an MCP tool on another host returned (host-mcp.ts) become files in the
 * CALLING task's directory on the caller's own host, so its agent opens them with
 * its Read tool and no base64 sits in its context. The server writes them, because
 * the op for a session on another host runs here (its `walnut` is the daemon's
 * gateway shim): on this Mac with the file system, elsewhere through that host's
 * daemon (`fs.writePart`, one part per image, renamed into place only when whole).
 *
 * A relayed caller's answer must leave within its budget: the writes still going
 * when that runs out carry on, and the answer names their paths as still being
 * written. Images that cannot be written (no task directory known there, a daemon
 * too old) keep only their size.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { log } from '../../logging/index.js'
import { budgetLeft, type Caller } from './host-exec.js'

const LOCAL = '__local__'
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
/** Leave this much of a relayed caller's budget for the answer itself. */
const ANSWER_MARGIN_MS = 1_000

export type McpImage = { mimeType: string; bytes: number; data?: string; path?: string; pending?: boolean }

async function writeOne(caller: Caller, file: string, data: string): Promise<void> {
  const buf = Buffer.from(data, 'base64')
  if (caller.host === LOCAL) {
    // A kept answer read again names the same file: written once is enough.
    if ((await fs.stat(file).catch(() => null))?.size === buf.length) return
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${randomBytes(4).toString('hex')}.walnut-part`
    await fs.writeFile(tmp, buf)
    await fs.rename(tmp, file).catch(async (err) => { await fs.rm(tmp, { force: true }); throw err })
    return
  }
  const { writePart } = await import('../transfer/daemon-transfer-client.js')
  await writePart(caller.host, { path: file, offset: 0, data: buf, final: true, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') })
}

/**
 * Write each image that came back whole, and return the list as the agent reads it:
 * a `path` instead of `data`, `pending` while its write still runs.
 */
export async function saveCallImages(caller: Caller, callId: string, images: unknown, t0: number): Promise<McpImage[]> {
  if (!Array.isArray(images)) return []
  const list = (images as Array<Record<string, unknown>>).map((img) => ({
    mimeType: String(img.mimeType ?? ''), bytes: typeof img.bytes === 'number' ? img.bytes : 0,
    ...(typeof img.data === 'string' && img.data ? { data: img.data } : {}),
  })) as McpImage[]
  if (!list.some((i) => i.data)) return list
  // On this Mac the directory is made the way a session start makes it (its marker lets the
  // cleanup find it); another host's daemon made it when the calling session started there.
  const place = await import('../sessions/task-dir-place.js')
  const dir = caller.host === LOCAL
    ? await place.ensureTaskDirOnHost(caller.taskId, LOCAL).then((r) => ('path' in r ? r.path : null), () => null)
    : await place.taskDirForHost(caller.taskId, caller.host).catch(() => null)
  const id = callId.replace(/[^\w-]/g, '')
  const writes: Array<Promise<void>> = []
  const out = list.map((img, i) => {
    const { data, ...rest } = img
    if (!data || !dir || !id) return rest
    const file = path.join(dir, 'host-mcp', `${id}-${i + 1}.${EXT[img.mimeType] ?? 'bin'}`)
    const entry: McpImage = { ...rest, path: file, pending: true }
    writes.push(writeOne(caller, file, data).then(() => { delete entry.pending }, (err) => {
      delete entry.path
      delete entry.pending
      log.session.warn('host mcp image not saved', { taskId: caller.taskId, host: caller.host, callId, error: err instanceof Error ? err.message : String(err) })
    }))
    return entry
  })
  const all = Promise.all(writes)
  const left = budgetLeft(caller, t0) - ANSWER_MARGIN_MS
  if (Number.isFinite(left)) await Promise.race([all, new Promise((r) => setTimeout(r, Math.max(0, left)))])
  else await all
  // A snapshot: the writes still going settle their own entries later, never this answer.
  return out.map((e) => ({ ...e }))
}

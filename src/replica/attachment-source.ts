/**
 * The pictures and files of the notes on a host replica: read from the copy the host
 * daemon keeps (providers/attachment-copy-core.ts, 'attachment-copy-v1'), through the
 * follower link's owner-scoped reads, never from a second vault on the host. The notes
 * text comes from the same daemon (notes-source.ts); the companion reads its own copy
 * (core/companion-attachment-copy.ts).
 *
 *   index    `attachments.list` pages (sorted paths), kept a few seconds: a note fires
 *            20 to 40 picture reads at once and they share one listing
 *   bytes    `attachments.read {key, offset}`, 2 MB a slice, put together and checked
 *            against the sha256 the copy names
 *
 * Only while the Mac is away does a picture read reach this (the route is a leader row,
 * forwarded while the Mac answers). Until the copy is held, or with a daemon without the
 * capability, the read goes on to the replica's own disk, as before.
 */
import crypto from 'node:crypto'
import { log } from '../logging/index.js'

type Request = (cmd: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>

/** A listing is asked again at most this often. */
const LIST_TTL_MS = 3_000
const READ_TIMEOUT_MS = 30_000
const MAX_FILE_BYTES = 50 * 1024 * 1024
const MAX_PAGES = 50

let request: Request | null = null
let listing: { at: number; keys: string[]; asOf: string | null; off: boolean } | null = null
let listInFlight: Promise<{ keys: string[]; asOf: string | null; off: boolean }> | null = null

/** A host replica's boot: its pictures come from the daemon's copy (null: none, the leader and the companion). */
export function installReplicaAttachments(req: Request | null): void {
  request = req
  listing = null
  listInFlight = null
}

async function listAll(req: Request): Promise<{ keys: string[]; asOf: string | null; off: boolean }> {
  const keys: string[] = []
  let asOf: string | null = null
  let off = false
  let after: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await req('attachments.list', after ? { after } : {}, READ_TIMEOUT_MS)
    if (r.ok !== true) throw new Error(typeof r.error === 'string' ? r.error : 'attachments.list failed')
    if (Array.isArray(r.keys)) for (const k of r.keys) if (typeof k === 'string') keys.push(k)
    asOf = typeof r.asOf === 'string' ? r.asOf : null
    off = r.off === true
    after = typeof r.next === 'string' && r.next ? r.next : null
    if (!after) break
  }
  return { keys, asOf, off }
}

async function index(req: Request): Promise<{ keys: string[]; asOf: string | null; off: boolean }> {
  if (listing && Date.now() - listing.at < LIST_TTL_MS) return listing
  // One warning per failed listing, not one per picture of the burst that shared it.
  listInFlight ??= listAll(req)
    .then((l) => { listing = { at: Date.now(), ...l }; return l })
    .catch((err: unknown) => {
      log.web.warn('replica attachments: the host copy could not be listed', { error: err instanceof Error ? err.message : String(err) })
      throw err
    })
    .finally(() => { listInFlight = null })
  return listInFlight
}

async function readAll(req: Request, key: string): Promise<Buffer | null> {
  const parts: Buffer[] = []
  let offset = 0
  let total = -1
  let h = ''
  for (;;) {
    const r = await req('attachments.read', { key, offset }, READ_TIMEOUT_MS)
    if (r.ok !== true || typeof r.data !== 'string' || typeof r.n !== 'number' || typeof r.h !== 'string') return null
    if (total < 0) { total = r.n; h = r.h }
    // The file changed between two slices: the next read starts over.
    if (r.h !== h || r.n > MAX_FILE_BYTES) return null
    const data = Buffer.from(r.data, 'base64')
    parts.push(data)
    offset += data.length
    if (offset >= total || data.length === 0) break
  }
  const bytes = Buffer.concat(parts)
  if (bytes.length !== total || crypto.createHash('sha256').update(bytes).digest('hex') !== h) {
    log.web.warn('replica attachments: the bytes read are not the ones the copy names', { path: key })
    return null
  }
  return bytes
}

/**
 * The file an embed names, from the host's copy. `null` when the copy is held and names
 * no such file; `undefined` when the replica should read its own disk (no copy reader
 * here, the copy not held yet, or the daemon could not be asked); `'not_kept'` when the
 * file is the Mac's alone: the pictures turned off for this host, or a miss in a copy
 * that leaves notes out (the file may be in one of them).
 */
export async function replicaAttachmentRead(raw: string, notePath?: string): Promise<{ rel: string; bytes: Buffer } | null | undefined | 'not_kept'> {
  const req = request
  if (!req) return undefined
  let idx: { keys: string[]; asOf: string | null; off: boolean }
  try { idx = await index(req) } catch { return undefined }
  if (idx.off) return 'not_kept'
  if (idx.asOf === null) return undefined
  const { resolveAttachmentInIndex } = await import('../web/routes/notes-attachment.js')
  const rel = resolveAttachmentInIndex(raw, notePath, idx.keys)
  if (!rel) {
    // A miss: the Mac's when the picture may be in what the copy leaves out, else a broken link.
    const src = (await import('./notes-source.js')).replicaNotesSource()
    const exclude = src ? await src.copyState().then((st) => st.exclude, () => [] as string[]) : []
    const { pictureMayBeLeftOut } = await import('../core/replication/keep-rule.js')
    return pictureMayBeLeftOut(raw, notePath, exclude) ? 'not_kept' : null
  }
  const bytes = await readAll(req, rel).catch(() => null)
  return bytes ? { rel, bytes } : null
}

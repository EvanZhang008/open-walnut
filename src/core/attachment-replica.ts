/**
 * The Mac's side of the cloud companion's copy of the pictures and files in the notes
 * (stage 4d of docs/plan/walnut-companion-unified-replica.md; the box's side is
 * core/companion-attachment-copy.ts). Hosts never get one: a session there reads note
 * text, and the attachment route is the companion's, answered for the phone and the
 * console wherever the Mac is.
 *
 * Why a copy and not a relay to the Mac: a picture read happens in bursts (one note
 * fires 20 to 40 at once), must work while the Mac is away, and file bytes do not ride
 * the bridge (docs/reference/cloud-sync.md, "Why bulk uploads leave the bridge"). A copy
 * answers every read on the box at disk speed and costs the box the files' size once
 * (1.5 GB for the measured vault, 1,395 files); only changed files go again, found by a
 * stat cache, and each chunk is its own short HTTPS request, so a damaged one costs one
 * retry and a broken upload resumes where the box says it stopped.
 *
 * One round: walk the vault for the files the attachment route serves (by extension,
 * at most 50 MB each), hash what changed since the last walk (read in slices: a large
 * file never holds the loop), keep the newest within the byte budget, send the manifest,
 * then send the files the box lacks, at most ROUND_BYTES a round; a round that stops
 * there runs again 15 s later. The manifest is not sent again while it stays the same
 * and the box says it holds it.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { NOTES_DIR } from '../constants.js'
import { log } from '../logging/index.js'

const MAX_FILES = 20_000
const MAX_FILE_BYTES = 50 * 1024 * 1024
/** The copy at most: the newest files within it (the measured vault is 1.5 GB). */
const BUDGET_BYTES = 8 * 1024 * 1024 * 1024
/** What one round uploads at most, so the notes rounds never wait an hour behind a first fill. */
export const ROUND_BYTES = 128 * 1024 * 1024
const CHUNK_BYTES = 2 * 1024 * 1024
const PUT_TIMEOUT_MS = 60_000
const NEXT_ROUND_MS = 15_000
const MEMO_MS = 30 * 60_000

export interface AttachmentEntry { k: string; h: string; n: number; mtimeMs: number }

type Send = (cmd: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>

const statCache = new Map<string, { mtimeMs: number; size: number; h: string }>()

async function hashFile(abs: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(abs, { highWaterMark: 256 * 1024 })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

function inFolder(rel: string, folders: string[]): boolean {
  return folders.some((f) => rel === f || rel.startsWith(`${f}/`))
}

/** Every file the attachment route serves, newest first, within the budget. */
export async function attachmentEntries(exclude: string[], root = NOTES_DIR): Promise<AttachmentEntry[]> {
  const { isServedAttachment } = await import('../web/routes/notes-v2.js')
  const out: AttachmentEntry[] = []
  const seen = new Set<string>()
  const walk = async (dir: string, relDir: string): Promise<void> => {
    let names: fs.Dirent[]
    try { names = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const d of names) {
      if (d.name.startsWith('.') || d.name.startsWith('~$')) continue
      const rel = relDir ? `${relDir}/${d.name}` : d.name
      if (inFolder(rel, exclude)) continue
      const abs = path.join(dir, d.name)
      if (d.isDirectory()) { await walk(abs, rel); continue }
      if (!d.isFile() || /\.md$/i.test(d.name) || !isServedAttachment(d.name)) continue
      let st: fs.Stats
      try { st = await fsp.stat(abs) } catch { continue }
      if (st.size > MAX_FILE_BYTES) continue
      seen.add(abs)
      let row = statCache.get(abs)
      if (!row || row.mtimeMs !== st.mtimeMs || row.size !== st.size) {
        try { row = { mtimeMs: st.mtimeMs, size: st.size, h: await hashFile(abs) } } catch { continue }
        statCache.set(abs, row)
      }
      out.push({ k: rel, h: row.h, n: row.size, mtimeMs: row.mtimeMs })
    }
  }
  await walk(root, '')
  for (const abs of statCache.keys()) if (abs.startsWith(root + path.sep) && !seen.has(abs)) statCache.delete(abs)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.k.localeCompare(b.k))
  const kept: AttachmentEntry[] = []
  let bytes = 0
  for (const e of out) {
    if (kept.length >= MAX_FILES || bytes + e.n > BUDGET_BYTES) break
    bytes += e.n
    kept.push(e)
  }
  if (kept.length < out.length) log.session.info('companion attachments: the copy keeps the newest files within its budget', { kept: kept.length, of: out.length })
  // In path order: a file touched without a change keeps the manifest (and its memo) as it was.
  return kept.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
}

/** Upload one file from `from`; the bytes sent, or -1 when it stopped (the next round goes on). */
async function upload(send: Send, root: string, e: AttachmentEntry, from: number): Promise<number> {
  const abs = path.join(root, e.k)
  let fh: fsp.FileHandle
  try { fh = await fsp.open(abs, 'r') } catch { return -1 }
  let sent = 0
  try {
    const st = await fh.stat()
    // Changed since the manifest: the next round sends the new bytes.
    if (st.size !== e.n || st.mtimeMs !== e.mtimeMs) return -1
    let offset = Math.min(Math.max(0, from), e.n)
    for (;;) {
      const len = Math.min(CHUNK_BYTES, e.n - offset)
      const buf = Buffer.alloc(len)
      if (len > 0) await fh.read(buf, 0, len, offset)
      const r = await send('attachments.put', { k: e.k, h: e.h, offset, data: buf.toString('base64') }, PUT_TIMEOUT_MS)
      if (r.ok !== true) {
        if (r.errorKind === 'offset' && typeof r.have === 'number' && r.have < offset) { offset = r.have; continue }
        log.session.warn('companion attachments: a file did not go', { path: e.k, error: r.error })
        return -1
      }
      sent += len
      if (r.stored === true) return sent
      offset += len
      if (offset >= e.n) return -1
    }
  } finally {
    await fh.close()
  }
}

let memo: { hash: string; at: number } | null = null
let dropped = false
let running = false
let again: ReturnType<typeof setTimeout> | null = null
let unsupportedUntil = 0

export interface AttachmentRoundResult { action: 'synced' | 'unchanged' | 'dropped' | 'skipped' | 'failed'; entries?: number; sent?: number; bytes?: number; more?: boolean; error?: string }

/**
 * One round of the companion's attachments copy. `keep` is the companion's keep settings
 * (config hosts.companion.keep). Never throws; one round at a time.
 */
export async function syncCompanionAttachments(send: Send, keep: { on: boolean; exclude: string[] }, root = NOTES_DIR): Promise<AttachmentRoundResult> {
  if (running) return { action: 'skipped' }
  if (Date.now() < unsupportedUntil) return { action: 'skipped' }
  running = true
  try {
    if (!keep.on) {
      if (dropped) return { action: 'unchanged' }
      const r = await send('attachments.drop', {})
      if (r.ok !== true) return { action: 'failed', error: String(r.error ?? 'refused') }
      dropped = true
      memo = null
      return { action: 'dropped' }
    }
    dropped = false
    const st = await send('attachments.status', {})
    if (st.ok !== true) {
      // An older box answers the command it does not know: ask again in 10 minutes.
      if (st.errorKind === 'bad_request' || st.errorKind === 'unsupported') unsupportedUntil = Date.now() + 10 * 60_000
      return { action: 'failed', error: String(st.error ?? 'no status') }
    }
    if (st.asOf == null || (memo && Date.now() - memo.at > MEMO_MS)) memo = null
    const entries = await attachmentEntries(keep.exclude, root)
    const manifest = entries.map(({ k, h, n }) => ({ k, h, n }))
    const hash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
    if (memo?.hash === hash) return { action: 'unchanged', entries: entries.length }
    const reply = await send('attachments.sync', { entries: manifest, asOf: Date.now() })
    if (reply.ok !== true) return { action: 'failed', error: String(reply.error ?? 'refused') }
    const need = Array.isArray(reply.need) ? (reply.need as unknown[]).filter((k): k is string => typeof k === 'string') : []
    const have = (reply.have && typeof reply.have === 'object' ? reply.have : {}) as Record<string, unknown>
    const byKey = new Map(entries.map((e) => [e.k, e]))
    let bytes = 0
    let sent = 0
    let short = false
    for (const k of need) {
      const e = byKey.get(k)
      if (!e) { short = true; continue }
      if (bytes >= ROUND_BYTES) { short = true; break }
      const n = await upload(send, root, e, typeof have[k] === 'number' ? have[k] as number : 0)
      if (n < 0) { short = true; continue }
      bytes += n
      sent++
    }
    memo = short ? null : { hash, at: Date.now() }
    if (short) scheduleAgain(send, keep, root)
    return { action: 'synced', entries: entries.length, sent, bytes, ...(short ? { more: true } : {}) }
  } catch (err) {
    memo = null
    return { action: 'failed', error: err instanceof Error ? err.message : String(err) }
  } finally {
    running = false
  }
}

function scheduleAgain(send: Send, keep: { on: boolean; exclude: string[] }, root: string): void {
  if (again) return
  again = setTimeout(() => {
    again = null
    void syncCompanionAttachments(send, keep, root).then((r) => {
      if (r.action !== 'unchanged' && r.action !== 'skipped') log.session.info('companion attachments: round', { ...r })
    })
  }, NEXT_ROUND_MS)
  again.unref?.()
}

/** The companion changed build or was replaced: its next round sends the manifest again. */
export function forgetCompanionAttachments(): void {
  memo = null
  dropped = false
  unsupportedUntil = 0
}

/** Tests: no state, no round armed. */
export function _resetAttachmentReplicaForTesting(): void {
  forgetCompanionAttachments()
  statCache.clear()
  running = false
  if (again) clearTimeout(again)
  again = null
}

/**
 * The Mac's side of every replica's copy of the pictures and files in the notes: each
 * host daemon (capability 'attachment-copy-v1') and the cloud companion keep the same
 * copy (providers/attachment-copy-core.ts), so a note's pictures show wherever the
 * notes do. A target that keeps no notes keeps no attachments either
 * (`hosts.<key>.keep.attachments`, on unless set false; core/host-replica.ts).
 *
 * Why a copy and not a relay to the Mac: a picture read happens in bursts (one note
 * fires 20 to 40 at once), must work while the Mac is away, and file bytes do not ride
 * the bridge (docs/reference/cloud-sync.md, "Why bulk uploads leave the bridge"). A copy
 * answers every read on the replica at disk speed and costs it the files' size once
 * (1.5 GB for the measured vault, 1,395 files); only changed files go again, found by a
 * stat cache, and each chunk is its own short request, so a damaged one costs one retry
 * and a broken upload resumes where the replica says it stopped.
 *
 * One round per target: walk the vault for the files the attachment route serves (by
 * extension, at most 50 MB each; the targets' rounds share one walk), hash what changed
 * since the last walk (read in slices: a large file never holds the loop), keep the
 * newest within the byte budget, send the manifest, then send the files the target lacks,
 * at most ROUND_BYTES a round; a round that stops there runs again 15 s later. The
 * manifest is not sent again while it stays the same and the target says it holds it.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { NOTES_DIR, WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import { leftOut } from './replication/keep-rule.js'

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
/** Where a round goes: a host's daemon link or the companion's door (core/host-replica.ts ReplicaTarget). */
export interface AttachmentTarget { hostKey: string; send: Send }
export interface AttachmentKeep { on: boolean; exclude: string[] }

const statCache = new Map<string, { mtimeMs: number; size: number; h: string }>()

async function hashFile(abs: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(abs, { highWaterMark: 256 * 1024 })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** A folder left out leaves its pictures and files out (replication/keep-rule.ts, the notes' own rule). */
function inFolder(rel: string, entries: string[]): boolean {
  return leftOut(rel, entries)
}

/** Walks in progress: the targets' rounds a note edit starts together share one walk of the vault. */
const walking = new Map<string, Promise<AttachmentEntry[]>>()

/** Every file the attachment route serves, within the budget, in path order. */
export function attachmentEntries(exclude: string[], root = NOTES_DIR): Promise<AttachmentEntry[]> {
  const key = JSON.stringify([root, exclude])
  const running = walking.get(key)
  if (running) return running
  const p = walkAttachments(exclude, root).finally(() => walking.delete(key))
  walking.set(key, p)
  return p
}

async function walkAttachments(exclude: string[], root: string): Promise<AttachmentEntry[]> {
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
  // A file gone since the last walk leaves the cache; one in a folder this walk left out stays (another target keeps it).
  for (const abs of statCache.keys()) {
    if (!abs.startsWith(root + path.sep) || seen.has(abs)) continue
    if (!inFolder(path.relative(root, abs).split(path.sep).join('/'), exclude)) statCache.delete(abs)
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.k.localeCompare(b.k))
  const kept: AttachmentEntry[] = []
  let bytes = 0
  for (const e of out) {
    if (kept.length >= MAX_FILES || bytes + e.n > BUDGET_BYTES) break
    bytes += e.n
    kept.push(e)
  }
  if (kept.length < out.length) log.session.info('attachments copy: the copy keeps the newest files within its budget', { kept: kept.length, of: out.length })
  // In path order: a file touched without a change keeps the manifest (and its memo) as it was.
  return kept.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
}

/** Upload one file from `from`; the bytes sent, or -1 when it stopped (the next round goes on). */
async function upload(target: AttachmentTarget, root: string, e: AttachmentEntry, from: number): Promise<number> {
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
      const r = await target.send('attachments.put', { home: WALNUT_HOME, k: e.k, h: e.h, offset, data: buf.toString('base64') }, PUT_TIMEOUT_MS)
      if (r.ok !== true) {
        if (r.errorKind === 'offset' && typeof r.have === 'number' && r.have < offset) { offset = r.have; continue }
        log.session.warn('attachments copy: a file did not go', { host: target.hostKey, path: e.k, error: r.error })
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

interface TargetState {
  memo: { hash: string; at: number } | null
  dropped: boolean
  running: boolean
  again: ReturnType<typeof setTimeout> | null
  unsupportedUntil: number
}
const states = new Map<string, TargetState>()
function stateOf(hostKey: string): TargetState {
  let s = states.get(hostKey)
  if (!s) { s = { memo: null, dropped: false, running: false, again: null, unsupportedUntil: 0 }; states.set(hostKey, s) }
  return s
}

export interface AttachmentRoundResult { action: 'synced' | 'unchanged' | 'dropped' | 'skipped' | 'failed'; entries?: number; sent?: number; bytes?: number; more?: boolean; error?: string }

/**
 * One round of `target`'s attachments copy. `keep` is the target's keep settings
 * (config hosts.<key>.keep: on while notes and attachments are kept). Never throws;
 * one round per target at a time.
 */
export async function syncAttachments(target: AttachmentTarget, keep: AttachmentKeep, root = NOTES_DIR): Promise<AttachmentRoundResult> {
  const s = stateOf(target.hostKey)
  if (s.running) return { action: 'skipped' }
  if (Date.now() < s.unsupportedUntil) return { action: 'skipped' }
  s.running = true
  const home = WALNUT_HOME
  try {
    if (!keep.on) {
      if (s.dropped) return { action: 'unchanged' }
      const r = await target.send('attachments.drop', { home })
      if (r.ok !== true) return { action: 'failed', error: String(r.error ?? 'refused') }
      s.dropped = true
      s.memo = null
      return { action: 'dropped' }
    }
    s.dropped = false
    const st = await target.send('attachments.status', { home })
    if (st.ok !== true) {
      // An older replica answers the command it does not know: ask again in 10 minutes.
      if (st.errorKind === 'bad_request' || st.errorKind === 'unsupported') s.unsupportedUntil = Date.now() + 10 * 60_000
      return { action: 'failed', error: String(st.error ?? 'no status') }
    }
    if (st.asOf == null || (s.memo && Date.now() - s.memo.at > MEMO_MS)) s.memo = null
    const entries = await attachmentEntries(keep.exclude, root)
    const manifest = entries.map(({ k, h, n }) => ({ k, h, n }))
    const hash = crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
    if (s.memo?.hash === hash) return { action: 'unchanged', entries: entries.length }
    // `exclude`: the folders the user left out, so the copy drops them however many files they hold.
    const reply = await target.send('attachments.sync', { home, entries: manifest, asOf: Date.now(), exclude: keep.exclude })
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
      const n = await upload(target, root, e, typeof have[k] === 'number' ? have[k] as number : 0)
      if (n < 0) { short = true; continue }
      bytes += n
      sent++
    }
    s.memo = short ? null : { hash, at: Date.now() }
    if (short) scheduleAgain(target, keep, root)
    return { action: 'synced', entries: entries.length, sent, bytes, ...(short ? { more: true } : {}) }
  } catch (err) {
    s.memo = null
    return { action: 'failed', error: err instanceof Error ? err.message : String(err) }
  } finally {
    s.running = false
  }
}

function scheduleAgain(target: AttachmentTarget, keep: AttachmentKeep, root: string): void {
  const s = stateOf(target.hostKey)
  if (s.again) return
  s.again = setTimeout(() => {
    s.again = null
    void syncAttachments(target, keep, root).then((r) => {
      if (r.action !== 'unchanged' && r.action !== 'skipped') log.session.info('attachments copy: round', { host: target.hostKey, ...r })
    })
  }, NEXT_ROUND_MS)
  s.again.unref?.()
}

/** `hostKey` changed connection, build or box: its next round asks and sends the manifest again. */
export function forgetAttachments(hostKey: string): void {
  const s = states.get(hostKey)
  if (!s) return
  s.memo = null
  s.dropped = false
  s.unsupportedUntil = 0
}

/** Tests: no state, no round armed. */
export function _resetAttachmentReplicaForTesting(): void {
  for (const s of states.values()) if (s.again) clearTimeout(s.again)
  states.clear()
  statCache.clear()
  walking.clear()
}

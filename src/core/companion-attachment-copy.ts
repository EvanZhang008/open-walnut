/**
 * The cloud companion's copy of the pictures and files in the Mac's notes (stage 4d of
 * docs/plan/walnut-companion-unified-replica.md). The notes copy (companion-host-replica.ts)
 * holds note text only; this one holds the files the notes embed, so the box answers
 * `/api/notes-v2/attachment` and `/api/v1/notes/attachment` without its git-written disk.
 *
 *   rounds   the Mac sends a manifest (vault path, sha256, size) through the door of the
 *            notes copy (`POST /bridge/host-replica`, `attachments.sync`), the box answers
 *            the paths whose bytes it lacks, and the Mac sends those in chunks
 *            (`attachments.put`, each its own short request, so a damaged one costs one
 *            retry and a broken upload resumes where it stopped). Bytes are stored once
 *            per hash: a file moved or copied in the vault is never sent again. The Mac's
 *            side is core/attachment-replica.ts.
 *   held     once a whole manifest arrived. A changed file keeps its old bytes until the
 *            new ones arrive, so a read in between answers the older picture, never none.
 *   pastes   a picture pasted here is a pending `note-attachment` record (its bytes are a
 *            journal blob, read by companionAttachmentRead); when the Mac takes it, its
 *            bytes are kept here as the box's own row until a manifest from after the ack
 *            names the path (the Mac wrote it there), or 10 minutes.
 *   bounds   at most 20,000 files of at most 50 MB (the route's own cap); the Mac leaves
 *            the oldest out past its byte budget. A manifest that removes most of a copy
 *            of 200 or more is refused, as the notes copy refuses one.
 *
 * Cloud companion only.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import type { JournalRecord } from '../providers/offline-journal-core.js'
import { followerKind } from './server-role.js'

export const ATTACHMENT_COPY_MAX_FILES = 20_000
export const ATTACHMENT_COPY_MAX_FILE_BYTES = 50 * 1024 * 1024
/** One `attachments.put` chunk at most (the door takes 8 MB of JSON; base64 adds a third). */
export const ATTACHMENT_CHUNK_BYTES = 2 * 1024 * 1024
const REMOVAL_FLOOR = 200
/** A picture the Mac took is kept as the box's own at most this long without a later manifest. */
const OWN_AWAIT_MS = 10 * 60_000
const HASH_RE = /^[0-9a-f]{64}$/

interface Row {
  /** sha256 of the bytes this box has for the path ('' while none arrived yet). */
  h: string
  n: number
  /** The bytes the last manifest named, while they are on their way. */
  want?: string
  wantN?: number
  /** A picture pasted here that the Mac took: the Mac's clock at its ack, this box's then. */
  own?: { ackAt: number; at: number }
}

interface State {
  rows: Record<string, Row>
  /** The Mac's clock at the last manifest that arrived whole, or null (never held). */
  asOf: number | null
  /** The manifest still filling in. */
  pendingAsOf: number | null
}

export const companionAttachmentCopyDir = (): string => path.join(WALNUT_HOME, 'cache', 'replica', 'attachments')
const indexFile = (): string => path.join(companionAttachmentCopyDir(), 'index.json')
const blobFile = (h: string): string => path.join(companionAttachmentCopyDir(), 'b', h)
const partFile = (h: string): string => path.join(companionAttachmentCopyDir(), 'p', `${h}.part`)

let state: State | null = null

const onCompanion = (): boolean => followerKind() === 'companion'

function load(): State {
  if (state) return state
  state = { rows: {}, asOf: null, pendingAsOf: null }
  try {
    const raw = JSON.parse(fs.readFileSync(indexFile(), 'utf8')) as Partial<State>
    if (raw && raw.rows && typeof raw.rows === 'object') {
      state.rows = raw.rows as Record<string, Row>
      state.asOf = typeof raw.asOf === 'number' ? raw.asOf : null
      state.pendingAsOf = typeof raw.pendingAsOf === 'number' ? raw.pendingAsOf : null
    }
  } catch { /* no copy yet */ }
  return state
}

async function persist(st: State): Promise<void> {
  const file = indexFile()
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(st), { mode: 0o600 })
  await fsp.rename(tmp, file)
}

/** A vault-relative attachment path the copy may name, or null. */
export function attachmentKeyOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 1024 || /[\u0000-\u001f\u007f\\]/.test(raw)) return null
  if (raw.startsWith('/') || /\.md$/i.test(raw)) return null
  if (raw.split('/').some((seg) => !seg || seg === '.' || seg === '..' || seg.startsWith('.'))) return null
  return raw
}

function blobExists(h: string): boolean {
  try { return fs.statSync(blobFile(h)).isFile() } catch { return false }
}

/** Remove the bytes of `hashes` that no row names any more. */
async function collect(st: State, hashes: Iterable<string>): Promise<void> {
  const named = new Set<string>()
  for (const r of Object.values(st.rows)) { if (r.h) named.add(r.h); if (r.want) named.add(r.want) }
  for (const h of hashes) {
    if (!h || named.has(h)) continue
    await fsp.rm(blobFile(h), { force: true }).catch(() => {})
    await fsp.rm(partFile(h), { force: true }).catch(() => {})
  }
}

/** Is the box's own row still held against a manifest of `asOf` (the Mac's clock)? */
function ownHeld(row: Row, asOf: number, now = Date.now()): boolean {
  return !!row.own && asOf <= row.own.ackAt && now - row.own.at < OWN_AWAIT_MS
}

function refused(code: string, message: string, detail?: Record<string, unknown>): Record<string, unknown> {
  return { ok: false, error: `${code}: ${message}`, errorKind: code, ...(detail ? { detail } : {}) }
}

async function sync(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const entries = params.entries
  if (!Array.isArray(entries) || entries.length > ATTACHMENT_COPY_MAX_FILES) return refused('bad_request', 'bad entries')
  const at = typeof params.asOf === 'number' && Number.isFinite(params.asOf) ? params.asOf : Date.now()
  const st = load()
  const seen = new Map<string, { h: string; n: number }>()
  for (const raw of entries as Array<{ k?: unknown; h?: unknown; n?: unknown }>) {
    const k = attachmentKeyOf(raw?.k)
    if (!k || seen.has(k) || typeof raw.h !== 'string' || !HASH_RE.test(raw.h)) continue
    if (typeof raw.n !== 'number' || !Number.isInteger(raw.n) || raw.n < 0 || raw.n > ATTACHMENT_COPY_MAX_FILE_BYTES) continue
    seen.set(k, { h: raw.h, n: raw.n })
  }
  const now = Date.now()
  // The bytes this box holds: every blob is named by a row (collect removes the rest), so
  // a first fill of 20,000 files never stats each one on the loop.
  const stored = new Set(Object.values(st.rows).map((r) => r.h).filter(Boolean))
  const removing = Object.keys(st.rows).filter((k) => !seen.has(k) && !ownHeld(st.rows[k]!, at, now))
  const local = Object.keys(st.rows).length
  if (local >= REMOVAL_FLOOR && removing.length * 2 > local) {
    log.session.warn('companion attachments: a manifest that removes most of the copy was refused', { local, removing: removing.length, entries: seen.size })
    return refused('manifest_removes_most_rows', `the manifest would remove ${removing.length} of ${local} files kept here`, { local, removing: removing.length, entries: seen.size })
  }
  const freed: string[] = []
  for (const k of removing) { const r = st.rows[k]!; freed.push(r.h, r.want ?? ''); delete st.rows[k] }
  const need: string[] = []
  let held = 0
  for (const [k, e] of seen) {
    const row = st.rows[k]
    if (row && ownHeld(row, at, now) && row.h !== e.h) { held++; continue }
    if (row && row.h === e.h) {
      if (row.want) freed.push(row.want)
      st.rows[k] = { h: e.h, n: e.n }
      continue
    }
    if (stored.has(e.h)) {
      if (row) freed.push(row.h, row.want ?? '')
      st.rows[k] = { h: e.h, n: e.n }
      continue
    }
    if (row?.want && row.want !== e.h) freed.push(row.want)
    // The bytes shown so far stay until the new ones arrive (put frees them then).
    st.rows[k] = { h: row?.h ?? '', n: row?.n ?? 0, want: e.h, wantN: e.n }
    need.push(k)
  }
  if (need.length === 0) { st.asOf = at; st.pendingAsOf = null } else st.pendingAsOf = at
  await persist(st)
  await collect(st, freed)
  // Where a broken upload stopped, so the Mac goes on from there.
  const have: Record<string, number> = {}
  for (const k of need.slice(0, 2_000)) {
    try { const size = (await fsp.stat(partFile(st.rows[k]!.want!))).size; if (size > 0) have[k] = size } catch { /* none yet */ }
  }
  return { ok: true, need, have, entries: seen.size, removed: removing.length, held }
}

/** sha256 of a file, read in slices (a 50 MB file never blocks the loop in one call). */
async function hashFile(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 256 * 1024 })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

async function put(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const k = attachmentKeyOf(params.k)
  const st = load()
  const row = k ? st.rows[k] : undefined
  if (!k || !row) return refused('not_wanted', 'no manifest names this file')
  const h = typeof params.h === 'string' ? params.h : ''
  if (row.h === h && h) return { ok: true, have: row.n, stored: true }
  if (!row.want || row.want !== h || row.wantN === undefined) return refused('not_wanted', 'the last manifest names other bytes for this file')
  const offset = typeof params.offset === 'number' && Number.isInteger(params.offset) && params.offset >= 0 ? params.offset : -1
  const data = typeof params.data === 'string' ? Buffer.from(params.data, 'base64') : null
  if (offset < 0 || !data || data.length > ATTACHMENT_CHUNK_BYTES || offset + data.length > row.wantN) return refused('bad_request', 'a chunk outside the file')
  const part = partFile(h)
  await fsp.mkdir(path.dirname(part), { recursive: true, mode: 0o700 })
  let have = 0
  try { have = (await fsp.stat(part)).size } catch { /* a first chunk */ }
  // A chunk past what arrived answers where to go on; one already here (a retry) is taken again.
  if (offset > have) return { ok: false, error: 'a chunk past the bytes that arrived', errorKind: 'offset', have }
  const fh = await fsp.open(part, have === 0 ? 'w' : 'r+', 0o600)
  try {
    await fh.write(data, 0, data.length, offset)
    await fh.truncate(offset + data.length)
  } finally {
    await fh.close()
  }
  have = offset + data.length
  if (have < row.wantN) return { ok: true, have, stored: false }
  if (await hashFile(part) !== h) {
    await fsp.rm(part, { force: true })
    return refused('hash_mismatch', 'the bytes that arrived are not the ones the manifest named')
  }
  await fsp.mkdir(path.dirname(blobFile(h)), { recursive: true, mode: 0o700 })
  await fsp.rename(part, blobFile(h))
  const old = row.h
  // Every row waiting on these bytes has them now (the same file twice in the vault).
  for (const r of Object.values(st.rows)) if (r.want === h) { r.h = h; r.n = r.wantN ?? r.n; delete r.want; delete r.wantN }
  const remaining = Object.values(st.rows).filter((r) => r.want).length
  if (remaining === 0 && st.pendingAsOf !== null) { st.asOf = st.pendingAsOf; st.pendingAsOf = null }
  await persist(st)
  await collect(st, [old])
  return { ok: true, have, stored: true, remaining }
}

async function drop(): Promise<Record<string, unknown>> {
  const existed = Object.keys(load().rows).length > 0
  await fsp.rm(companionAttachmentCopyDir(), { recursive: true, force: true }).catch(() => {})
  state = { rows: {}, asOf: null, pendingAsOf: null }
  if (existed) log.session.info('companion attachments: copy removed')
  return { ok: true, dropped: existed }
}

function status(): Record<string, unknown> {
  const st = load()
  const rows = Object.values(st.rows)
  return {
    ok: true, entries: rows.length, pending: rows.filter((r) => r.want).length,
    bytes: rows.reduce((n, r) => n + (r.h ? r.n : 0), 0),
    asOf: st.asOf !== null ? new Date(st.asOf).toISOString() : null,
  }
}

/** Every change of the copy runs alone: each one reads and writes the whole index. */
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.catch(() => {})
  return run
}

/** One command of the Mac's attachments round (the door: web/routes/bridge-host-replica.ts). Never throws. */
export async function companionAttachmentCommand(cmd: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!onCompanion()) return { ok: false, error: 'not a cloud companion' }
  try {
    switch (cmd) {
      case 'attachments.sync': return await serial(() => sync(params))
      case 'attachments.put': return await serial(() => put(params))
      case 'attachments.drop': return await serial(() => drop())
      case 'attachments.status': return status()
      default: return { ok: false, error: 'unknown command', errorKind: 'bad_request' }
    }
  } catch (err) {
    log.session.warn('companion attachments: a command failed', { cmd, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ── reads ──

/** A whole manifest arrived at least once: the box's pictures come from here. */
export function companionAttachmentsHeld(): boolean {
  return onCompanion() && load().asOf !== null
}

/** The pictures pasted here that the Mac has not taken: path -> the journal blob's sha. */
async function pendingPastes(): Promise<Map<string, string>> {
  const { companionJournalRecords } = await import('./companion-journal.js')
  const out = new Map<string, string>()
  for (const r of companionJournalRecords()) {
    if (r.kind === 'note-attachment' && !r.dropped && typeof r.path === 'string' && typeof r.oursBlob === 'string') out.set(r.path, r.oursBlob)
  }
  return out
}

/**
 * The file an embed names, as the box shows it: a picture pasted here first, then the
 * copy. `null` when the copy is held and names no such file; `undefined` when the box
 * should read its own disk (not a companion, or no whole manifest yet, and no paste of
 * that exact path).
 */
export async function companionAttachmentRead(raw: string, notePath?: string): Promise<{ rel: string; bytes: Buffer } | null | undefined> {
  if (!onCompanion()) return undefined
  const st = load()
  const pastes = await pendingPastes()
  const stored = Object.keys(st.rows).filter((k) => st.rows[k]!.h)
  const held = st.asOf !== null
  let rel: string | null
  if (held) {
    const { resolveAttachmentInIndex } = await import('../web/routes/notes-attachment.js')
    rel = resolveAttachmentInIndex(raw, notePath, [...new Set([...pastes.keys(), ...stored])])
  } else {
    // Before the first whole manifest the box's disk answers, but never for a picture pasted here.
    const exact = raw.split('|')[0]!.trim().replace(/^\/+/, '')
    rel = pastes.has(exact) || st.rows[exact]?.own ? exact : null
    if (!rel) return undefined
  }
  if (!rel) return null
  const paste = pastes.get(rel)
  if (paste) {
    const { companionJournalBlobBody } = await import('./companion-journal.js')
    const bytes = companionJournalBlobBody(paste)
    if (bytes) return { rel, bytes }
  }
  const row = st.rows[rel]
  if (!row?.h) return null
  try {
    return { rel, bytes: await fsp.readFile(blobFile(row.h)) }
  } catch {
    log.session.warn('companion attachments: a file the copy names is missing its bytes', { path: rel })
    return null
  }
}

/** Is `rel` a file the box shows (a paste here or the copy)? For a paste's name check. */
export async function companionAttachmentExists(rel: string): Promise<boolean> {
  if (!onCompanion()) return false
  return (await pendingPastes()).has(rel) || !!load().rows[rel]?.h
}

/**
 * The Mac took these pictures (its clock `macNow` once it wrote them), before the journal
 * lets their bytes go: each is kept here as the box's own until a manifest from after the
 * ack names it, so the picture never disappears from the box in between.
 */
export function companionAttachmentsAcked(records: JournalRecord[], macNow: number): Promise<void> {
  return onCompanion() ? serial(() => keepAcked(records, macNow)) : Promise.resolve()
}

async function keepAcked(records: JournalRecord[], macNow: number): Promise<void> {
  const { companionJournalBlobBody } = await import('./companion-journal.js')
  const st = load()
  let n = 0
  for (const r of records) {
    const k = attachmentKeyOf(r.path)
    if (r.kind !== 'note-attachment' || r.dropped || !k || typeof r.oursBlob !== 'string') continue
    const bytes = companionJournalBlobBody(r.oursBlob)
    if (!bytes) continue
    const h = crypto.createHash('sha256').update(bytes).digest('hex')
    if (!blobExists(h)) {
      await fsp.mkdir(path.dirname(blobFile(h)), { recursive: true, mode: 0o700 })
      const tmp = `${blobFile(h)}.${process.pid}.tmp`
      await fsp.writeFile(tmp, bytes, { mode: 0o600 })
      await fsp.rename(tmp, blobFile(h))
    }
    const prev = st.rows[k]
    st.rows[k] = { h, n: bytes.length, own: { ackAt: macNow, at: Date.now() } }
    if (prev) await collect(st, [prev.h === h ? '' : prev.h, prev.want ?? ''])
    n++
  }
  if (n === 0) return
  await persist(st)
  log.session.info('companion attachments: the Mac took the pasted pictures; they show from here until its copy does', { pictures: n })
}

/** Tests: a fresh state over the files on disk. */
export function _resetCompanionAttachmentCopyForTesting(): void {
  state = null
}

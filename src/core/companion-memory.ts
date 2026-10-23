/**
 * MEMORY.md and USER.md on the cloud companion (stage 4d of
 * docs/plan/walnut-companion-unified-replica.md).
 *
 *   reads    the box's memory reads (`/api/memory/{global,user}`, and
 *            `/api/v1/memory/{global,user}` when the Mac does not answer, which is
 *            what memory_read calls) take the Mac's copy (companion-host-replica.ts,
 *            kind `memory`: the doc objects the Mac's own routes answer with)
 *   writes   a save there is a `memory` record in the companion's journal (the doc,
 *            the text it was made on and the new text, both as blobs); the Mac merges
 *            it three-way (offline-merge/apply-memory.ts), conflicts lettered
 *   overlay  every read shows the pending save, and a save the Mac took until a copy
 *            round from after its ack (or 10 minutes): the box never shows a save
 *            going back
 *
 * The reads take the copy once it is held; a save is a record once the Mac drains
 * `memory` too. A save the box cannot journal (no copy yet, a Mac too old to drain the
 * kind) needs the Mac and is never written to the box's disk, so a copy read never shows
 * a save reverted (the box's disk is not the Mac's memory once git sync stops writing it).
 *
 * Cloud companion only.
 */

import { log } from '../logging/index.js'
import { computeContentHash } from '../utils/file-ops.js'
import { COMPANION_REPLICA_HOME, companionCopyHolds, companionCopyOff, companionHostReplica } from './companion-host-replica.js'
import { companionJournalBlobBody, companionJournalRecords, journalMemory, macDrains } from './companion-journal.js'
import type { JournalRecord } from '../providers/offline-journal-core.js'
import { followerKind } from './server-role.js'

export type MemoryDocName = 'global' | 'user'

/** The doc object the memory routes answer with (web/routes/memory.ts MemoryDoc). */
export interface CopyMemoryDoc {
  path: string
  title: string
  category: 'global'
  content: string
  createdAt: string
  updatedAt: string
  contentHash: string
}

/** The bounded stores stay small; a larger save waits for the Mac. */
const MEMORY_MAX_BYTES = 1024 * 1024
/** A save the Mac took is shown over the copy at most this long without a later round. */
const MEMORY_AWAIT_MS = 10 * 60_000

const FILE_OF: Record<MemoryDocName, { path: string; title: string }> = {
  global: { path: 'MEMORY.md', title: 'Global Memory' },
  user: { path: 'USER.md', title: 'User Profile' },
}

/** Saves the Mac acked: the Mac's clock at the ack and the doc this box showed. */
const awaited = new Map<MemoryDocName, { ackAt: number; at: number; shown: CopyMemoryDoc }>()

export function isMemoryDocName(v: unknown): v is MemoryDocName {
  return v === 'global' || v === 'user'
}

/** The box's memory reads and saves take the copy and the journal (see the file comment). */
export function companionMemoryActive(): boolean {
  return followerKind() === 'companion' && companionCopyHolds('memory') && macDrains('memory')
}

/** Why the box takes no memory save now, or null (it does, or this is not the companion). */
export function companionMemoryBlocked(): { why: 'kind_not_copied' | 'not_kept_here' | 'mac_too_old'; message: string } | null {
  if (followerKind() !== 'companion') return null
  if (companionCopyOff('memory')) return { why: 'not_kept_here', message: 'Your memory is kept only on your Mac, so it is changed there.' }
  if (!companionCopyHolds('memory')) return { why: 'kind_not_copied', message: 'This box keeps no copy of the memory yet; that needs your Mac.' }
  if (!macDrains('memory')) return { why: 'mac_too_old', message: 'Your Mac runs an older Walnut that cannot take a memory change later; it needs your Mac.' }
  return null
}

/** The copy's own doc (the Mac's, as of its last round), or null when it has none. */
function copyDoc(doc: MemoryDocName): CopyMemoryDoc | null {
  const r = companionHostReplica()?.read(COMPANION_REPLICA_HOME, 'memory', doc)
  if (!r) return null
  try {
    const d = JSON.parse(r.body) as Partial<CopyMemoryDoc>
    return typeof d.content === 'string' ? { ...FILE_OF[doc], category: 'global', createdAt: '', updatedAt: '', ...d, contentHash: computeContentHash(d.content) } as CopyMemoryDoc : null
  } catch {
    return null
  }
}

/** The latest pending record of `doc`. */
function pendingOf(doc: MemoryDocName): JournalRecord | undefined {
  let last: JournalRecord | undefined
  for (const r of companionJournalRecords()) if (r.kind === 'memory' && r.doc === doc) last = r
  return last
}

/** A record as the box shows it, over the copy's doc; undefined when its text is gone. */
function shownOf(doc: MemoryDocName, r: JournalRecord): CopyMemoryDoc | undefined {
  const buf = companionJournalBlobBody(r.oursBlob)
  if (!buf) return undefined
  const content = buf.toString('utf8')
  const at = new Date(typeof r.at === 'number' ? r.at : Date.now()).toISOString()
  const base = copyDoc(doc)
  return { ...FILE_OF[doc], category: 'global', createdAt: base?.createdAt || at, ...(base ?? {}), content, updatedAt: at, contentHash: computeContentHash(content) }
}

/** The copy's age on the Mac's clock (ms), or 0. */
function copyAsOf(): number {
  const at = companionHostReplica()?.status(COMPANION_REPLICA_HOME).memory?.asOf
  return at ? Date.parse(at) || 0 : 0
}

/** What the box shows for `doc`: the pending save, else one the Mac took and its copy does not have yet, else the copy. */
export function companionMemoryDoc(doc: MemoryDocName): CopyMemoryDoc | null {
  const r = pendingOf(doc)
  const pending = r ? shownOf(doc, r) : undefined
  if (pending) return pending
  const a = awaited.get(doc)
  if (a) {
    if (copyAsOf() > a.ackAt || Date.now() - a.at > MEMORY_AWAIT_MS) awaited.delete(doc)
    else return a.shown
  }
  return copyDoc(doc)
}

/** The copy's age, for `x-walnut-copy-as-of`. */
export function companionMemoryAsOf(): string | null {
  return companionHostReplica()?.status(COMPANION_REPLICA_HOME).memory?.asOf ?? null
}

export type MemorySaveResult =
  | { ok: true; updatedAt: string; contentHash: string; seq: number }
  | { ok: false; code: string; message: string; detail?: Record<string, unknown> }

/**
 * One save of MEMORY.md or USER.md on the box, checked against what the box shows
 * (`expectedHash` is the memory contentHash, as the disk route checks it) and kept as a
 * `memory` record for the Mac.
 */
export function companionMemorySave(req: { doc: MemoryDocName; content: unknown; expectedHash?: unknown }): MemorySaveResult {
  const blocked = followerKind() === 'companion' ? companionMemoryBlocked() : { why: 'kind_not_copied' as const, message: 'This needs your Mac.' }
  if (blocked) return { ok: false, code: 'needs_leader', message: blocked.message, detail: { why: blocked.why } }
  if (typeof req.content !== 'string') return { ok: false, code: 'bad_request', message: 'content (string) is required' }
  if (Buffer.byteLength(req.content) > MEMORY_MAX_BYTES) return { ok: false, code: 'needs_leader', message: 'A memory document over 1 MB can only be changed on your Mac.', detail: { why: 'memory_too_large' } }
  const current = companionMemoryDoc(req.doc)
  const expected = typeof req.expectedHash === 'string' && req.expectedHash ? req.expectedHash : null
  if (expected && current && current.contentHash !== expected) {
    return { ok: false, code: 'conflict', message: 'Content was modified externally', detail: { currentHash: current.contentHash } }
  }
  const saved = journalMemory({
    doc: req.doc, baseHash: current ? current.contentHash : null,
    base: current ? Buffer.from(current.content, 'utf8') : null, ours: Buffer.from(req.content, 'utf8'), oursHash: computeContentHash(req.content),
  })
  if (!saved) return { ok: false, code: 'needs_leader', message: 'Your Mac runs an older Walnut that cannot take a memory change later; it needs your Mac.', detail: { why: 'mac_too_old' } }
  if (!saved.ok) return { ok: false, code: saved.code, message: saved.message, ...(saved.retryAfterMs !== undefined ? { detail: { retryAfterMs: saved.retryAfterMs } } : {}) }
  // A newer save of an awaited doc is pending again: its record shows it.
  awaited.delete(req.doc)
  return { ok: true, updatedAt: new Date().toISOString(), contentHash: computeContentHash(req.content), seq: saved.seq }
}

/**
 * The Mac acked these memory records (its clock `macNow` once it applied them), before
 * the journal lets them go: each doc is shown as this box last showed it until a copy
 * round from after the ack.
 */
export function companionMemoryAcked(records: JournalRecord[], macNow: number): void {
  let n = 0
  for (const r of records) {
    if (r.kind !== 'memory' || !isMemoryDocName(r.doc)) continue
    // Only the doc's latest record decides what the box shows.
    if (pendingOf(r.doc)?.seq !== r.seq) continue
    const shown = shownOf(r.doc, r)
    if (!shown) continue
    awaited.set(r.doc, { ackAt: macNow, at: Date.now(), shown })
    n++
  }
  if (n) log.session.info('companion memory: the Mac took the memory changes; they show until its copy does', { docs: n })
}

/** Tests: forget what the Mac acked. */
export function _resetCompanionMemoryForTesting(): void {
  awaited.clear()
}

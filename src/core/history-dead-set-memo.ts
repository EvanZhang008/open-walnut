/**
 * The over-ceiling DISPLAY dead-set memo (session-history.ts serveOverCeilingTail), kept in
 * memory and on disk across restarts.
 *
 * A rewound transcript past the reader's byte ceiling cannot be read whole here, so the read
 * asks the session's host daemon for the dead set (transcript.rewindProbe), and the host streams
 * and parses the whole file (3 s for a 154 MB one, 2026-11-25). The answer is a pure function of
 * the file's bytes and the session's recorded cuts, so it is memoized on both: the key holds
 * the file's identity (mtime, size) and a fingerprint of every cut field the probe reads
 * (cutsFingerprint). A hit is therefore right by construction, whatever changed the cuts and
 * whichever process changed them. A drop (invalidateSessionHistoryCaches) still removes a
 * session's entries at once, in memory and on disk.
 *
 * ONLY the display path memoizes. The rewind gate/commit probes keep fresh-read semantics on
 * purpose: they decide what to persist.
 *
 * Disk: WALNUT_HOME/cache/history-dead-sets.json (not synced), written at most every
 * DEAD_SET_SAVE_EVERY_MS after a change, flushed at stop, read back at boot. The server restarts
 * about 70 times a day (one per land), and each restart used to cost the first read of every
 * such session one whole-file probe. The file keeps the newest entries that fit in
 * MAX_FILE_BYTES; an entry that does not fit is left out (logged at warn). A file that does not
 * parse, or carries another version, reads as empty. Only the server starts the disk copy.
 */
import crypto from 'node:crypto'
import path from 'node:path'
import { log } from '../logging/index.js'
import { keptCacheFile, readKeptJson, removeStaleTemps, type KeptCacheFile } from './kept-cache-file.js'
import type { InPlaceRewindCut } from './types.js'
import type { SkippedRewindCut } from './transcript-chain.js'

export interface DisplayDeadSet {
  deadUuids: string[]
  queueDeadKeys: string[]
  skippedCuts: SkippedRewindCut[]
  truncated: boolean
}

const VERSION = 1
const MEMO_MAX = 32
/** Changes inside this make one write. */
export const DEAD_SET_SAVE_EVERY_MS = 10_000
/** The file keeps at most this many bytes; older entries past it are not written. */
export const MAX_DEAD_SET_FILE_BYTES = 4 * 1024 * 1024
/** A read that races the boot's readback waits at most this long for it, then misses. */
const READBACK_WAIT_MS = 2_000

const memo = new Map<string, DisplayDeadSet>()

type CutFields = Pick<InPlaceRewindCut, 'uuid' | 'lastUuidAtCommit' | 'trailingQueueKeys'>

/** Every cut field the probe reads (session-rewind.ts probeRewindViaDaemon), in order, hashed. */
export function cutsFingerprint(cuts: readonly CutFields[]): string {
  const fields = cuts.map((c) => [c.uuid, c.lastUuidAtCommit, c.trailingQueueKeys ?? []])
  return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 24)
}

export const deadSetKey = (
  sessionId: string, host: string | undefined, mtimeMs: number, size: number, cuts: readonly CutFields[],
): string => `${sessionId}|${host ?? '__local__'}|${mtimeMs}|${size}|${cutsFingerprint(cuts)}`

// ── disk copy ──

let kept: KeptCacheFile | null = null
/** The boot's readback while it runs (null: done, or never started). */
let readback: Promise<void> | null = null
/** Sessions dropped while the readback runs: their entries on disk are not taken back. */
let droppedDuringReadback: Set<string> | null = null
let clearedDuringReadback = false

const save = (): void => { kept?.save(diskBody) }

function diskBody(): string | undefined {
  // Newest first until the cap; the size is estimated before any stringify (an entry can hold
  // 200,000 uuids), so an entry left out costs a count, not a serialization.
  const rows: string[] = []
  let bytes = 32
  let left = 0
  for (const [key, value] of [...memo.entries()].reverse()) {
    if (bytes + estimateBytes(key, value) > MAX_DEAD_SET_FILE_BYTES) { left += 1; continue }
    const row = JSON.stringify([key, value])
    if (bytes + row.length + 1 > MAX_DEAD_SET_FILE_BYTES) { left += 1; continue }
    rows.push(row)
    bytes += row.length + 1
  }
  if (left > 0) {
    log.session.warn('rewound transcripts\' dead sets past the file cap are not saved', {
      kept: rows.length, left, maxBytes: MAX_DEAD_SET_FILE_BYTES,
    })
  }
  return `{"v":${VERSION},"entries":[${rows.reverse().join(',')}]}`
}

function estimateBytes(key: string, value: DisplayDeadSet): number {
  let n = key.length + 128 + value.skippedCuts.length * 256
  for (const s of value.deadUuids) n += s.length + 3
  for (const s of value.queueDeadKeys) n += s.length + 3
  return n
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')

function deadSetOf(v: unknown): DisplayDeadSet | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!isStrings(o.deadUuids) || !isStrings(o.queueDeadKeys) || typeof o.truncated !== 'boolean') return null
  if (!Array.isArray(o.skippedCuts) || !o.skippedCuts.every((c) => c && typeof c === 'object')) return null
  return { deadUuids: o.deadUuids, queueDeadKeys: o.queueDeadKeys, skippedCuts: o.skippedCuts as SkippedRewindCut[], truncated: o.truncated }
}

/** The kept file's place: WALNUT_HOME/cache/history-dead-sets.json. */
export async function deadSetDiskFile(): Promise<string> {
  const { WALNUT_HOME } = await import('../constants.js')
  return path.join(WALNUT_HOME, 'cache', 'history-dead-sets.json')
}

/**
 * Read the kept dead sets back and keep writing them from now on. Once per process (the
 * server's boot). Entries set in memory meanwhile win, and stay the most recent.
 */
export async function startDeadSetDisk(file?: string): Promise<void> {
  if (kept) return
  const at = file ?? await deadSetDiskFile()
  kept = keptCacheFile(at, {
    delayMs: DEAD_SET_SAVE_EVERY_MS,
    onError: (err) => log.session.debug('over-ceiling dead sets not saved', { error: err instanceof Error ? err.message : String(err) }),
  })
  droppedDuringReadback = new Set()
  clearedDuringReadback = false
  const run = (async () => {
    const body = await readKeptJson(at, VERSION)
    await removeStaleTemps(at)
    const entries = Array.isArray(body?.entries) ? body.entries : []
    const dropped = droppedDuringReadback
    const restored: Array<[string, DisplayDeadSet]> = []
    if (!clearedDuringReadback) {
      for (const row of entries) {
        if (!Array.isArray(row) || typeof row[0] !== 'string') continue
        const key = row[0]
        const value = deadSetOf(row[1])
        if (!value || key.split('|').length !== 5 || memo.has(key)) continue
        if (dropped?.has(key.slice(0, key.indexOf('|')))) continue
        restored.push([key, value])
      }
    }
    // Older than anything set in memory since the boot: they go in at the LRU's old end.
    const live = [...memo.entries()]
    memo.clear()
    const room = MEMO_MAX - live.length
    for (const [k, v] of room > 0 ? restored.slice(-room) : []) memo.set(k, v)
    for (const [k, v] of live) memo.set(k, v)
    if (restored.length > 0) log.session.info('over-ceiling dead sets read back', { entries: memo.size })
  })()
  const done: Promise<void> = run.catch(() => {}).finally(() => {
    if (readback !== done) return
    readback = null
    droppedDuringReadback = null
  })
  readback = done
  await done
}

/** Write now what is asked (server stop; the caller bounds the wait). */
export async function flushDeadSetDisk(): Promise<void> {
  await kept?.flush()
}

/** Test seam: forget the memory and the kept file handle, as a new process starts with neither. */
export function _stopDeadSetDiskForTesting(): void {
  kept = null
  readback = null
  droppedDuringReadback = null
  memo.clear()
}

// ── memo ──

/** The memoized dead set for `key`, after the boot's readback (bounded wait). */
export async function getDeadSet(key: string): Promise<DisplayDeadSet | undefined> {
  if (readback) await waitBounded(readback, READBACK_WAIT_MS)
  const hit = memo.get(key)
  if (hit) { // LRU touch
    memo.delete(key)
    memo.set(key, hit)
  }
  return hit
}

export function setDeadSet(key: string, value: DisplayDeadSet): void {
  memo.delete(key)
  memo.set(key, value)
  while (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value
    if (oldest === undefined) break
    memo.delete(oldest)
  }
  save()
}

/** Drop every memoized dead set of a session (its cuts changed), in memory and on disk. */
export function dropDeadSets(sessionId: string): void {
  droppedDuringReadback?.add(sessionId)
  const prefix = `${sessionId}|`
  let changed = false
  for (const key of [...memo.keys()]) {
    if (key.startsWith(prefix)) { memo.delete(key); changed = true }
  }
  // A readback still running may hold this session's entries: the next write leaves them out.
  if (changed || droppedDuringReadback) save()
}

/** Drop every memoized dead set, in memory and on disk. */
export function clearDeadSets(): void {
  if (droppedDuringReadback) clearedDuringReadback = true
  memo.clear()
  save()
}

async function waitBounded(p: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([p, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.() })])
  clearTimeout(timer)
}

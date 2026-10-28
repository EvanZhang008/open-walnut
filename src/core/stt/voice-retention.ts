/**
 * Voice recordings are kept for accuracy work, within a limit: once this
 * server holds more than `stt.keep_recordings` (count and size, both stores
 * together: phone takes in the voice archive, web/Mac dictation in
 * tmp/stt-recordings), the oldest go first (2026-10-27, the user: keep "at
 * least a part ... delete the old ones when there are too many"; the Mac's
 * disk had filled that day). Each server judges its own disk: the Mac and the
 * companion keep their own copies and prune them apart.
 *
 * Never removed: a take still being recorded, transcribed or copied (or
 * touched within the hour, or an upload younger than a day), a take with no
 * text yet for a week (its phone may retry it), and on the companion a take the
 * Mac has not received yet, which is that take's only other copy. A removed
 * take leaves a mark, so a copy from the other server is refused (410) rather
 * than bringing it back.
 */

import { log } from '../../logging/index.js'
import type { VoiceArchiveStore, VoiceRecord } from './voice-archive.js'
import { discardRecording, inventoryRecordings } from './recordings.js'

export const DEFAULT_KEEP_COUNT = 1000
export const DEFAULT_KEEP_MB = 1024
const SETTLE_MS = 60 * 60_000
const ABANDONED_MS = 24 * 60 * 60_000
const UNTRANSCRIBED_MS = 7 * 24 * 60 * 60_000
/** A removal mark outlives every copy that could still be trying to bring the take back. */
const MARK_KEEP_MS = 90 * 24 * 60 * 60_000
const DEBOUNCE_MS = 60_000
const SWEEP_MS = 6 * 60 * 60_000

export interface KeepLimits { maxCount: number; maxBytes: number }

/** The limits from config, defaults filling what is unset or not a positive number. */
export function keepLimits(stt: { keep_recordings?: { max_count?: unknown; max_mb?: unknown } } | undefined): KeepLimits {
  const keep = stt?.keep_recordings
  const positive = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  return {
    maxCount: Math.floor(positive(keep?.max_count, DEFAULT_KEEP_COUNT)),
    maxBytes: Math.floor(positive(keep?.max_mb, DEFAULT_KEEP_MB) * 1024 * 1024),
  }
}

interface Entry { at: number; bytes: number; removable: boolean; remove: () => Promise<boolean> }

/** Web recording ids are ISO stamps with `:` and `.` as `-`. */
function stampTime(id: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(id)
  return m ? Date.parse(`${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`) : Number.NaN
}

/** Work on `id` that is running in this server right now: a transcribe, a live take, a copy. */
async function busy(id: string): Promise<boolean> {
  const [{ isTranscribing }, { hasLiveTake }, { isCopying }] = await Promise.all([
    import('./voice-archive-transcribe.js'), import('./live-transcript.js'), import('./voice-archive-replication.js'),
  ])
  return isTranscribing(id) || hasLiveTake(id) || isCopying(id)
}

/** A take may go: settled, quiet, its text kept (or long given up on), and on the companion already on the Mac. */
function takeRemovable(record: VoiceRecord | undefined, modifiedMs: number, now: number, cloud: boolean): boolean {
  const quiet = now - modifiedMs
  if (!record || record.state === 'uploading') return quiet > ABANDONED_MS
  if (quiet <= SETTLE_MS || now - Date.parse(record.createdAt) <= SETTLE_MS) return false
  if (cloud && record.primarySaved !== true) return false
  // A take with no text yet may still be retried by the phone ("your recording remains saved").
  return record.text !== undefined || quiet > UNTRANSCRIBED_MS
}

/** Remove the oldest recordings until both stores together fit the limits. */
export async function pruneVoiceRecordings(limits: KeepLimits, now = Date.now(), given?: VoiceArchiveStore): Promise<{ removed: number; freedBytes: number; kept: number; keptBytes: number }> {
  const store = given ?? (await import('./voice-archive.js')).voiceArchive
  const entries: Entry[] = []
  for (const take of await store.inventory()) {
    const record = take.record
    const at = record ? Date.parse(record.createdAt) : take.modifiedMs
    entries.push({
      at: Number.isFinite(at) ? at : take.modifiedMs,
      bytes: take.bytes,
      removable: takeRemovable(record, take.modifiedMs, now, store.cloud),
      // Judged again under the take's own lock: it may have moved on since.
      remove: async () => !(await busy(take.id)) && store.discard(take.id, (fresh, modifiedMs) => takeRemovable(fresh, modifiedMs, now, store.cloud)),
    })
  }
  for (const rec of await inventoryRecordings()) {
    const at = stampTime(rec.id)
    entries.push({ at: Number.isFinite(at) ? at : rec.modifiedMs, bytes: rec.bytes, removable: now - rec.modifiedMs > SETTLE_MS, remove: async () => { await discardRecording(rec.id); return true } })
  }
  entries.sort((a, b) => a.at - b.at)
  let count = entries.length
  let bytes = entries.reduce((sum, e) => sum + e.bytes, 0)
  let removed = 0
  let freedBytes = 0
  for (const entry of entries) {
    if (count <= limits.maxCount && bytes <= limits.maxBytes) break
    if (!entry.removable || !(await entry.remove())) continue
    count--
    bytes -= entry.bytes
    removed++
    freedBytes += entry.bytes
  }
  await store.forgetRemovedMarks(MARK_KEEP_MS, now)
  return { removed, freedBytes, kept: count, keptBytes: bytes }
}

let timer: ReturnType<typeof setTimeout> | null = null
let sweeper: ReturnType<typeof setInterval> | null = null
let running: Promise<void> | null = null

async function runOnce(): Promise<void> {
  const { getConfig } = await import('../config-manager.js')
  const result = await pruneVoiceRecordings(keepLimits((await getConfig()).stt))
  if (result.removed) {
    log.stt.info(`voice retention removed ${result.removed} oldest recording(s), ${Math.round(result.freedBytes / 1024 / 1024)} MB; ${result.kept} kept (${Math.round(result.keptBytes / 1024 / 1024)} MB)`)
  }
}

/** Prune soon (a new recording landed), and every few hours after. Never throws. */
export function scheduleVoiceRetention(): void {
  if (!sweeper) {
    sweeper = setInterval(() => scheduleVoiceRetention(), SWEEP_MS)
    sweeper.unref?.()
  }
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    if (running) return
    running = runOnce().catch((err) => {
      log.stt.warn(`voice retention failed: ${err instanceof Error ? err.message : String(err)}`)
    }).finally(() => { running = null })
  }, DEBOUNCE_MS)
  timer.unref?.()
}

/** Test hook. */
export function _resetVoiceRetentionForTest(): void {
  if (timer) clearTimeout(timer)
  if (sweeper) clearInterval(sweeper)
  timer = null
  sweeper = null
  running = null
}

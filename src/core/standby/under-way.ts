/**
 * Whether a batch is under way at a standby target, read from the target's own disk only: what the
 * leader's batch writes there before it makes the batch current. Read-only: it opens no lock, writes
 * nothing, and changes no rule of a batch (a batch that is void stays void; this only says one runs).
 *
 *   chunks/<aa>/   each chunk the batch sends lands here (a remote target: staged beside it by the
 *                  daemon's fs.writePart, then renamed), so a chunk dir changes while chunks come
 *   .incoming/     a remote batch's upload, the export its init wrote, and its apply job's status while it
 *                  runs (its heartbeat every 10 s); a status that says done or failed is the end of a batch,
 *                  written just after it landed, and does not count
 *
 * Everything changed after the current batch landed (its committedAt, by this machine's clock, the same
 * clock the files' times are on) belongs to a batch after it: its first such change is when that batch
 * began here, its last says whether it still moves. A batch cut off part way leaves its chunks, and the
 * next batch goes on from them, so "began" is the first of those, which is when the copy started falling
 * behind. A leader's batch that sends nothing new (only a walk of its home) shows nothing here.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { STATUS_FILE, parseStatus } from './apply-status.js'
import { INCOMING } from './receive.js'
import { targetPaths } from './target-files.js'

export interface BatchUnderWay {
  /** The first change after the current batch landed (or, with none current, the first change). */
  since: string
  /** The last change: how recently the batch moved. */
  lastAt: string
  /** Chunk files written since (whole or staged). */
  chunks: number
  /** Their bytes. */
  bytes: number
  /** A remote apply job runs there (its status says running). */
  applying: boolean
}

interface Seen { first: number; last: number; chunks: number; bytes: number; applying: boolean }

async function mtimes(dir: string, after: number, seen: Seen, kind: 'chunk' | 'incoming'): Promise<void> {
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const file = path.join(dir, name)
    const st = await fs.lstat(file).catch(() => null)
    if (!st || st.mtimeMs <= after) continue
    if (kind === 'incoming' && STATUS_FILE.test(name)) {
      if (parseStatus(await fs.readFile(file, 'utf8').catch(() => ''))?.state !== 'running') continue
      seen.applying = true
    }
    seen.first = Math.min(seen.first, st.mtimeMs)
    seen.last = Math.max(seen.last, st.mtimeMs)
    if (kind === 'chunk' && st.isFile()) { seen.chunks++; seen.bytes += st.size }
  }
}

/**
 * The batch under way at target `dir` after the batch that landed at `landedAt` (ISO; null: none yet), or
 * null when nothing changed there since. Its cost is one stat per chunk dir and one per chunk written since.
 */
export async function batchUnderWay(dir: string, landedAt: string | null): Promise<BatchUnderWay | null> {
  const t = targetPaths(path.resolve(dir))
  const after = landedAt ? Date.parse(landedAt) : 0
  const seen: Seen = { first: Infinity, last: -Infinity, chunks: 0, bytes: 0, applying: false }
  // A chunk dir's own time changes when a chunk is staged or renamed into it: only those are read through.
  for (const sub of await fs.readdir(t.chunks).catch(() => [] as string[])) {
    const p = path.join(t.chunks, sub)
    const st = await fs.lstat(p).catch(() => null)
    if (st?.isDirectory() && st.mtimeMs > after) await mtimes(p, after, seen, 'chunk')
  }
  await mtimes(path.join(t.root, INCOMING), after, seen, 'incoming')
  if (!Number.isFinite(seen.first)) return null
  return { since: new Date(seen.first).toISOString(), lastAt: new Date(seen.last).toISOString(), chunks: seen.chunks, bytes: seen.bytes, applying: seen.applying }
}

/**
 * Whether a batch is under way at a standby target, and whether it moves, read from the target's own
 * disk only. Read-only: it opens no lock, writes nothing, and changes no rule of a batch (a batch that is
 * void stays void; this only says what is arriving).
 *
 * Two kinds of trace, after the current batch landed (its committedAt, by this machine's clock, the same
 * clock the files' times are on):
 *
 *   progress   a chunk staged or renamed into chunks/<aa>/ (only a batch that sends content writes one: a
 *              chunk the target holds is never sent again), and an apply job that runs there now (its
 *              status says running, its process lives and its heartbeat is fresh: apply-status.ts
 *              runningApply)
 *   a start    anything else new in .incoming/: the export every remote batch's init writes first, the
 *              upload a commit writes. Every batch leaves one, a batch that sends nothing and a batch that
 *              voids included, so it says that batches still begin, never that one moves
 *
 * The first trace of either kind is when the batch began here (a batch cut off part way leaves its chunks,
 * and the next goes on from them, so it is when the copy started falling behind). A status that says done or
 * failed is the end of a batch, written just after it landed, and is no trace at all.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { STATUS_FILE, runningApply } from './apply-status.js'
import { INCOMING } from './receive.js'
import { targetPaths } from './target-files.js'

export interface BatchUnderWay {
  /** The first trace after the current batch landed (or, with none current, the first trace). */
  since: string
  /** The last trace of progress (a chunk, a running apply's heartbeat), or null: nothing arrived. */
  progressAt: string | null
  /** The last trace of any kind: batches still begin when it is recent, even with no progress. */
  lastAt: string
  /** Chunk files written since (whole or staged). */
  chunks: number
  /** Their bytes. */
  bytes: number
  /** When the apply job that runs there now started (apply-status.ts runningApply), or null: none runs. */
  applyingSince: string | null
}

interface Seen { first: number; progress: number; last: number; chunks: number; bytes: number }

const see = (seen: Seen, t: number, progress: boolean) => {
  seen.first = Math.min(seen.first, t)
  seen.last = Math.max(seen.last, t)
  if (progress) seen.progress = Math.max(seen.progress, t)
}

/**
 * The batch under way at target `dir` after the batch that landed at `landedAt` (ISO, by this machine's clock;
 * null: no batch landed yet, every trace counts), or null when there is no trace since. Its cost is one stat per
 * chunk dir, one per chunk written since and one per file in .incoming/.
 */
export async function batchUnderWay(dir: string, landedAt: string | null, now = Date.now()): Promise<BatchUnderWay | null> {
  const t = targetPaths(path.resolve(dir))
  const after = landedAt ? Date.parse(landedAt) : 0
  const seen: Seen = { first: Infinity, progress: -Infinity, last: -Infinity, chunks: 0, bytes: 0 }
  // A chunk dir's own time changes when a chunk is staged or renamed into it: only those are read through.
  for (const sub of await fs.readdir(t.chunks).catch(() => [] as string[])) {
    const p = path.join(t.chunks, sub)
    const st = await fs.lstat(p).catch(() => null)
    if (!st?.isDirectory() || st.mtimeMs <= after) continue
    for (const name of await fs.readdir(p).catch(() => [] as string[])) {
      const c = await fs.lstat(path.join(p, name)).catch(() => null)
      if (!c?.isFile() || c.mtimeMs <= after) continue
      see(seen, c.mtimeMs, true)
      seen.chunks++
      seen.bytes += c.size
    }
  }
  const incoming = path.join(t.root, INCOMING)
  const applying = await runningApply(incoming, now)
  if (applying) {
    const started = Date.parse(applying.startedAt)
    if (started > after) see(seen, started, false)
    see(seen, Date.parse(applying.at), true)
  }
  for (const name of await fs.readdir(incoming).catch(() => [] as string[])) {
    if (STATUS_FILE.test(name)) continue
    const st = await fs.lstat(path.join(incoming, name)).catch(() => null)
    if (st && st.mtimeMs > after) see(seen, st.mtimeMs, false)
  }
  if (!Number.isFinite(seen.first)) return null
  const iso = (x: number) => new Date(x).toISOString()
  return { since: iso(seen.first), progressAt: Number.isFinite(seen.progress) ? iso(seen.progress) : null, lastAt: iso(seen.last), chunks: seen.chunks, bytes: seen.bytes, applyingSince: applying ? applying.startedAt : null }
}

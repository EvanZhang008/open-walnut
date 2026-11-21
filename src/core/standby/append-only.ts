/**
 * Files the manifest marks `appendOnly` (src/core/home-manifest/): logs that only ever grow,
 * many of them written by code the write gate does not hold (appendFile, other processes). Such
 * a file changes after a batch's moment almost every time, so the general rule (stage.ts) would
 * void the batch. Instead, its size (cut back to its last whole line) and inode are noted in the
 * hold, just before the moment (`markAppendOnly`), with the hash of its last few KiB; the batch
 * then takes its first that many bytes (`stagePrefix`), its content then, as long as it only grew:
 *   - same inode, and at least that size, before and after the read;
 *   - the noted tail still hashes the same after the read;
 *   - when the last batch holds the same inode, its first (last batch's size) bytes still hash
 *     to the last batch's content.
 * A replaced file (a compacted copy renamed over it: a new inode) is taken as the new file. Any
 * other change (cut, rewritten where it was checked) hands the file to the general rule
 * (stage.ts): taken if it was quiet since before the moment, else the batch is void. Not caught:
 * a rewrite in place, after the mark, of bytes between the last batch's end (the file's start,
 * when the last batch has no copy of this inode) and the noted tail.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { digestFile, type ChunkSink } from './chunks.js'
import { sameStat, toSourceStat } from './scan.js'
import type { StageOutcome } from './stage.js'
import type { BatchFile, SourceStat } from './types.js'

const TAIL_BYTES = 4096

export interface AppendMark {
  /** The file's stat when it was marked (its whole size, for the next batch's change check). */
  st: SourceStat
  x: boolean
  /** The batch takes the first `cut` bytes: the size, cut back to the end of its last whole line. */
  cut: number
  /** sha256 of bytes [tailFrom, cut). Absent when the file is as in the last batch (nothing is read). */
  tail?: string
  tailFrom: number
}

async function readRange(abs: string, from: number, to: number): Promise<Buffer | null> {
  const fh = await fs.open(abs, 'r').catch(() => null)
  if (!fh) return null
  try {
    const buf = Buffer.alloc(to - from)
    let filled = 0
    while (filled < buf.length) {
      const { bytesRead } = await fh.read(buf, filled, buf.length - filled, from + filled)
      if (!bytesRead) return null
      filled += bytesRead
    }
    return buf
  } finally {
    await fh.close()
  }
}

async function hashRange(abs: string, from: number, to: number): Promise<string | null> {
  const buf = await readRange(abs, from, to)
  return buf && crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * Note an append-only file's size, inode and tail now (in the hold, before the moment). An
 * appender outside the gate may be in the middle of a write, so the size is cut back to the end
 * of the last whole line in the tail (every marked file is line-based); a tail with no line end
 * keeps the size. A file whose stat is `unchanged` (the last batch's) is not read at all.
 */
export async function markAppendOnly(abs: string, unchanged?: SourceStat): Promise<AppendMark | null> {
  const st = await fs.lstat(abs).catch(() => null)
  if (!st?.isFile()) return null
  const src = toSourceStat(st)
  const x = (st.mode & 0o111) !== 0
  if (unchanged && sameStat(src, unchanged)) return { st: src, x, cut: st.size, tailFrom: st.size }
  const tailFrom = Math.max(0, st.size - TAIL_BYTES)
  const buf = await readRange(abs, tailFrom, st.size)
  if (buf === null) return null
  const end = buf.lastIndexOf(0x0a)
  const kept = end >= 0 ? buf.subarray(0, end + 1) : buf
  const tail = crypto.createHash('sha256').update(kept).digest('hex')
  return { st: src, x, cut: tailFrom + kept.length, tail, tailFrom }
}

/** Take the first `mark.cut` bytes of an append-only file, proven to be its content when marked. */
export async function stagePrefix(home: string, rel: string, mark: AppendMark, last: BatchFile | undefined, sink: ChunkSink): Promise<StageOutcome> {
  const abs = path.join(home, rel)
  if (mark.tail === undefined) return { ok: false, rel, why: 'changed', detail: 'marked as unchanged' }
  const grownOnly = (st: import('node:fs').Stats | null) => !!st && st.isFile() && st.ino === mark.st.i && st.size >= mark.cut
  const before = await fs.lstat(abs).catch(() => null)
  if (!before) return { ok: false, rel, why: 'gone' }
  if (!grownOnly(before)) return { ok: false, rel, why: 'changed', detail: 'an append-only file was replaced or cut since it was marked' }
  const sameFile = !!last && last.src.i === mark.st.i
  if (sameFile && last!.size > mark.cut) return { ok: false, rel, why: 'changed', detail: 'an append-only file is shorter than in the last batch' }
  let read: Awaited<ReturnType<typeof digestFile>>
  try {
    read = await digestFile(abs, sink, { limit: mark.cut, ...(sameFile ? { markAt: last!.size } : {}) })
  } catch (err) {
    return { ok: false, rel, why: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unreadable', detail: String(err) }
  }
  if (read.size !== mark.cut) return { ok: false, rel, why: 'changed', detail: 'an append-only file was cut while it was read' }
  if (sameFile && read.markHash !== last!.h) return { ok: false, rel, why: 'changed', detail: 'an append-only file was rewritten in place since the last batch' }
  if (await hashRange(abs, mark.tailFrom, mark.cut) !== mark.tail) return { ok: false, rel, why: 'changed', detail: 'an append-only file was rewritten in place since it was marked' }
  if (!grownOnly(await fs.lstat(abs).catch(() => null))) return { ok: false, rel, why: 'changed', detail: 'an append-only file was replaced or cut while it was read' }
  return { ok: true, rel, st: mark.st, x: mark.x, h: read.h, size: read.size, chunks: read.chunks }
}

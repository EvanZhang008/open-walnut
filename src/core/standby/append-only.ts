/**
 * Files the manifest marks `appendOnly` (src/core/home-manifest/): logs that only ever grow,
 * many of them written by code the write gate does not hold (appendFile, other processes). Such
 * a file changes after a batch's moment almost every time, so the general rule (stage.ts) would
 * void the batch. Instead, its size and inode are noted in the hold, just before the moment
 * (`markAppendOnly`), with the hash of its last few KiB; the batch then takes its first that
 * many bytes (`stagePrefix`), which are its content then, as long as it only grew:
 *   - same inode, and at least that size, before and after the read;
 *   - the noted tail still hashes the same after the read;
 *   - when the last batch holds the same inode, its first (last batch's size) bytes still hash
 *     to the last batch's content.
 * A replaced file (a compacted copy renamed over it: a new inode) is taken as the new file. Any
 * other change (cut, rewritten where it was checked) hands the file to the general rule
 * (stage.ts): taken if it was quiet since before the moment, else the batch is void. Not caught:
 * a rewrite in place, after the mark, of bytes between the last batch's end and the noted tail.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { digestFile, type ChunkSink } from './chunks.js'
import { toSourceStat } from './scan.js'
import type { StageOutcome } from './stage.js'
import type { BatchFile, SourceStat } from './types.js'

const TAIL_BYTES = 4096

export interface AppendMark {
  /** The file's stat when it was marked: the batch takes its first `st.s` bytes. */
  st: SourceStat
  x: boolean
  /** sha256 of bytes [tailFrom, st.s). */
  tail: string
  tailFrom: number
}

async function hashRange(abs: string, from: number, to: number): Promise<string | null> {
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
    return crypto.createHash('sha256').update(buf).digest('hex')
  } finally {
    await fh.close()
  }
}

/** Note an append-only file's size, inode and tail now (in the hold, before the moment). */
export async function markAppendOnly(abs: string): Promise<AppendMark | null> {
  const st = await fs.lstat(abs).catch(() => null)
  if (!st?.isFile()) return null
  const tailFrom = Math.max(0, st.size - TAIL_BYTES)
  const tail = await hashRange(abs, tailFrom, st.size)
  if (tail === null) return null
  return { st: toSourceStat(st), x: (st.mode & 0o111) !== 0, tail, tailFrom }
}

/** Take the first `mark.st.s` bytes of an append-only file, proven to be its content when marked. */
export async function stagePrefix(home: string, rel: string, mark: AppendMark, last: BatchFile | undefined, sink: ChunkSink): Promise<StageOutcome> {
  const abs = path.join(home, rel)
  const grownOnly = (st: import('node:fs').Stats | null) => !!st && st.isFile() && st.ino === mark.st.i && st.size >= mark.st.s
  const before = await fs.lstat(abs).catch(() => null)
  if (!before) return { ok: false, rel, why: 'gone' }
  if (!grownOnly(before)) return { ok: false, rel, why: 'changed', detail: 'an append-only file was replaced or cut since it was marked' }
  const sameFile = !!last && last.src.i === mark.st.i
  if (sameFile && last!.size > mark.st.s) return { ok: false, rel, why: 'changed', detail: 'an append-only file is shorter than in the last batch' }
  let read: Awaited<ReturnType<typeof digestFile>>
  try {
    read = await digestFile(abs, sink, { limit: mark.st.s, ...(sameFile ? { markAt: last!.size } : {}) })
  } catch (err) {
    return { ok: false, rel, why: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unreadable', detail: String(err) }
  }
  if (read.size !== mark.st.s) return { ok: false, rel, why: 'changed', detail: 'an append-only file was cut while it was read' }
  if (sameFile && read.markHash !== last!.h) return { ok: false, rel, why: 'changed', detail: 'an append-only file was rewritten in place since the last batch' }
  if (await hashRange(abs, mark.tailFrom, mark.st.s) !== mark.tail) return { ok: false, rel, why: 'changed', detail: 'an append-only file was rewritten in place since it was marked' }
  if (!grownOnly(await fs.lstat(abs).catch(() => null))) return { ok: false, rel, why: 'changed', detail: 'an append-only file was replaced or cut while it was read' }
  return { ok: true, rel, st: mark.st, x: mark.x, h: read.h, size: read.size, chunks: read.chunks }
}

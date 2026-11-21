/**
 * Take one plain file of the leader into a batch, and prove what was taken is the file as it
 * was at the batch's moment.
 *
 * The file is read once, in chunks (chunks.ts); each chunk goes to `sink` as it is read (kept
 * in memory during the hold, sent at once after it). The rule (docs/reference/standby-copy.md,
 * "One moment"): what was read counts only when
 *   1. before the read, the file's ctime is older than the moment, read on the filesystem's
 *      own clock (so its last change came before the moment: no program can set a ctime), and
 *   2. after the read, its size, mtime, ctime and inode are what they were before, and the
 *      bytes read are as many as its size.
 * Then nothing changed it from before the moment until the read ended, so the chunks are its
 * content at the moment. Anything else is `late` (it changed at or after the moment) or
 * `changed` (it changed while it was read): the caller voids the batch. Chunks a void read
 * already sent are harmless: no batch names them, and a deep verify removes them.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { digestFile, type ChunkSink } from './chunks.js'
import { sameStat, toSourceStat } from './scan.js'
import type { SourceStat } from './types.js'

export type StageOutcome =
  | { ok: true; rel: string; st: SourceStat; x: boolean; h: string; size: number; chunks: string[] }
  | { ok: false; rel: string; why: 'late' | 'changed' | 'gone' | 'unreadable' | 'not-a-file'; detail?: string }

export interface StageContext {
  home: string
  /** The batch's moment on the filesystem's clock (batch.ts fsClock): a ctime must be below it. */
  momentMs: number
  /** Test hook: runs after the read, before the check. */
  afterCopy?: (rel: string) => Promise<void> | void
}

export async function stageFile(rel: string, ctx: StageContext, sink: ChunkSink): Promise<StageOutcome> {
  const abs = path.join(ctx.home, rel)
  let before: import('node:fs').Stats
  try {
    before = await fs.lstat(abs)
  } catch (err) {
    return { ok: false, rel, why: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unreadable', detail: String(err) }
  }
  if (!before.isFile()) return { ok: false, rel, why: 'not-a-file' }
  if (before.ctimeMs >= ctx.momentMs) return { ok: false, rel, why: 'late' }
  let read: Awaited<ReturnType<typeof digestFile>>
  try {
    read = await digestFile(abs, sink)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { ok: false, rel, why: code === 'ENOENT' ? 'gone' : 'unreadable', detail: String(err) }
  }
  await ctx.afterCopy?.(rel)
  const after = await fs.lstat(abs).catch(() => null)
  const st = toSourceStat(before)
  if (!after || !sameStat(st, toSourceStat(after)) || read.size !== before.size) return { ok: false, rel, why: 'changed' }
  return { ok: true, rel, st, x: (before.mode & 0o111) !== 0, h: read.h, size: read.size, chunks: read.chunks }
}

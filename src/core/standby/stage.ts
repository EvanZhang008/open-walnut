/**
 * Copy one plain file of the leader into a batch's staging area, and prove the copy is the
 * file as it was at the batch's moment.
 *
 * The rule (docs/reference/standby-copy.md, "One moment"): a copy counts only when
 *   1. before the copy, the file's ctime is older than the moment, read on the filesystem's
 *      own clock (so its last change came before the moment: no program can set a ctime), and
 *   2. after the copy, its size, mtime, ctime and inode are what they were before, and its
 *      content hashes to what was copied.
 * Then nothing changed it from before the moment until the copy ended, so the copy is its
 * content at the moment. Anything else is `late` (it changed at or after the moment) or
 * `changed` (it changed while it was copied): the caller voids the batch.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { digestFile, hashFile } from './chunks.js'
import { sameStat, toSourceStat } from './scan.js'
import type { SourceStat } from './types.js'

export type StageOutcome =
  | { ok: true; rel: string; staged: string; st: SourceStat; x: boolean; h: string; size: number; chunks: string[]; lengths: number[] }
  | { ok: false; rel: string; why: 'late' | 'changed' | 'gone' | 'unreadable' | 'not-a-file'; detail?: string }

export interface StageContext {
  home: string
  stagingDir: string
  /** The batch's moment on the filesystem's clock (batch.ts fsClock): a ctime must be below it. */
  momentMs: number
  /** Test hook: runs after the copy, before the checks. */
  afterCopy?: (rel: string) => Promise<void> | void
}

export async function stageFile(rel: string, ctx: StageContext): Promise<StageOutcome> {
  const abs = path.join(ctx.home, rel)
  const staged = path.join(ctx.stagingDir, 'files', rel)
  let before: import('node:fs').Stats
  try {
    before = await fs.lstat(abs)
  } catch (err) {
    return { ok: false, rel, why: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'gone' : 'unreadable', detail: String(err) }
  }
  if (!before.isFile()) return { ok: false, rel, why: 'not-a-file' }
  if (before.ctimeMs >= ctx.momentMs) return { ok: false, rel, why: 'late' }
  try {
    await fs.mkdir(path.dirname(staged), { recursive: true })
    await fs.copyFile(abs, staged)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return { ok: false, rel, why: code === 'ENOENT' ? 'gone' : 'unreadable', detail: String(err) }
  }
  await ctx.afterCopy?.(rel)
  let after: import('node:fs').Stats
  let source: { size: number; h: string }
  let copy: Awaited<ReturnType<typeof digestFile>>
  try {
    source = await hashFile(abs)
    after = await fs.lstat(abs)
    copy = await digestFile(staged)
  } catch (err) {
    return { ok: false, rel, why: 'changed', detail: String(err) }
  }
  const st = toSourceStat(before)
  if (!sameStat(st, toSourceStat(after)) || source.h !== copy.h || copy.size !== before.size) {
    return { ok: false, rel, why: 'changed' }
  }
  return { ok: true, rel, staged, st, x: (before.mode & 0o111) !== 0, h: copy.h, size: copy.size, chunks: copy.chunks, lengths: copy.lengths }
}

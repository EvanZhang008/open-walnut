/**
 * Before a commit's swap (target.ts): save what was changed directly in the copy at each path
 * the swap is about to replace or remove, into drift/<time>-commit/ (drift.ts), so a hand edit
 * on the standby is never lost silently.
 *
 * The last batch's own shape is not an edit: a file of it where this batch needs a dir (the
 * batch deletes it first), and a dir of it (one a file lay under, or one it listed) where this
 * batch puts a file (its deletes empty it first; swapIn removes it).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { dirsAbove, keptDirs } from './batch-dirs.js'
import { hashFile } from './chunks.js'
import { DriftRecorder } from './drift.js'
import { FILE_MODE, closeDirs, copyStatOf, openDirs, readCopyStats, type TargetPaths } from './target-files.js'
import type { BatchFile } from './types.js'

export interface JournalStep {
  p: string
  op: 'put' | 'del'
  /** The path held a file of the previous batch. */
  existed: boolean
}

export async function saveDirectEdits(t: TargetPaths, steps: JournalStep[], before: Map<string, BatchFile>, dirsBefore: string[], batch: number): Promise<void> {
  const stats = await readCopyStats(t)
  const rec = new DriftRecorder(t, new Date(), '-commit')
  const opened = new Set<string>()
  let ownDirs: Set<string> | null = null
  const isOwnDir = (rel: string) => (ownDirs ??= new Set([...keptDirs(dirsBefore), ...dirsAbove(before.keys())])).has(rel)
  const aside = async (rel: string, kind: 'added' | 'modified', detail: string) => {
    await openDirs(t.copy, rel, opened)
    rec.add({ p: rel, kind, detail, saved: await rec.save(rel, 'move') })
  }
  try {
    for (const step of steps) {
      const parts = step.p.split('/')
      let blocked = false
      for (let i = 1; i < parts.length && !blocked; i++) {
        const rel = parts.slice(0, i).join('/')
        const st = await fs.lstat(path.join(t.copy, rel)).catch(() => null)
        if (!st) break
        if (st.isDirectory()) continue
        // The last batch's file where this one needs a dir: this batch's delete of it comes first.
        if (before.has(rel)) break
        await aside(rel, 'added', 'not a dir, on the way to a file of the batch')
        blocked = true
      }
      if (blocked) continue
      const abs = path.join(t.copy, step.p)
      const st = await fs.lstat(abs).catch(() => null)
      const prev = before.get(step.p)
      if (!st) continue
      if (st.isDirectory() && !prev && isOwnDir(step.p)) continue
      if (!st.isFile() || !prev) {
        await aside(step.p, prev ? 'modified' : 'added', 'found in the copy where this batch writes')
        continue
      }
      const was = stats[step.p]
      const now = copyStatOf(st)
      if (was && was.every((v, i) => v === now[i])) continue
      const got = await hashFile(abs).catch(async () => {
        await fs.chmod(abs, FILE_MODE).catch(() => {})
        return hashFile(abs).catch(() => null)
      })
      if (got && got.h === prev.h && got.size === prev.size) continue
      if (!got) { await aside(step.p, 'modified', 'unreadable in the copy; replaced by this batch'); continue }
      await openDirs(t.copy, step.p, opened)
      rec.add({ p: step.p, kind: 'modified', detail: 'changed in the copy; replaced by this batch', saved: await rec.save(step.p, 'copy') })
    }
  } finally {
    await closeDirs(opened)
  }
  await rec.write(batch)
}

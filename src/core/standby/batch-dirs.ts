/**
 * The dirs a batch lists (types.ts BatchManifest.dirs) and how a copy keeps them.
 *
 * A batch is the home as of one moment, its dirs included: a leader dir that existed at the
 * moment is in the copy even when it holds no file (git's `.git/refs/heads` and `refs/tags` once
 * `git gc` packed every ref; without `.git/refs` git does not count `.git` as a repository at
 * all). A file of the batch implies every dir above it, so a batch lists only the deepest dirs
 * no file lies under.
 *
 * Whether a dir existed at the moment is its parent's names at the moment (moment-names.ts),
 * as for a file. One that cannot be told (its parent changed in git's object store at the
 * moment) is taken while it is there after the moment: an empty dir more is one no reader
 * misses, and an empty dir less is what this list is for.
 */
import path from 'node:path'
import { homePathClass } from '../home-manifest/index.js'
import type { MomentNames } from './moment-names.js'
import type { ScanResult } from './scan.js'
import { closeDirs, openDirs, pruneEmptyParents, removeEmptyDirs } from './target-files.js'

const parentOf = (rel: string): string => {
  const d = path.posix.dirname(rel)
  return d === '.' ? '' : d
}

/** Every dir above each of `paths` (not the paths themselves). */
export function dirsAbove(paths: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const rel of paths) for (let d = parentOf(rel); d && !out.has(d); d = parentOf(d)) out.add(d)
  return out
}

/** The batch's dirs: leader dirs of the moment no file of the batch lies under, the deepest only, sorted. */
export function momentDirs(names: MomentNames, s1: ScanResult, s2: ScanResult, files: Iterable<string>): string[] {
  const covered = dirsAbove(files)
  const dirs: string[] = []
  for (const rel of new Set([...s1.dirs.keys(), ...s2.dirs.keys()])) {
    // The home itself, a dir a file lies under, and a dir the walk entered only because a
    // leader path lies below it (not leader data itself) are not listed.
    if (!rel || covered.has(rel) || homePathClass(rel) !== 'leader-data') continue
    const existed = names.existed(rel)
    if (existed === false || (existed === null && !s2.dirs.has(rel))) continue
    dirs.push(rel)
  }
  const above = dirsAbove(dirs)
  return dirs.filter((d) => !above.has(d)).sort()
}

/** Whether two batches list the same dirs (absent is none). */
export function sameDirs(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((d, i) => d === y[i])
}

/** The dirs a copy keeps whatever its files: the batch's and every dir above them. */
export function keptDirs(dirs: readonly string[]): Set<string> {
  return new Set([...dirs, ...dirsAbove(dirs)])
}

/**
 * After a commit: remove from the copy the dirs the last batch listed and this one does not,
 * while they hold nothing (a dir a file of this batch lies under, or one it lists, stays). A
 * removal that fails leaves an empty dir, which verify removes.
 */
export async function removeStaleDirs(copyRoot: string, dirsBefore: readonly string[], keep: Set<string>, files: Iterable<string>): Promise<void> {
  const stale = dirsBefore.filter((d) => !keep.has(d))
  if (!stale.length) return
  for (const d of dirsAbove(files)) keep.add(d)
  const opened = new Set<string>()
  for (const d of stale.filter((x) => !keep.has(x))) {
    await openDirs(copyRoot, d, opened)
      .then(() => removeEmptyDirs(path.join(copyRoot, d)))
      .then(() => pruneEmptyParents(copyRoot, d, keep))
      .catch(() => {})
  }
  await closeDirs(opened)
}

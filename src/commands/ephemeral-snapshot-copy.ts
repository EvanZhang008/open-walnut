/**
 * How the `web --ephemeral` snapshot is written: copy-on-write when the volume can,
 * else a real copy kept under a size cap.
 *
 * 2026-11-04: one snapshot was a full 6.15 GB copy of the data dir (notes 3.7 GB,
 * plugin-data 0.8 GB), and with one test server left running the Mac's disk ran full.
 * On APFS (and btrfs, or XFS with reflink) a clone costs no space until a file
 * changes, so the snapshot keeps every note at almost no cost. Bun clones with
 * COPYFILE_FICLONE_FORCE (measured: 400 MB of notes cost 0 bytes) and fails where the
 * volume cannot; node's plain COPYFILE_FICLONE never clones on macOS and its FORCE
 * answers ENOSYS there, so a node launcher takes the capped copy. One probe file decides. Without clones the snapshot copies what a test
 * needs and leaves the largest other top-level folders out (made empty) until it fits
 * the cap, and says which.
 */

import fs from 'node:fs'
import path from 'node:path'

export type SnapshotCopyOptions = {
  /** Force the mode (tests); by default one probe file decides. */
  clone?: boolean
  /** Real bytes a copy may take; default copyCapBytes(). */
  capBytes?: number
  warn?: (line: string) => void
}

export type SnapshotReport = {
  mode: 'clone' | 'copy'
  /** Bytes written as a real copy (0 for clones). */
  copiedBytes: number
  capBytes: number
  /** Top-level folders a copy left out (made empty) to stay under the cap. */
  skipped: { entry: string; bytes: number }[]
  /** Set when cloning failed part way and the rest was copied. */
  cloneError?: string
}

export const DEFAULT_COPY_CAP_MB = 2048

/**
 * Top-level folders a test server needs to look like the real Walnut: never left out
 * for size. Plugin data stays too: plugins load in a test server with the real
 * settings, and one that finds its state gone may start a first-run backfill against
 * the real account.
 */
export const SNAPSHOT_KEEP_TOP_LEVEL = new Set([
  'tasks', 'sessions', 'memory', 'boards', 'org', 'plugins', 'plugin-data', 'plugin-stores',
  'hooks', 'triggers', 'skills', 'agents',
])

/** WALNUT_EPHEMERAL_COPY_CAP_MB; `0` means no cap. */
export function copyCapBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WALNUT_EPHEMERAL_COPY_CAP_MB?.trim()
  if (raw === '0') return Number.POSITIVE_INFINITY
  const mb = raw && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_COPY_CAP_MB
  return mb * 1024 * 1024
}

function firstFile(dir: string, filter: (src: string) => boolean, depth: number): string | null {
  let entries: fs.Dirent[] = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isFile() && filter(full)) return full
  }
  if (depth <= 0) return null
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory() && filter(full)) {
      const found = firstFile(full, filter, depth - 1)
      if (found) return found
    }
  }
  return null
}

/** True when a file of `home` clones into `dest` (same volume, a volume that clones). */
export function canClone(home: string, dest: string, filter: (src: string) => boolean): boolean {
  const src = firstFile(home, filter, 2)
  if (!src) return false
  const probe = path.join(dest, `.clone-probe-${process.pid}`)
  try {
    fs.copyFileSync(src, probe, fs.constants.COPYFILE_FICLONE_FORCE)
    return true
  } catch {
    return false
  } finally {
    try { fs.rmSync(probe, { force: true }) } catch { /* best-effort */ }
  }
}

function treeBytes(p: string, filter: (src: string) => boolean): number {
  let st: fs.Stats
  try { st = fs.lstatSync(p) } catch { return 0 }
  if (!st.isDirectory()) return st.isFile() ? st.size : 0
  let total = 0
  let names: string[] = []
  try { names = fs.readdirSync(p) } catch { return 0 }
  for (const n of names) {
    const full = path.join(p, n)
    if (filter(full)) total += treeBytes(full, filter)
  }
  return total
}

/** Bytes a copy would write, per top-level entry the filter keeps. */
export function measureTopLevel(home: string, filter: (src: string) => boolean): Map<string, number> {
  const sizes = new Map<string, number>()
  let names: string[] = []
  try { names = fs.readdirSync(home) } catch { return sizes }
  for (const n of names) {
    const full = path.join(home, n)
    if (filter(full)) sizes.set(n, treeBytes(full, filter))
  }
  return sizes
}

const gb = (b: number) => b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`

export function copySnapshotTree(home: string, dest: string, filter: (src: string) => boolean, opts: SnapshotCopyOptions = {}): SnapshotReport {
  const warn = opts.warn ?? ((line: string) => process.stderr.write(`ephemeral: ${line}\n`))
  const cap = opts.capBytes ?? copyCapBytes()
  fs.mkdirSync(dest, { recursive: true })
  let cloneError: string | undefined
  if (opts.clone ?? canClone(home, dest, filter)) {
    try {
      fs.cpSync(home, dest, { recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE_FORCE, filter })
      return { mode: 'clone', copiedBytes: 0, capBytes: cap, skipped: [] }
    } catch (err) {
      // A full disk is not a reason to write a real copy onto it.
      if ((err as NodeJS.ErrnoException).code === 'ENOSPC') throw err
      cloneError = err instanceof Error ? err.message : String(err)
      warn(`copy-on-write stopped part way (${cloneError}); copying the rest`)
    }
  }

  const sizes = measureTopLevel(home, filter)
  let total = [...sizes.values()].reduce((a, b) => a + b, 0)
  const skipped: SnapshotReport['skipped'] = []
  if (total > cap) {
    const droppable = [...sizes]
      .filter(([entry]) => !SNAPSHOT_KEEP_TOP_LEVEL.has(entry) && fs.lstatSync(path.join(home, entry)).isDirectory())
      .sort((a, b) => b[1] - a[1])
    for (const [entry, bytes] of droppable) {
      if (total <= cap) break
      skipped.push({ entry, bytes })
      total -= bytes
    }
  }
  const skip = new Set(skipped.map((s) => s.entry))
  fs.cpSync(home, dest, {
    recursive: true,
    verbatimSymlinks: true,
    // After a partial clone, keep what was cloned; copy only what is missing.
    force: cloneError === undefined,
    filter: (src: string) => {
      const top = path.relative(home, src).split(path.sep)[0]
      if (top && skip.has(top)) return false
      return filter(src)
    },
  })
  for (const s of skipped) {
    // After a partial clone a left-out folder may hold part of itself: make it empty, as reported.
    fs.rmSync(path.join(dest, s.entry), { recursive: true, force: true })
    fs.mkdirSync(path.join(dest, s.entry), { recursive: true })
  }
  if (skipped.length > 0) {
    const list = skipped.map((s) => `${s.entry} (${gb(s.bytes)})`).join(', ')
    const limit = Number.isFinite(cap) ? gb(cap) : 'no'
    warn(`this volume cannot copy-on-write, so the snapshot is a real copy: left out ${list} (empty in the snapshot) to stay under the ${limit} cap. WALNUT_EPHEMERAL_COPY_CAP_MB sets the cap in MB, 0 copies everything.`)
  }
  return { mode: 'copy', copiedBytes: total, capBytes: cap, skipped, ...(cloneError ? { cloneError } : {}) }
}

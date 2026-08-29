/**
 * Registry + reaper for `web --ephemeral` snapshot dirs.
 *
 * Snapshot dirs are created under os.tmpdir(), which honours TMPDIR — so a caller
 * that overrides TMPDIR puts its snapshot somewhere a later os.tmpdir() scan would
 * never look again. Measured 2026-08-27: 9.8G stranded for 5 days under
 * TMPDIR=/tmp/<slug>/eph, two levels below /tmp, invisible to any top-level scan,
 * because the launcher was killed mid-copy (an agent Bash timeout) and so never
 * reached its own cleanup. Every snapshot therefore records itself here, at a path
 * derived from WALNUT_HOME rather than from TMPDIR, so cleanup stays reachable no
 * matter where the dir was born.
 *
 * The registry is a cleanup HINT, never authoritative data: a missing or corrupt
 * file degrades to "scan os.tmpdir() only", which is the old behaviour, not an
 * error. Nothing here should ever throw into the launcher's path.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/**
 * Registry path relative to WALNUT_HOME. Sits under tmp/ because the snapshot
 * filter in web.ts already excludes that dir, so the registry can never copy
 * itself into a snapshot.
 */
export const EPHEMERAL_REGISTRY_REL = path.join('tmp', 'ephemeral-registry.json')

/** Drop registry rows older than this even if the dir is somehow still there. */
export const REGISTRY_ROW_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Hard cap so a registry that fails to prune can never grow without bound. */
export const REGISTRY_MAX_ROWS = 200

/** A snapshot with no control file is reaped once it is older than this. */
export const NO_CONTROL_FILE_GRACE_MS = 60 * 60 * 1000

export type RegistryRow = { dir: string, launcherPid: number, createdAt: number }

/** Registry lives at a fixed path so cleanup never depends on the current TMPDIR. */
export function registryPath(walnutHome: string): string {
  return path.join(walnutHome, EPHEMERAL_REGISTRY_REL)
}

export function readRegistry(registryFile: string): RegistryRow[] {
  try {
    const rows = JSON.parse(fs.readFileSync(registryFile, 'utf-8'))
    if (!Array.isArray(rows)) return []
    return rows.filter((r): r is RegistryRow =>
      r && typeof r.dir === 'string' && typeof r.createdAt === 'number')
  } catch {
    // Missing or corrupt — a cleanup hint, never authoritative data. Start over.
    return []
  }
}

/** Atomic so a concurrent launcher can never read a half-written registry. */
export function writeRegistry(registryFile: string, rows: RegistryRow[]): void {
  try {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true })
    const capped = rows.slice(-REGISTRY_MAX_ROWS)
    const tmp = `${registryFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(capped, null, 2))
    fs.renameSync(tmp, registryFile)
  } catch {
    // Best-effort: losing the registry costs discoverability, not correctness.
  }
}

export function registerEphemeralDir(registryFile: string, dir: string): void {
  const rows = readRegistry(registryFile)
  rows.push({ dir, launcherPid: process.pid, createdAt: Date.now() })
  writeRegistry(registryFile, rows)
}

/** Forget one dir immediately (the launcher's own error paths already rm it). */
export function unregisterEphemeralDir(registryFile: string, dir: string): void {
  const rows = readRegistry(registryFile)
  const kept = rows.filter((r) => r.dir !== dir)
  if (kept.length !== rows.length) writeRegistry(registryFile, kept)
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Candidate snapshot dirs: the registry (any TMPDIR, including ones this process
 * knows nothing about) UNION a scan of the current os.tmpdir() (dirs from builds
 * that predate the registry).
 */
function candidateDirs(walnutHome: string): Set<string> {
  const candidates = new Set<string>()
  for (const row of readRegistry(registryPath(walnutHome))) candidates.add(row.dir)
  try {
    const tmpBase = os.tmpdir()
    for (const entry of fs.readdirSync(tmpBase)) {
      if (entry.startsWith('open-walnut-')) candidates.add(path.join(tmpBase, entry))
    }
  } catch {
    // tmpdir unreadable — registry candidates still stand.
  }
  return candidates
}

/**
 * Reap dead ephemeral snapshot dirs.
 *
 * A dir dies when its ephemeral.json names a pid that is gone, or when it never
 * got a control file and is past the grace period — that second case is the
 * launcher-was-killed-mid-copy case, which is what stranded 9.8G.
 */
export function reapStaleEphemeralDirs(walnutHome: string): void {
  const registryFile = registryPath(walnutHome)
  const rows = readRegistry(registryFile)
  const gone = new Set<string>()

  for (const dir of candidateDirs(walnutHome)) {
    try {
      if (!fs.statSync(dir).isDirectory()) { gone.add(dir); continue }
    } catch {
      gone.add(dir)  // already removed; drop the registry row
      continue
    }

    let removed = false
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, 'ephemeral.json'), 'utf-8'))
      if (data.pid && !isProcessAlive(data.pid)) {
        fs.rmSync(dir, { recursive: true, force: true })
        removed = true
      }
    } catch {
      // No control file or unparseable — the child never came up. Age it out.
      try {
        if (Date.now() - fs.statSync(dir).mtimeMs > NO_CONTROL_FILE_GRACE_MS) {
          fs.rmSync(dir, { recursive: true, force: true })
          removed = true
        }
      } catch {
        // Can't stat — another reaper got it first, fine
      }
    }
    if (removed) gone.add(dir)
  }

  const kept = rows.filter((r) =>
    !gone.has(r.dir) && Date.now() - r.createdAt < REGISTRY_ROW_TTL_MS)
  if (kept.length !== rows.length) writeRegistry(registryFile, kept)
}

/**
 * Count currently live ephemeral servers.
 * Only counts dirs with an ephemeral.json whose PID is still alive.
 * Call AFTER reapStaleEphemeralDirs() so stale dirs are already cleaned.
 */
export function countLiveEphemeralServers(walnutHome: string): number {
  // Same candidate union as the reaper: a server started under a different TMPDIR
  // is still a live server competing for this machine, so counting only
  // os.tmpdir() would under-report and let the concurrency limit be exceeded.
  const livePids = new Set<number>()
  for (const dir of candidateDirs(walnutHome)) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, 'ephemeral.json'), 'utf-8'))
      // Dedupe by pid: the registry and the tmpdir scan can name the same server.
      if (data.pid && isProcessAlive(data.pid)) livePids.add(data.pid)
    } catch {
      // No control file or can't parse — not a live server
    }
  }
  return livePids.size
}

/**
 * The unpacked runtime tree of the compiled Walnut file: where it lives, how a
 * build's archive becomes that tree exactly once, and how old builds' trees go.
 * src/binary/runtime-root.ts calls this at startup; the functions take their
 * inputs as arguments so tests can run them without a compiled file.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unpackArchive } from './asset-archive.js'

/** Written last into an unpacked tree; its content is the build's id. */
export const RUNTIME_MARKER = '.walnut-runtime'
/**
 * Written just before the marker: the tree's top-level entries and its outermost node_modules
 * folders, one per line. A tree whose marker is there but one of these is gone (a cleaner took
 * node_modules for build output: 2026-11-10, a Demo's file died at boot, 'Missing
 * tiktoken_bg.wasm') is unpacked again. A tree an older build wrote has no list and is trusted as before.
 */
export const RUNTIME_FILES = '.walnut-runtime-files'
/** Unpacked trees of other builds kept beside this one (a server of the previous build may still run). */
const KEEP_OTHER_BUILDS = 2
/** A staging dir this old belongs to an unpack that died. */
const STALE_PARTIAL_MS = 60 * 60_000

/** The env keys that decide where a build's tree goes (runtimeRootsFor). */
export const RUNTIME_PLACE_ENV = ['WALNUT_RUNTIME_DIR', 'OPEN_WALNUT_HOME'] as const

/**
 * Where a run of the file with this env looks for build `id`'s tree, in order:
 * WALNUT_RUNTIME_DIR's tree alone when set, else the data home's, then the temp
 * dir's (a data home that is not writable). Reads only RUNTIME_PLACE_ENV.
 */
export function runtimeRootsFor(env: NodeJS.ProcessEnv, id: string): string[] {
  const override = env.WALNUT_RUNTIME_DIR
  if (override) return [path.join(path.resolve(override), id)]
  const home = env.OPEN_WALNUT_HOME || path.join(os.homedir(), '.open-walnut')
  return [path.join(home, 'local', 'runtime', id), path.join(os.tmpdir(), `open-walnut-runtime-${os.userInfo().uid}`, id)]
}

/** True when `root` holds build `id`'s whole tree (its marker is written last, and what RUNTIME_FILES names is still there). */
export function isComplete(root: string, id: string): boolean {
  try {
    if (fs.readFileSync(path.join(root, RUNTIME_MARKER), 'utf8').trim() !== id) return false
  } catch {
    return false
  }
  let listed: string[]
  try {
    listed = fs.readFileSync(path.join(root, RUNTIME_FILES), 'utf8').split('\n').filter(Boolean)
  } catch {
    return true
  }
  return listed.every((rel) => fs.existsSync(path.join(root, rel)))
}

/** The entries RUNTIME_FILES lists for these archive paths: every top-level name and every outermost node_modules folder. */
export function runtimeFileList(paths: Iterable<string>): string[] {
  const out = new Set<string>()
  for (const p of paths) {
    const parts = p.split('/')
    out.add(parts[0]!)
    const nm = parts.indexOf('node_modules')
    if (nm > 0 && nm < parts.length - 1) out.add(parts.slice(0, nm + 1).join('/'))
  }
  return [...out].sort()
}

/** Unpack `archive` into `root` through a staging dir and one rename, so no reader sees half a tree. */
export function unpackRuntime(root: string, archive: Buffer, id: string): void {
  fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 })
  const staging = `${root}.partial-${process.pid}-${Date.now()}`
  try {
    const paths: string[] = []
    for (const entry of unpackArchive(archive)) {
      const target = path.join(staging, entry.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, entry.data, { mode: entry.mode })
      paths.push(entry.path)
    }
    fs.writeFileSync(path.join(staging, RUNTIME_FILES), runtimeFileList(paths).map((p) => `${p}\n`).join(''))
    fs.writeFileSync(path.join(staging, RUNTIME_MARKER), `${id}\n`)
    try {
      fs.renameSync(staging, root)
    } catch {
      // Another process unpacked this build first: theirs is the same bytes.
      if (isComplete(root, id)) return
      // A tree without the marker is a leftover of a broken unpack, and one missing a listed
      // entry lost files to a cleaner: replace it.
      fs.rmSync(root, { recursive: true, force: true })
      fs.renameSync(staging, root)
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

/** Remove other builds' trees past the newest KEEP_OTHER_BUILDS, and dead staging dirs. Never throws. */
export function pruneRuntimes(parent: string, keepId: string, now = Date.now()): void {
  try {
    const others: Array<{ dir: string; mtime: number }> = []
    for (const name of fs.readdirSync(parent)) {
      const dir = path.join(parent, name)
      if (name === keepId) continue
      try {
        if (name.includes('.partial-')) {
          if (now - fs.statSync(dir).mtimeMs > STALE_PARTIAL_MS) fs.rmSync(dir, { recursive: true, force: true })
          continue
        }
        // Only trees this code unpacked: they carry the marker naming their own dir.
        const marker = path.join(dir, RUNTIME_MARKER)
        if (fs.readFileSync(marker, 'utf8').trim() !== name) continue
        others.push({ dir, mtime: fs.statSync(marker).mtimeMs })
      } catch { /* not ours, or already gone */ }
    }
    others.sort((a, b) => b.mtime - a.mtime)
    for (const { dir } of others.slice(KEEP_OTHER_BUILDS)) fs.rmSync(dir, { recursive: true, force: true })
  } catch { /* hygiene only */ }
}

/**
 * Make sure this build's tree exists; returns its root. Falls back to the temp dir when the data home is not writable.
 *
 * WALNUT_RUNTIME_DIR names the PARENT of the per-build trees, never one tree: a
 * production deploy keeps its server's tree inside its stage dir (scripts/dev-prod.sh),
 * and every child the server starts inherits the variable. A different build
 * started from one of those children (another compiled file run from a session)
 * then unpacks beside it, instead of replacing the tree a running server serves
 * its web app from. Nothing is pruned there: the dir's owner removes it whole.
 */
export function ensureRuntime(archivePath: string, id: string): string {
  const override = process.env.WALNUT_RUNTIME_DIR
  const roots = runtimeRootsFor(process.env, id)
  let lastError: unknown = null
  for (const root of roots) {
    if (isComplete(root, id)) return root
    try {
      unpackRuntime(root, fs.readFileSync(archivePath), id)
      if (!override) pruneRuntimes(path.dirname(root), id)
      return root
    } catch (err) {
      lastError = err
    }
  }
  process.stderr.write(`walnut: could not unpack its files (${lastError instanceof Error ? lastError.message : String(lastError)}); the web app and bundled data are unavailable\n`)
  return roots[0]!
}


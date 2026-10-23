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
/** Unpacked trees of other builds kept beside this one (a server of the previous build may still run). */
const KEEP_OTHER_BUILDS = 2
/** A staging dir this old belongs to an unpack that died. */
const STALE_PARTIAL_MS = 60 * 60_000

function defaultParent(): string {
  const home = process.env.OPEN_WALNUT_HOME || path.join(os.homedir(), '.open-walnut')
  return path.join(home, 'local', 'runtime')
}

function isComplete(root: string, id: string): boolean {
  try {
    return fs.readFileSync(path.join(root, RUNTIME_MARKER), 'utf8').trim() === id
  } catch {
    return false
  }
}

/** Unpack `archive` into `root` through a staging dir and one rename, so no reader sees half a tree. */
export function unpackRuntime(root: string, archive: Buffer, id: string): void {
  fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 })
  const staging = `${root}.partial-${process.pid}-${Date.now()}`
  try {
    for (const entry of unpackArchive(archive)) {
      const target = path.join(staging, entry.path)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, entry.data, { mode: entry.mode })
    }
    fs.writeFileSync(path.join(staging, RUNTIME_MARKER), `${id}\n`)
    try {
      fs.renameSync(staging, root)
    } catch {
      // Another process unpacked this build first: theirs is the same bytes.
      if (isComplete(root, id)) return
      // A tree without the marker is a leftover of a broken unpack: replace it.
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

/** Make sure this build's tree exists; returns its root. Falls back to the temp dir when the data home is not writable. */
export function ensureRuntime(archivePath: string, id: string): string {
  const override = process.env.WALNUT_RUNTIME_DIR
  const roots = override
    ? [path.resolve(override)]
    : [path.join(defaultParent(), id), path.join(os.tmpdir(), `open-walnut-runtime-${os.userInfo().uid}`, id)]
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


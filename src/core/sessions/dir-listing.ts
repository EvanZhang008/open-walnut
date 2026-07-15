/**
 * Directory listing for the session path selector (list-dirs route).
 *
 * BFS preload up to `depth` levels, 500-entry budget. Hidden directories are
 * returned ONLY at depth 1 (direct children of the listed parent) and are
 * never recursed into — the frontend shows them only when the user's current
 * input segment starts with '.', and recursing into `.git`-like trees would
 * eat the whole entry budget.
 *
 * `exists: false` means the listed directory itself doesn't exist — the
 * frontend renders "directory does not exist" instead of silently letting
 * history matches impersonate live results.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'

export const DIR_LIST_MAX_ENTRIES = 500

export interface DirListing {
  dirs: string[]
  parent: string
  exists: boolean
}

/** Same ENOENT semantics as providers/cwd-check.ts — keep in sync. */
export function isEnoentLike(msg: string): boolean {
  return /ENOENT|no such file|does not exist|not a directory/i.test(msg)
}

/** List subdirectories of `dir` on the local filesystem, BFS to `depth`. */
export async function listLocalDirs(dir: string, depth: number): Promise<DirListing> {
  try {
    const st = await fsp.stat(dir)
    if (!st.isDirectory()) return { dirs: [], parent: dir, exists: false }
  } catch {
    return { dirs: [], parent: dir, exists: false }
  }

  const entries: string[] = []
  const walk = async (d: string, currentDepth: number) => {
    if (currentDepth > depth || entries.length >= DIR_LIST_MAX_ENTRIES) return
    let dirents
    try {
      dirents = await fsp.readdir(d, { withFileTypes: true })
    } catch {
      return // unreadable — skip subtree
    }
    for (const dirent of dirents) {
      if (entries.length >= DIR_LIST_MAX_ENTRIES) break
      if (!dirent.isDirectory()) continue
      const hidden = dirent.name.startsWith('.')
      // Hidden dirs: emit at depth 1 only, never recurse into them.
      if (hidden && currentDepth > 1) continue
      const full = path.join(d, dirent.name)
      entries.push(full)
      if (!hidden && currentDepth < depth) await walk(full, currentDepth + 1)
    }
  }
  await walk(dir, 1)
  return { dirs: entries, parent: dir, exists: true }
}

/** Minimal shape of a daemon connection's send() we depend on (keeps this module testable). */
export interface DaemonLsConnection {
  send(command: string, params: Record<string, unknown>): Promise<Record<string, unknown>>
}

/**
 * List subdirectories of `dir` on a remote host via the daemon's fs.ls, BFS to `depth`.
 * The daemon expands ~ on the remote host; `parent` in the result is the resolved path.
 * Throws on non-ENOENT errors (SSH/daemon failures) — caller maps those to HTTP 400.
 */
export async function listRemoteDirs(conn: DaemonLsConnection, dir: string, depth: number): Promise<DirListing> {
  const entries: string[] = []
  let resolvedDir = dir

  const rootResult = await conn.send('fs.ls', { path: dir })
  if (!rootResult.ok) {
    const errMsg = typeof rootResult.error === 'string' ? rootResult.error : String(rootResult.error ?? dir)
    if (isEnoentLike(errMsg)) {
      return { dirs: [], parent: dir, exists: false }
    }
    throw new Error(`Cannot list directory: ${errMsg}`)
  }
  if (rootResult.resolvedPath && typeof rootResult.resolvedPath === 'string') {
    resolvedDir = rootResult.resolvedPath.endsWith('/')
      ? rootResult.resolvedPath
      : rootResult.resolvedPath + '/'
  }

  const queue: { dirPath: string; currentDepth: number }[] = []
  const rootEntries = rootResult.entries as Array<{ name: string; type: string }>
  for (const e of rootEntries) {
    if (e.type !== 'dir') continue
    const fullPath = resolvedDir.endsWith('/')
      ? `${resolvedDir}${e.name}`
      : `${resolvedDir}/${e.name}`
    entries.push(fullPath)
    // Hidden dirs surface at depth 1 but are never walked into.
    if (depth > 1 && !e.name.startsWith('.')) {
      queue.push({ dirPath: fullPath, currentDepth: 1 })
    }
  }

  while (queue.length > 0 && entries.length < DIR_LIST_MAX_ENTRIES) {
    const batch = queue.splice(0, queue.length)
    for (const item of batch) {
      if (entries.length >= DIR_LIST_MAX_ENTRIES) break
      try {
        const result = await conn.send('fs.ls', { path: item.dirPath })
        if (!result.ok) continue
        const lsEntries = result.entries as Array<{ name: string; type: string }>
        for (const e of lsEntries) {
          if (entries.length >= DIR_LIST_MAX_ENTRIES) break
          if (e.type !== 'dir' || e.name.startsWith('.')) continue
          const fullPath = `${item.dirPath}/${e.name}`
          entries.push(fullPath)
          if (item.currentDepth + 1 < depth) {
            queue.push({ dirPath: fullPath, currentDepth: item.currentDepth + 1 })
          }
        }
      } catch {
        // Directory unreadable or daemon error — skip
      }
    }
  }

  return { dirs: entries, parent: resolvedDir, exists: true }
}

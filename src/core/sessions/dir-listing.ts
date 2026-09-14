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

/** Wall-clock budget for the remote BFS. Each level is one fs.ls RPC per dir
 *  (~65ms warm); a wide tree at depth 3-4 can queue hundreds of serial RPCs,
 *  and the entry cap alone doesn't bound TIME when directories are slow to
 *  answer. On expiry we return what we have — the path selector degrades to
 *  shallower results instead of holding the HTTP request (and one of the
 *  browser's 6 connections) for tens of seconds. */
export const REMOTE_BFS_BUDGET_MS = 8_000

/** Same idea for the local walk, which runs on the web server's one event loop
 *  and answers a request the browser holds a connection open for. */
export const LOCAL_BFS_BUDGET_MS = 4_000
/** A symlink into an unresponsive mount (an autofs home, a NAS off-VPN) makes
 *  stat() block for the mount's own timeout, tens of seconds. The link is
 *  dropped from the listing when it does not answer in this long. The stat
 *  keeps running in libuv's threadpool, but the request no longer waits. */
export const SYMLINK_STAT_TIMEOUT_MS = 1_500

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
  const deadline = Date.now() + LOCAL_BFS_BUDGET_MS
  const walk = async (d: string, currentDepth: number) => {
    if (currentDepth > depth || entries.length >= DIR_LIST_MAX_ENTRIES || Date.now() >= deadline) return
    let dirents
    try {
      dirents = await fsp.readdir(d, { withFileTypes: true })
    } catch {
      return // unreadable — skip subtree
    }
    // A symlink to a directory is a directory to the user (~/work → a volume,
    // /tmp → /private/tmp on macOS): list it, but never walk through it — a
    // link cycle would otherwise eat the whole entry budget. readdir has lstat
    // semantics, so links need one stat() each; they run together, bounded.
    const linkIsDir = new Map<string, boolean>()
    await Promise.all(dirents.filter(e => e.isSymbolicLink()).map(async e => {
      linkIsDir.set(e.name, await symlinkPointsToDir(path.join(d, e.name)))
    }))
    for (const dirent of dirents) {
      if (entries.length >= DIR_LIST_MAX_ENTRIES || Date.now() >= deadline) break
      const full = path.join(d, dirent.name)
      const isLink = dirent.isSymbolicLink()
      if (isLink ? !linkIsDir.get(dirent.name) : !dirent.isDirectory()) continue
      const hidden = dirent.name.startsWith('.')
      // Hidden dirs: emit at depth 1 only, never recurse into them.
      if (hidden && currentDepth > 1) continue
      entries.push(full)
      if (!hidden && !isLink && currentDepth < depth) await walk(full, currentDepth + 1)
    }
  }
  await walk(dir, 1)
  return { dirs: entries, parent: dir, exists: true }
}

/** false for a dangling link, a link to a file, or a link that does not answer in time. */
async function symlinkPointsToDir(full: string): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), SYMLINK_STAT_TIMEOUT_MS) })
  try {
    return await Promise.race([fsp.stat(full).then(st => st.isDirectory(), () => false), timeout])
  } finally {
    clearTimeout(timer)
  }
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
  const deadline = Date.now() + REMOTE_BFS_BUDGET_MS

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
  // `symlink` is set by daemons that follow links (a linked dir is `type: 'dir'`);
  // older daemons report a symlink as 'other' and never set it. A linked dir is
  // listed like hidden dirs are: shown, never walked into (link loops).
  const rootEntries = rootResult.entries as Array<{ name: string; type: string; symlink?: boolean }>
  for (const e of rootEntries) {
    if (e.type !== 'dir') continue
    const fullPath = resolvedDir.endsWith('/')
      ? `${resolvedDir}${e.name}`
      : `${resolvedDir}/${e.name}`
    entries.push(fullPath)
    // Hidden dirs and symlinked dirs surface at depth 1 but are never walked into.
    if (depth > 1 && !e.name.startsWith('.') && !e.symlink) {
      queue.push({ dirPath: fullPath, currentDepth: 1 })
    }
  }

  while (queue.length > 0 && entries.length < DIR_LIST_MAX_ENTRIES && Date.now() < deadline) {
    const batch = queue.splice(0, queue.length)
    for (const item of batch) {
      if (entries.length >= DIR_LIST_MAX_ENTRIES || Date.now() >= deadline) break
      try {
        const result = await conn.send('fs.ls', { path: item.dirPath })
        if (!result.ok) continue
        const lsEntries = result.entries as Array<{ name: string; type: string; symlink?: boolean }>
        for (const e of lsEntries) {
          if (entries.length >= DIR_LIST_MAX_ENTRIES) break
          if (e.type !== 'dir' || e.name.startsWith('.')) continue
          const fullPath = `${item.dirPath}/${e.name}`
          entries.push(fullPath)
          if (item.currentDepth + 1 < depth && !e.symlink) {
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

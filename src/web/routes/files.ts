/**
 * List a single directory's entries (dirs + files) for the Session File Explorer.
 *
 * GET /api/files/list?path=/absolute/dir&host=optional-ssh-host&showHidden=0
 *
 * Returns one level only (lazy-loaded tree). Directories sort before files,
 * each alphabetically. Capped at MAX_ENTRIES.
 *
 * Local:  fs.readdir(dir, { withFileTypes: true })
 * Remote: getDaemonConnection + fs.ls (daemon returns { name, type })
 *
 * Security:
 * - Absolute path required, '..' rejected, shell metacharacters rejected
 * - Read-only; never executes commands
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import os from 'node:os'
import fsp from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { getConfig } from '../../core/config-manager.js'
import { getFrequentDirs } from '../../core/frequent-dirs.js'
import { recordMentionDir, getMentionDirs } from '../../core/mention-dirs.js'

export const filesRouter = Router()

const MAX_ENTRIES = 1000
const REMOTE_TIMEOUT_MS = 15_000

export interface DirEntry {
  name: string
  type: 'dir' | 'file'
  size?: number
}

/** Sort directories before files, each alphabetically (case-insensitive). */
function sortEntries(entries: DirEntry[]): DirEntry[] {
  return entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

const MAX_UPWARD_LEVELS = 8
const MAX_DOWNWARD_DEPTH = 4

/** Build the ordered list of base dirs to try: cwd, then each parent up to N levels. */
function candidateBases(cwd: string): string[] {
  const bases: string[] = []
  let cur = cwd.replace(/\/+$/, '')
  for (let i = 0; i <= MAX_UPWARD_LEVELS; i++) {
    bases.push(cur)
    const parent = path.posix.dirname(cur)
    if (parent === cur) break // reached filesystem root
    cur = parent
  }
  return bases
}

/**
 * Local breadth-first search under `root` for the first directory where
 * `dir/rel` exists. BFS → shallowest match wins (closest to the search root).
 * Bounded by depth + total dirs scanned, skipping heavy/noise directories.
 *
 * Bounds + skip-set are declared INSIDE the function on purpose: esbuild compiles
 * module-level consts into a lazy-init block, and this hoisted function can run
 * before that block evaluates — leaving the consts `undefined`, which silently
 * disables the cap/depth guard and recurses into node_modules forever.
 */
async function findDownwardLocal(root: string, rel: string): Promise<string | null> {
  // One `find` subprocess instead of many fs calls: the server process wraps
  // fs/promises (log forwarding) which makes per-call latency high, so an N-dir
  // BFS in-process took >10s. A single spawn searches natively in milliseconds,
  // mirroring the remote daemon's `fs.find` path. We match by basename + prune
  // heavy dirs, then keep the shallowest path ending with the requested rel.
  const baseName = rel.split('/').pop() ?? rel
  const isDirTarget = !baseName.includes('.')
  const prune = ['node_modules', '.git', 'dist', 'build', 'out', '.next', 'target', 'coverage', '.cache', 'vendor', '__pycache__', '.venv', 'venv']
  // find <root> -maxdepth 5 ( -name x -o ... ) -prune ... -name <base>
  const pruneArgs: string[] = []
  for (const p of prune) { pruneArgs.push('-name', p, '-prune', '-o') }
  const typeArg = isDirTarget ? ['-type', 'd'] : ['-type', 'f']
  const args = [root, '-maxdepth', '5', '(', ...pruneArgs.slice(0, -1), ')', '-o', ...typeArg, '-name', baseName, '-print']

  return await new Promise<string | null>((resolve) => {
    const child = execFile('find', args, { timeout: 5000, maxBuffer: 1 << 20 }, (_err, stdout) => {
      const suffix = '/' + rel
      const exact = path.posix.join(root, rel)
      const hit = stdout.split('\n')
        .filter(Boolean)
        .filter((f) => f === exact || f.endsWith(suffix))
        .sort((a, b) => a.split('/').length - b.split('/').length)[0]
      resolve(hit ?? null)
    })
    child.on('error', () => resolve(null))
  })
}

/**
 * Resolve a (possibly extensionless, package-relative) path against a session cwd.
 *
 * GET /api/resolve-path?rel=<relPath>&cwd=<absDir>&host=<optional>
 *
 * Claude often emits monorepo-relative paths that don't sit directly under cwd
 * (e.g. cwd is pkg1 but the path lives in a sibling pkg or at the repo root).
 * We try cwd first, then walk up parent dirs, returning the first base where
 * `base/rel` exists. Stops one level past a dir containing `.git` (repo root).
 * Falls back to cwd/rel (resolved:false) when nothing exists.
 */
filesRouter.get('/resolve-path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rel = req.query.rel
    const cwd = req.query.cwd
    const host = req.query.host as string | undefined

    if (!rel || typeof rel !== 'string' || !cwd || typeof cwd !== 'string') {
      res.status(400).json({ error: 'Missing rel or cwd parameter' })
      return
    }
    if (rel.includes('..') || cwd.includes('..')) {
      res.status(400).json({ error: 'Invalid path' })
      return
    }
    if (/[;&|`$(){}!<>]/.test(rel) || /[;&|`$(){}!<>]/.test(cwd)) {
      res.status(400).json({ error: 'invalid characters in path' })
      return
    }
    // Absolute rel needs no resolution — pass through.
    if (rel.startsWith('/')) {
      res.json({ path: rel, resolved: true })
      return
    }

    const cleanRel = rel.replace(/^\.\//, '').replace(/\/+$/, '')
    const bases = candidateBases(cwd)
    const fallback = path.posix.join(cwd.replace(/\/+$/, ''), cleanRel)

    if (host) {
      // ── Remote: stat each candidate via daemon fs.stat ──
      const config = await getConfig()
      const hostDef = config.hosts?.[host]
      if (!hostDef?.hostname) {
        res.json({ path: fallback, resolved: false })
        return
      }
      const { getDaemonConnection } = await import('../../providers/daemon-connection.js')
      const sshTarget = { hostname: hostDef.hostname, user: hostDef.user, port: hostDef.port }
      let conn
      try {
        let timeoutId: ReturnType<typeof setTimeout>
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('timeout')), REMOTE_TIMEOUT_MS)
        })
        conn = await Promise.race([getDaemonConnection(host, sshTarget), timeoutPromise])
          .finally(() => clearTimeout(timeoutId!))
      } catch {
        res.json({ path: fallback, resolved: false })
        return
      }
      // Total time budget across the walk-up stats + the downward find: the
      // loop is up to 2 serial RPCs per ancestor level (~18 on a deep path),
      // and per-RPC timeouts alone don't bound the SUM. Expiring falls back to
      // the naive cwd-joined path — a click still does something.
      const resolveDeadline = Date.now() + 10_000
      let remoteRepoRoot: string | null = null
      for (const base of bases) {
        if (Date.now() >= resolveDeadline) {
          res.json({ path: fallback, resolved: false })
          return
        }
        const candidate = path.posix.join(base, cleanRel)
        const st = await conn.send('fs.stat', { path: candidate })
        if (st.ok && st.exists) {
          res.json({ path: candidate, resolved: true })
          return
        }
        // Stop at the repo root (one .git up), remember it for downward search.
        const git = await conn.send('fs.stat', { path: path.posix.join(base, '.git') })
        if (git.ok && git.exists) { remoteRepoRoot = base; break }
      }
      if (Date.now() >= resolveDeadline) {
        res.json({ path: fallback, resolved: false })
        return
      }
      // Downward: one fs.find RPC by basename under the repo root, then keep the
      // first hit whose full path ends with the requested rel (server-side walk
      // avoids a round-trip per directory). Only locates files, not bare dirs.
      const downRoot = remoteRepoRoot ?? bases[bases.length - 1]
      const baseName = cleanRel.split('/').pop() ?? cleanRel
      const find = await conn.send('fs.find', { path: downRoot, name: baseName, maxDepth: MAX_DOWNWARD_DEPTH })
      if (find.ok && Array.isArray(find.files)) {
        const suffix = '/' + cleanRel
        const hit = (find.files as string[])
          .filter((f) => f === path.posix.join(downRoot, cleanRel) || f.endsWith(suffix))
          .sort((a, b) => a.split('/').length - b.split('/').length)[0]
        if (hit) {
          res.json({ path: hit, resolved: true })
          return
        }
      }
      res.json({ path: fallback, resolved: false })
      return
    }

    // ── Local: walk up first, then search down from the repo root ──
    let repoRoot: string | null = null
    for (const base of bases) {
      const candidate = path.posix.join(base, cleanRel)
      try {
        await fsp.stat(candidate)
        res.json({ path: candidate, resolved: true })
        return
      } catch { /* not here, keep walking up */ }
      try {
        await fsp.stat(path.join(base, '.git'))
        repoRoot = base
        break // reached repo root — stop walking up
      } catch { /* not a repo root, continue */ }
    }
    // Nothing upward — Claude may have shown a path relative to a deeper dir
    // (e.g. cwd=repo but the file lives in repo/a/b/<rel>). Search downward from
    // the repo root (or the topmost base we reached) for the first match.
    // Search downward from the repo root if known, else from cwd itself — NEVER
    // from an ancestor above cwd (that could mean scanning from / across the whole
    // filesystem). The repo root is always at or below cwd's ancestors but bounded
    // by .git; without it, cwd is the safe floor.
    const downRoot = repoRoot ?? cwd.replace(/\/+$/, '')
    const downHit = await findDownwardLocal(downRoot, cleanRel)
    if (downHit) {
      res.json({ path: downHit, resolved: true })
      return
    }
    res.json({ path: fallback, resolved: false })
  } catch (err) {
    next(err)
  }
})

filesRouter.get('/list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawPath = req.query.path
    const host = req.query.host as string | undefined
    const showHidden = req.query.showHidden === '1' || req.query.showHidden === 'true'

    if (!rawPath || typeof rawPath !== 'string') {
      res.status(400).json({ error: 'Missing or invalid path parameter' })
      return
    }
    if (rawPath.length > 4096) {
      res.status(400).json({ error: 'path too long' })
      return
    }
    // No directory traversal
    if (rawPath.includes('..')) {
      res.status(400).json({ error: 'Invalid path' })
      return
    }
    // No shell metacharacters (defense in depth — remote path is passed to daemon)
    if (/[;&|`$(){}!<>]/.test(rawPath)) {
      res.status(400).json({ error: 'invalid characters in path' })
      return
    }

    // Expand ~ for local; remote keeps ~ (daemon's fs.ls expands on the remote host)
    let dirPath = rawPath
    if (!host && (dirPath === '~' || dirPath.startsWith('~/'))) {
      dirPath = os.homedir() + dirPath.slice(1)
    }

    if (!host && !path.isAbsolute(dirPath)) {
      res.status(400).json({ error: 'Path must be absolute' })
      return
    }

    if (host) {
      // ── Remote ──
      const config = await getConfig()
      const hostDef = config.hosts?.[host]
      if (!hostDef) {
        res.status(400).json({ error: `Unknown host: ${host}` })
        return
      }
      const hostname = hostDef.hostname
      if (!hostname) {
        res.status(400).json({ error: `Host "${host}" has no hostname` })
        return
      }

      const { getDaemonConnection } = await import('../../providers/daemon-connection.js')
      const sshTarget = { hostname, user: hostDef.user, port: hostDef.port }

      let timeoutId: ReturnType<typeof setTimeout>
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Remote connection to ${host} timed out`)), REMOTE_TIMEOUT_MS)
      })
      const conn = await Promise.race([
        getDaemonConnection(host, sshTarget),
        timeoutPromise,
      ]).finally(() => clearTimeout(timeoutId!))

      let result = await conn.send('fs.ls', { path: dirPath })
      let remoteSelectedFile: string | undefined
      // If the path is a file (not a dir), the daemon's readdir fails with ENOTDIR.
      // Behave like VS Code: list the parent dir and flag the file for preview.
      // (Detect via the error string — the daemon's fs.stat doesn't report dir-ness,
      // so this avoids a daemon binary rebuild/redeploy.)
      if (!result.ok && /ENOTDIR/.test(String(result.error))) {
        const parent = path.posix.dirname(dirPath)
        remoteSelectedFile = path.posix.basename(dirPath)
        result = await conn.send('fs.ls', { path: parent })
      }
      if (!result.ok) {
        res.status(400).json({ error: `Cannot list directory: ${result.error ?? dirPath}` })
        return
      }
      const resolvedPath = (typeof result.resolvedPath === 'string' && result.resolvedPath)
        ? result.resolvedPath
        : dirPath
      const lsEntries = (result.entries as Array<{ name: string; type: string; size?: number }>) ?? []
      const entries: DirEntry[] = []
      for (const e of lsEntries) {
        if (!showHidden && e.name.startsWith('.')) continue
        // Daemon fs.ls reports 'dir' | 'file' | 'other' (sockets/FIFOs/symlinks) and
        // never includes size — anything non-dir is shown as a (sizeless) file.
        entries.push({
          name: e.name,
          type: e.type === 'dir' ? 'dir' : 'file',
          ...(typeof e.size === 'number' ? { size: e.size } : {}),
        })
      }
      res.json({ path: resolvedPath, selectedFile: remoteSelectedFile, entries: sortEntries(entries).slice(0, MAX_ENTRIES) })
      return
    }

    // ── Local ──
    // If the path points at a file (not a dir), behave like VS Code: list its
    // parent directory and flag the file so the UI can select/preview it, instead
    // of failing with ENOTDIR on scandir.
    let listDir = dirPath
    let selectedFile: string | undefined
    try {
      const st = await fsp.stat(dirPath)
      if (!st.isDirectory()) {
        listDir = path.dirname(dirPath)
        selectedFile = path.basename(dirPath)
      }
    } catch {
      // stat failed (missing path / perms) — let readdir below produce the error
    }
    let dirents
    try {
      dirents = await fsp.readdir(listDir, { withFileTypes: true })
    } catch (err) {
      res.status(400).json({ error: `Cannot list directory: ${err instanceof Error ? err.message : String(err)}` })
      return
    }
    const visible = dirents.filter((d) => showHidden || !d.name.startsWith('.'))
    // stat() (follows symlinks) in parallel so a symlink-to-dir is classified as a
    // dir (readdir's withFileTypes uses lstat → symlinked dirs would look like files),
    // and to avoid N sequential round-trips on large/networked dirs. stat also yields
    // the file size. Falls back to the dirent type if stat fails (broken symlink/perm).
    const entries: DirEntry[] = await Promise.all(
      visible.map(async (dirent): Promise<DirEntry> => {
        try {
          const st = await fsp.stat(path.join(dirPath, dirent.name))
          if (st.isDirectory()) return { name: dirent.name, type: 'dir' }
          return { name: dirent.name, type: 'file', size: st.size }
        } catch {
          return { name: dirent.name, type: dirent.isDirectory() ? 'dir' : 'file' }
        }
      }),
    )
    res.json({ path: listDir, selectedFile, entries: sortEntries(entries).slice(0, MAX_ENTRIES) })
  } catch (err) {
    next(err)
  }
})

// POST /api/files/record-dir — record a folder the user browsed in the "@" picker.
// Writes to the SEPARATE mention-dirs store (NOT frequent-dirs), so ad-hoc "@"
// browsing never pollutes the /session path picker. Server-persisted so recents
// survive across browsers/devices. Fire-and-forget from the client; best-effort.
filesRouter.post('/record-dir', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { path: dirPath, host } = req.body ?? {}
    if (!dirPath || typeof dirPath !== 'string' || !path.isAbsolute(dirPath)) {
      res.status(400).json({ error: 'path must be an absolute string' })
      return
    }
    // Reject traversal by SEGMENT, not substring — a real dir like "/foo/..bar"
    // contains ".." but isn't traversal; only a "." or ".." path component is.
    if (dirPath.length > 4096 || dirPath.split('/').some((seg) => seg === '..' || seg === '.')) {
      res.status(400).json({ error: 'Invalid path' })
      return
    }
    await recordMentionDir(dirPath, typeof host === 'string' && host ? host : null)
    res.json({ status: 'ok' })
  } catch (err) {
    next(err)
  }
})

// GET /api/files/recent-dirs — folders for the "@?" recents search: the UNION of
// (a) session working dirs (frequent-dirs) and (b) folders browsed in "@"
// (mention-dirs), deduped by cwd+host. This is intentionally broader than the
// /session path picker (which reads frequent-dirs only). Returns {cwd, host}[]
// with the most-recent first; the client does fuzzy ranking + cwd/host boosting.
filesRouter.get('/recent-dirs', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [freq, mention] = await Promise.all([getFrequentDirs(), getMentionDirs()])
    // Dedup by cwd+host, keeping the MOST-RECENT lastUsed across both stores — a
    // path can be both a session dir and "@"-browsed, and we want its freshest use
    // (not whichever store we happened to iterate first) to drive recency ranking.
    const byKey = new Map<string, { cwd: string; host: string | null; lastUsed: string }>()
    for (const d of [...mention, ...freq]) {
      const key = `${d.cwd}::${d.host ?? '__local__'}`
      const existing = byKey.get(key)
      if (!existing || new Date(d.lastUsed).getTime() > new Date(existing.lastUsed).getTime()) {
        byKey.set(key, { cwd: d.cwd, host: d.host, lastUsed: d.lastUsed })
      }
    }
    const merged = [...byKey.values()]
    merged.sort((a, b) => new Date(b.lastUsed).getTime() - new Date(a.lastUsed).getTime())
    res.json({ dirs: merged.map(({ cwd, host }) => ({ cwd, host })) })
  } catch (err) {
    next(err)
  }
})

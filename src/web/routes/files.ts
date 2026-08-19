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
import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { parsePathRef, isUnsafePathRef } from '../../providers/path-ref-parse.js'

export const filesRouter = Router()

const MAX_ENTRIES = 1000
const REMOTE_TIMEOUT_MS = 15_000
/** Search budget handed to a REMOTE host's resolver. Larger than the resolver's
 *  in-process default (a remote tree is usually a big monorepo on slower disk),
 *  and still comfortably inside REMOTE_TIMEOUT_MS so the RPC can't outlive its
 *  own connection deadline. */
const REMOTE_RESOLVE_BUDGET_MS = 12_000

/** Validation/lookup failure with an HTTP-ish status — each edge maps its own shape. */
export class FilesOpError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message)
    this.name = 'FilesOpError'
  }
}

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
 * Ask the host that owns the files to resolve a reference — the preferred path.
 *
 * The whole layered search (session transcript, ancestor walk, git index with
 * submodules, pruned find) is host-local work, so it runs where the files are and
 * ONE small answer crosses the tunnel. Compare the legacy walk below this: ~2
 * stat RPCs per ancestor level, which spent its entire budget on round trips on
 * any deep path and then returned a path that did not exist.
 *
 * Returns null when this host can't do it (old daemon without 'path-resolve-v1',
 * daemon unreachable, unknown host) — the caller then uses the legacy walk.
 */
async function resolveViaHost(
  ref: string,
  cwd: string | undefined,
  host: string | undefined,
  sessionId: string | undefined,
): Promise<HostResolveResult | null> {
  // Local host: call the resolver in-process. It yields the event loop between
  // transcript windows and shells out for git/find, so it never blocks a route.
  if (!host) {
    const { resolvePathHostLocal } = await import('../../providers/path-resolve-core.js')
    return await resolvePathHostLocal({ ref, cwd, sessionId })
  }

  const config = await getConfig()
  const hostDef = config.hosts?.[host]
  if (!hostDef?.hostname) return null

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
    return null
  }
  if (!conn.hasCapability?.('path-resolve-v1')) return null
  // A remote host's tree is typically a big monorepo on slower storage, and this
  // is ONE RPC either way — so give the search a wider budget than the in-process
  // default. Still bounded: expiring degrades to the nearest existing folder.
  const res = await conn.send('fs.resolvePath', {
    ref, budgetMs: REMOTE_RESOLVE_BUDGET_MS,
    ...(cwd ? { cwd } : {}), ...(sessionId ? { sessionId } : {}),
  })
  if (!res.ok || typeof res.path !== 'string') return null
  return {
    path: res.path,
    resolved: res.resolved === true,
    via: typeof res.via === 'string' ? res.via : 'none',
    ...(res.degraded === true ? { degraded: true } : {}),
    ...(typeof res.ref === 'string' ? { ref: res.ref } : {}),
    ...(Array.isArray(res.alternatives) ? { alternatives: res.alternatives as string[] } : {}),
    ...(typeof res.line === 'number' ? { line: res.line } : {}),
    ...(typeof res.column === 'number' ? { column: res.column } : {}),
    ...(typeof res.endLine === 'number' ? { endLine: res.endLine } : {}),
  }
}

/** Shape of a host resolution, mirrored from path-resolve-core's result. */
interface HostResolveResult {
  path: string
  resolved: boolean
  via: string
  degraded?: boolean
  ref?: string
  alternatives?: string[]
  /** Position the reference itself carried (`a.ts:42`, `#L10-L20`). Reported even
   *  on a failed resolve: the reference asked for it, so the caller can still jump
   *  there once the file is found some other way. */
  line?: number
  column?: number
  endLine?: number
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
/**
 * Resolve a session-relative path against a cwd/host. Shared by the internal
 * route and GET /api/v1/files/resolve-path. Throws FilesOpError on invalid
 * input; unresolvable paths return `{ path: fallback, resolved: false }`.
 *
 * Two implementations, in preference order:
 *  1. the HOST-LOCAL layered resolver (transcript / walk-up / git / find). One
 *     round trip, and the only one that can use the session transcript or reach
 *     into a submodule at arbitrary depth.
 *  2. the legacy per-ancestor stat walk below, kept as the fallback for hosts
 *     whose daemon predates 'path-resolve-v1'.
 *
 * `sessionId` is optional but strongly wanted: it unlocks the transcript layer,
 * which is both the cheapest and the most accurate signal available.
 */
export async function resolveSessionPath(
  rel: unknown,
  cwd: unknown,
  host: string | undefined,
  sessionId?: string,
): Promise<{
  path: string; resolved: boolean; via?: string; degraded?: boolean; ref?: string
  alternatives?: string[]; line?: number; column?: number; endLine?: number
}> {
  if (!rel || typeof rel !== 'string' || !cwd || typeof cwd !== 'string') {
    throw new FilesOpError('Missing rel or cwd parameter', 400)
  }
  // Guard the PARSED reference, not the raw string. A reference arrives decorated
  // (`` `src/a.ts:42` ``) and a decoration character is not a threat; the old
  // substring checks rejected both that and legitimate names containing `..`
  // (`mod..old/thing.ts`), making those files unreachable. parsePathRef strips
  // decoration and isUnsafePathRef rejects a real `..` SEGMENT.
  const parsedRel = parsePathRef(rel)
  if (isUnsafePathRef(parsedRel.path) || isUnsafePathRef(cwd)) {
    throw new FilesOpError('Invalid path', 400)
  }
  // Preferred path. Absolute refs go through it too: an absolute path that does
  // NOT exist is a common failure (a stale checkout root, or a prefix the model
  // carried over from another machine), and the resolver's transcript/git layers
  // fix exactly that by matching the path's TAIL. The old code returned every
  // absolute ref as `resolved:true` without checking, so a wrong path was
  // reported as a good one and the click died in the listing instead.
  //
  // A throw here means the resolver's own guards rejected the input, which the
  // checks above already cover — so any throw is treated as "this host can't
  // answer" and falls through to the legacy walk.
  try {
    const hostResult = await resolveViaHost(rel, cwd, host, sessionId)
    if (hostResult) return hostResult
  } catch (err) {
    log.web.info('resolveSessionPath: host resolver unavailable, using legacy walk', {
      host: host ?? 'local', error: err instanceof Error ? err.message : String(err),
    })
  }

  // ── Legacy fallback (daemon without 'path-resolve-v1') ──
  // Work from the PARSED reference so decoration doesn't leak into a stat path,
  // and carry the position through — a legacy host still can't find the file any
  // better, but the line the reference asked for is known either way.
  const pos = {
    ...(parsedRel.line !== undefined ? { line: parsedRel.line } : {}),
    ...(parsedRel.column !== undefined ? { column: parsedRel.column } : {}),
    ...(parsedRel.endLine !== undefined ? { endLine: parsedRel.endLine } : {}),
  }
  // Absolute rel needs no resolution here — this path can only stat, and the
  // caller's listing surfaces a miss.
  if (parsedRel.path.startsWith('/')) {
    return { path: parsedRel.path, resolved: true, ...pos }
  }

  const cleanRel = parsedRel.path.replace(/^\.\//, '').replace(/\/+$/, '')
  const bases = candidateBases(cwd)
  const fallback = path.posix.join(cwd.replace(/\/+$/, ''), cleanRel)

  if (host) {
    // ── Remote: stat each candidate via daemon fs.stat ──
    const config = await getConfig()
    const hostDef = config.hosts?.[host]
    if (!hostDef?.hostname) {
      return { path: fallback, resolved: false, ...pos }
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
      return { path: fallback, resolved: false, ...pos }
    }
    // Total time budget across the walk-up stats + the downward find: the
    // loop is up to 2 serial RPCs per ancestor level (~18 on a deep path),
    // and per-RPC timeouts alone don't bound the SUM. Expiring falls back to
    // the naive cwd-joined path — a click still does something.
    const resolveDeadline = Date.now() + 10_000
    let remoteRepoRoot: string | null = null
    for (const base of bases) {
      if (Date.now() >= resolveDeadline) {
        return { path: fallback, resolved: false, ...pos }
      }
      const candidate = path.posix.join(base, cleanRel)
      const st = await conn.send('fs.stat', { path: candidate })
      if (st.ok && st.exists) {
        return { path: candidate, resolved: true, ...pos }
      }
      // Stop at the repo root (one .git up), remember it for downward search.
      const git = await conn.send('fs.stat', { path: path.posix.join(base, '.git') })
      if (git.ok && git.exists) { remoteRepoRoot = base; break }
    }
    if (Date.now() >= resolveDeadline) {
      return { path: fallback, resolved: false, ...pos }
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
        return { path: hit, resolved: true, ...pos }
      }
    }
    return { path: fallback, resolved: false, ...pos }
  }

  // ── Local: walk up first, then search down from the repo root ──
  let repoRoot: string | null = null
  for (const base of bases) {
    const candidate = path.posix.join(base, cleanRel)
    try {
      await fsp.stat(candidate)
      return { path: candidate, resolved: true, ...pos }
    } catch { /* not here, keep walking up */ }
    try {
      await fsp.stat(path.join(base, '.git'))
      repoRoot = base
      break // reached repo root — stop walking up
    } catch { /* not a repo root, continue */ }
  }
  // Nothing upward — Claude may have shown a path relative to a deeper dir
  // (e.g. cwd=repo but the file lives in repo/a/b/<rel>). Search downward from
  // the repo root if known, else from cwd itself — NEVER from an ancestor
  // above cwd (that could mean scanning from / across the whole filesystem).
  const downRoot = repoRoot ?? cwd.replace(/\/+$/, '')
  const downHit = await findDownwardLocal(downRoot, cleanRel)
  if (downHit) {
    return { path: downHit, resolved: true, ...pos }
  }
  return { path: fallback, resolved: false, ...pos }
}

filesRouter.get('/resolve-path', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const host = typeof req.query.host === 'string' && req.query.host ? req.query.host : undefined
    const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId ? req.query.sessionId : undefined
    res.json(await resolveSessionPath(req.query.rel, req.query.cwd, host, sessionId))
  } catch (err) {
    if (err instanceof FilesOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

/**
 * GET /api/files/references?path=<absFile>&symbol=<ident>&host=&maxMatches=
 *
 * "Find references" for the Files viewer. The search is HOST-LOCAL work (git
 * grep next to the files), so the local host runs it in-process and a remote one
 * runs it in its daemon — only the small match list crosses the tunnel.
 */
const REFERENCE_SEARCH_BUDGET_MS = 10_000
const SYMBOL_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/

filesRouter.get('/references', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const reqPath = typeof req.query.path === 'string' ? req.query.path : ''
    const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : ''
    const rawHost = typeof req.query.host === 'string' && req.query.host ? req.query.host : undefined
    const host = rawHost === '__local__' || rawHost === 'local' ? undefined : rawHost
    const maxMatches = typeof req.query.maxMatches === 'string' && req.query.maxMatches
      ? Number(req.query.maxMatches)
      : undefined

    if (!SYMBOL_RE.test(symbol)) {
      res.status(400).json({ error: 'invalid symbol' })
      return
    }
    if (!reqPath || !path.isAbsolute(reqPath)) {
      res.status(400).json({ error: 'path must be absolute' })
      return
    }

    if (!host) {
      const { grepReferencesHostLocal } = await import('../../providers/search-grep-core.js')
      const result = await grepReferencesHostLocal({
        file: reqPath, symbol,
        ...(maxMatches !== undefined ? { maxMatches } : {}),
        budgetMs: REFERENCE_SEARCH_BUDGET_MS,
      })
      res.json({ ...result, symbol })
      return
    }

    // ── Remote host: same connection shape as resolveViaHost ──
    const config = await getConfig()
    const hostDef = config.hosts?.[host]
    if (!hostDef?.hostname) {
      res.status(404).json({ error: `Unknown host: ${host}` })
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
      res.status(503).json({ error: 'host unreachable' })
      return
    }
    if (!conn.hasCapability?.('grep-v1')) {
      res.status(503).json({ error: 'daemon needs upgrade for reference search' })
      return
    }
    const result = await conn.send('fs.grep', {
      file: reqPath, symbol,
      ...(maxMatches !== undefined ? { maxMatches } : {}),
      budgetMs: REFERENCE_SEARCH_BUDGET_MS,
    }, REMOTE_TIMEOUT_MS)
    if (!result.ok) {
      res.status(502).json({ error: String(result.error ?? 'reference search failed') })
      return
    }
    // Pick the result's own fields: the RPC envelope also carries id/ok/traceId,
    // which are transport details the client must never see.
    res.json({
      root: typeof result.root === 'string' ? result.root : '',
      matches: Array.isArray(result.matches) ? result.matches : [],
      truncated: result.truncated === true,
      tool: typeof result.tool === 'string' ? result.tool : 'none',
      ...(typeof result.error === 'string' ? { error: result.error } : {}),
      symbol,
    })
  } catch (err) {
    next(err)
  }
})

export interface FileListResult {
  path: string
  selectedFile?: string
  entries: DirEntry[]
  /** Set when `path` is NOT what was asked for: the request pointed at something
   *  that doesn't exist, so this listing is the nearest usable directory instead.
   *  The UI shows the listing plus "couldn't find <requestedPath>" rather than a
   *  raw ENOENT — a dead-end error message was the whole reported complaint. */
  requestedPath?: string
  /** How the shown path was arrived at, when resolution ran ('transcript', 'git', …). */
  resolvedVia?: string
}

/** Optional context that lets a listing SELF-HEAL a path that doesn't exist. */
export interface ListSessionFilesContext {
  /** Session cwd — anchors relative refs and the resolver's search. */
  cwd?: string
  /** Session id — unlocks the transcript layer of the resolver. */
  sessionId?: string
}

/**
 * List a single directory's entries on a host. Shared by the internal route
 * and GET /api/v1/files/list. Path-traversal and shell-metacharacter guards
 * live HERE so every edge gets identical sandboxing. Throws FilesOpError.
 *
 * SELF-HEALING: when `ctx` is supplied and the requested path can't be listed,
 * the layered resolver runs and the listing retries on what it found. That is the
 * single fix for the whole "clicked a path, got `ENOENT: scandir`" complaint, and
 * it lands for every surface at once (web, iOS, cloud) because they all call this
 * one function. Without `ctx` the behavior is exactly as before.
 */
export async function listSessionFiles(
  rawPath: unknown,
  host: string | undefined,
  showHidden: boolean,
  ctx?: ListSessionFilesContext,
): Promise<FileListResult> {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new FilesOpError('Missing or invalid path parameter', 400)
  }
  if (rawPath.length > 4096) {
    throw new FilesOpError('path too long', 400)
  }
  // Guard the PARSED path: a reference reaches this route decorated too (a click
  // on `src/a.ts:42` in the chat), and a legitimate name may contain `..` inside a
  // segment. isUnsafePathRef rejects only a real `..` SEGMENT plus metacharacters.
  const parsedPath = parsePathRef(rawPath)
  if (isUnsafePathRef(parsedPath.path)) {
    throw new FilesOpError('Invalid path', 400)
  }
  // Everything below works from the parsed path — decoration must never reach a
  // readdir (it becomes part of the name and turns a real dir into an ENOENT).
  const reqPath: string = parsedPath.path

  try {
    return await listOneDir(reqPath, host, showHidden)
  } catch (err) {
    // Only a listing failure is worth healing; a guard rejection above is final.
    if (!ctx || (!ctx.cwd && !ctx.sessionId)) throw err
    let healed: HostResolveResult | null = null
    try {
      healed = await resolveViaHost(reqPath, ctx.cwd, host, ctx.sessionId)
    } catch { /* resolver refused the input — surface the original error */ }
    if (!healed || healed.path === reqPath) throw err
    log.web.info('files/list: healed an unlistable path', {
      host: host ?? 'local', requested: reqPath, healed: healed.path, via: healed.via,
    })
    try {
      const listing = await listOneDir(healed.path, host, showHidden)
      // Flag a STAND-IN so the UI can say "couldn't find X, showing Y". A real hit
      // needs no flag: the user asked for a path and got that path's contents.
      return healed.resolved
        ? { ...listing, resolvedVia: healed.via }
        : { ...listing, requestedPath: reqPath, resolvedVia: healed.via }
    } catch {
      throw err // healed path doesn't list either — the original error is truer
    }
  }
}

/** List exactly one directory, no healing. The pre-existing listing logic. */
async function listOneDir(
  rawPath: string,
  host: string | undefined,
  showHidden: boolean,
): Promise<FileListResult> {
  // Expand ~ for local; remote keeps ~ (daemon's fs.ls expands on the remote host)
  let dirPath = rawPath
  if (!host && (dirPath === '~' || dirPath.startsWith('~/'))) {
    dirPath = os.homedir() + dirPath.slice(1)
  }

  if (!host && !path.isAbsolute(dirPath)) {
    throw new FilesOpError('Path must be absolute', 400)
  }

  if (host) {
    // ── Remote ──
    const config = await getConfig()
    const hostDef = config.hosts?.[host]
    if (!hostDef) throw new FilesOpError(`Unknown host: ${host}`, 400)
    const hostname = hostDef.hostname
    if (!hostname) throw new FilesOpError(`Host "${host}" has no hostname`, 400)

    const { getDaemonConnection } = await import('../../providers/daemon-connection.js')
    const sshTarget = { hostname, user: hostDef.user, port: hostDef.port }

    let timeoutId: ReturnType<typeof setTimeout>
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new FilesOpError(`Remote connection to ${host} timed out`, 400)), REMOTE_TIMEOUT_MS)
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
      throw new FilesOpError(`Cannot list directory: ${result.error ?? dirPath}`, 400)
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
    return { path: resolvedPath, selectedFile: remoteSelectedFile, entries: sortEntries(entries).slice(0, MAX_ENTRIES) }
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
    throw new FilesOpError(`Cannot list directory: ${err instanceof Error ? err.message : String(err)}`, 400)
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
  return { path: listDir, selectedFile, entries: sortEntries(entries).slice(0, MAX_ENTRIES) }
}

filesRouter.get('/list', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const host = typeof req.query.host === 'string' && req.query.host ? req.query.host : undefined
    const showHidden = req.query.showHidden === '1' || req.query.showHidden === 'true'
    // cwd + sessionId are OPTIONAL and only enable self-healing — an old client
    // that omits them keeps the previous behavior exactly.
    const cwd = typeof req.query.cwd === 'string' && req.query.cwd ? req.query.cwd : undefined
    const sessionId = typeof req.query.sessionId === 'string' && req.query.sessionId ? req.query.sessionId : undefined
    res.json(await listSessionFiles(req.query.path, host, showHidden, { cwd, sessionId }))
  } catch (err) {
    if (err instanceof FilesOpError) {
      res.status(err.statusCode).json({ error: err.message })
      return
    }
    next(err)
  }
})

/**
 * POST /api/files/reveal { path, mode: 'finder' | 'app' }
 *
 * Hand a LOCAL file/folder to the macOS desktop: reveal it in Finder (`open -R`)
 * or launch it in its default application (`open`). Backs the file-explorer's
 * right-click menu — the console runs on the same Mac as the browser, so this is
 * the same trust boundary as the FileViewer's read (the owner's own machine).
 *
 * Refused for:
 * - cloud mode (no desktop, and the box is reachable by any paired device)
 * - non-macOS (`open` doesn't exist)
 * - remote paths (a `host=` file lives on another machine; nothing to open here)
 * - secret paths, which `file-content` also never serves
 *
 * `mode: 'app'` LAUNCHES a file, so it additionally refuses executable/script
 * types — a `.command`/`.app`/`.sh` written by an agent must not be one click
 * from running. Finder-reveal only selects the icon, so it needs no such gate.
 */
const REVEAL_APP_DENY_EXTS = new Set([
  'command', 'sh', 'bash', 'zsh', 'fish', 'csh', 'ksh', 'app', 'pkg', 'mpkg',
  'dmg', 'jar', 'scpt', 'scptd', 'applescript', 'workflow', 'action', 'osax',
  'terminal', 'webloc', 'url', 'inetloc', 'shortcut', 'exe', 'bat', 'cmd',
  'msi', 'vbs', 'ps1', 'py', 'pl', 'rb', 'php',
])

filesRouter.post('/reveal', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) { res.status(400).json({ error: 'Not available in cloud mode' }); return }
    if (process.platform !== 'darwin') { res.status(400).json({ error: 'Only supported on macOS' }); return }
    const { path: rawPath, mode, host } = req.body ?? {}
    if (typeof host === 'string' && host && host !== '__local__') {
      res.status(400).json({ error: 'Remote files cannot be opened locally' })
      return
    }
    if (typeof rawPath !== 'string' || !rawPath || (mode !== 'finder' && mode !== 'app')) {
      res.status(400).json({ error: 'path and mode (finder|app) are required' })
      return
    }
    // Same guards as file-content's read: expand ~, require absolute, reject any
    // "." / ".." SEGMENT (a real name like "..bar" is fine), and cap the length.
    let fullPath = rawPath
    if (fullPath === '~' || fullPath.startsWith('~/')) fullPath = os.homedir() + fullPath.slice(1)
    if (!path.isAbsolute(fullPath) || fullPath.length > 4096
      || fullPath.split('/').some((seg) => seg === '..' || seg === '.')) {
      res.status(400).json({ error: 'Invalid path' })
      return
    }
    fullPath = path.resolve(fullPath)
    if (isRevealSecretPath(fullPath)) { res.status(403).json({ error: 'Path not permitted' }); return }

    let stat
    try { stat = await fsp.stat(fullPath) } catch { res.status(404).json({ error: 'Not found' }); return }
    if (mode === 'app' && !stat.isDirectory()) {
      const ext = path.extname(fullPath).slice(1).toLowerCase()
      if (REVEAL_APP_DENY_EXTS.has(ext)) {
        res.status(400).json({ error: `Launching .${ext} files is not allowed — use Reveal in Finder` })
        return
      }
    }
    // execFile (not exec): args are never shell-interpolated. Awaited so a
    // failure surfaces as a real error instead of a silently dead menu item.
    const args = mode === 'finder' ? ['-R', fullPath] : [fullPath]
    try {
      await new Promise<void>((resolve, reject) => {
        execFile('open', args, { timeout: 5000 }, (err) => (err ? reject(err) : resolve()))
      })
    } catch (err) {
      res.status(500).json({ error: `open failed: ${err instanceof Error ? err.message : String(err)}` })
      return
    }
    res.json({ ok: true, fullPath })
  } catch (err) {
    next(err)
  }
})

/** Secret files/dirs never handed to the desktop (mirrors file-content's denylist). */
function isRevealSecretPath(resolved: string): boolean {
  const home = os.homedir()
  const denied = [
    path.join(WALNUT_HOME, 'auth.json'),
    path.join(WALNUT_HOME, 'sync', 'bridge-tokens.json'),
    path.join(home, '.aws'),
    path.join(home, '.ssh'),
    path.join(home, '.config', 'walnut-secrets'),
  ]
  return denied.some((d) => resolved === d || resolved.startsWith(d + path.sep))
    || /(^|\/)config\.ya?ml$/.test(resolved)
}

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

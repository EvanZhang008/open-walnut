/**
 * The host side of task directories (src/lib/task-dir.ts says what they are):
 * the daemon makes one when it starts a session for a task, lists its own, and
 * removes the ones the server says are done with, after checking on THIS host
 * that no repo inside still holds work that exists nowhere else.
 *
 * Bundled into the binary daemon and shipped as the task-dir-core.cjs sidecar
 * for the source twin; 'task-dir-v1' is advertised only where it loads.
 *
 * The removal rule is fail-safe. The whole directory stays when any repo in it
 * (clones, worktrees, submodules, repos nested in ignored dirs, bare repos) has
 * uncommitted or untracked files, a stash, or commits that no TRUSTED remote has;
 * when a worktree of a repo in it lives outside it; when the scan could not see
 * everything; and when any git call errors or times out. A remote is trusted
 * when it is not a local path, or is a local path that exists outside the task
 * root and the temp dirs (a leader that fetched a worker's task-dir clone must
 * not make both look pushed). Only a directory carrying this task's marker,
 * under the root, unused since the server looked, with no live session of the
 * task on this host, is ever removed, and its marker goes last, so a removal
 * that fails halfway is listed and retried.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { TASK_DIR_MARKER, isTaskDirId, taskDirPath } from '../lib/task-dir.js'

export { taskDirRoot, taskDirPath, isTaskDirId, TASK_DIR_MARKER } from '../lib/task-dir.js'
export { taskDirSizes, type TaskDirSize } from './task-dir-sizes.js'
// Tool caches pruned while the disk is low (host-cache-prune.ts), and the session history
// archive (transcript-archive.ts): the source twin loads both through this sidecar too.
export { bunTranspilerCacheDirs, pruneHostCaches, type CachePruneResult } from './host-cache-prune.js'
export { archiveTranscripts, liveTranscriptIdsFromPs, restoreSessionAnywhere, resumeSourceId, setArchiveLog, restoreForRead, plainFindResults, type ArchiveReport } from './transcript-archive.js'
// The page silencer's preload rides this sidecar to the source twin (pw-silence-core.ts).
export { ensurePwSilencePreload, pwSilenceDir, withPwSilenceNodeOptions } from './pw-silence-core.js'

/** `home` is the data home of the Walnut that first made it: a host two Walnuts share keeps each one's dirs apart. */
interface Marker { taskId: string; home?: string; createdAt?: string; lastUsedAt?: string; prunedAt?: string; buildsPrunedAt?: string }

function readMarker(dir: string): Marker | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, TASK_DIR_MARKER), 'utf8')) as Marker
    return m && typeof m.taskId === 'string' ? m : null
  } catch { return null }
}

/**
 * Make (or reuse) the task's directory and stamp its marker. Sync on purpose:
 * it runs once per spawn, two mkdirs and one small write. Null for an id that
 * cannot be a path or when the disk refuses (the session then starts without
 * one, exactly like on an older daemon).
 */
export function ensureTaskDir(root: string, taskId: unknown, home?: unknown, now: Date = new Date()): string | null {
  if (!isTaskDirId(taskId)) return null
  const dir = taskDirPath(root, taskId)!
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const prev = readMarker(dir)
    // First writer wins: a later spawner (an ephemeral server reaching a shared
    // host) never takes over who the directory belongs to.
    const owner = prev?.home ?? (typeof home === 'string' && home && home.length <= 1024 ? home : undefined)
    const marker: Marker = { taskId, ...(owner ? { home: owner } : {}), createdAt: prev?.createdAt ?? now.toISOString(), lastUsedAt: now.toISOString() }
    fs.writeFileSync(path.join(dir, TASK_DIR_MARKER), JSON.stringify(marker) + '\n', { mode: 0o600 })
    return dir
  } catch {
    return null
  }
}

export interface TaskDirEntry { taskId: string; path: string; home?: string; createdAt?: string; lastUsedAt?: string; prunedAt?: string; buildsPrunedAt?: string; mtimeMs: number }

export async function listTaskDirs(root: string): Promise<TaskDirEntry[]> {
  let names: string[]
  try { names = await fsp.readdir(root) } catch { return [] }
  const out: TaskDirEntry[] = []
  for (const name of names) {
    if (!isTaskDirId(name)) continue
    const dir = path.join(root, name)
    const marker = readMarker(dir)
    if (!marker || marker.taskId !== name) continue
    let mtimeMs = 0
    try { mtimeMs = (await fsp.stat(dir)).mtimeMs } catch { continue }
    out.push({ taskId: name, path: dir, home: marker.home, createdAt: marker.createdAt, lastUsedAt: marker.lastUsedAt, prunedAt: marker.prunedAt, buildsPrunedAt: marker.buildsPrunedAt, mtimeMs })
  }
  return out
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string>

const GIT_TIMEOUT_MS = 20_000
const MAX_REPOS = 40
const MAX_DEPTH = 6
// 2026-11-08: one test data home or one Xcode build tree held more than the old
// 20,000, so the check gave up and a finished task's directory was never pruned.
const MAX_DIRS = 100_000
// Only names that can never hold a repo the session made; ignored dirs
// (`build/`, `vendor/`, `.claude/worktrees/`) are walked like any other.
const SKIP_DIRS = new Set(['node_modules', '.git'])

/**
 * An Xcode derived data folder under any name (`xcodebuild -derivedDataPath
 * dd-queue`): a `Build` folder beside the module cache or the index. 2026-11-08:
 * eight such folders held about 9 GB in task directories under names like
 * `ios-final-derived-data`, and no rule knew them. Only the folders Xcode
 * rebuilds inside it go (DERIVED_PARTS), never the folder itself: logs, notes
 * or videos kept beside them stay.
 */
const isDerivedData = (entries: fs.Dirent[]): boolean =>
  entries.some((e) => e.name === 'Build' && e.isDirectory())
  && entries.some((e) => (e.name === 'ModuleCache.noindex' || e.name === 'Index.noindex') && e.isDirectory())
const DERIVED_PARTS = new Set(['Build', 'ModuleCache.noindex', 'Index.noindex', 'CompilationCache.noindex', 'SDKStatCaches.noindex'])

/** git with a clean env: an inherited GIT_DIR outranks cwd (src/lib/git-env.ts). */
export const defaultGitRunner: GitRunner = (cwd, args) => new Promise((resolve, reject) => {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k]
  execFile('git', args, { cwd, env, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 << 20 }, (err, stdout) => {
    if (err) reject(err); else resolve(String(stdout))
  })
})

/** Temp dirs: a remote there is gone after the next boot (WALNUT_TASK_DIR_VOLATILE replaces the list, colon-separated; tests). */
export function volatileRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.WALNUT_TASK_DIR_VOLATILE !== undefined) return env.WALNUT_TASK_DIR_VOLATILE.split(':').filter((p) => path.isAbsolute(p))
  return ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', os.tmpdir()]
}

const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
/** The real path when it exists (macOS /var is /private/var; git reports real paths). */
const real = (p: string) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }

interface FoundRepo { dir: string; kind: 'work' | 'linked' | 'bare' }

/**
 * Every repo under the directory: work trees (`.git` dir), linked trees (`.git`
 * file: a worktree or a submodule) and bare repos. It descends into repos too,
 * so a submodule, a worktree or a clone kept inside a clone is checked on its
 * own. False when the walk hit a limit and saw only part of the tree.
 */
async function findRepos(dir: string, depth: number, out: FoundRepo[], budget: { dirs: number }): Promise<boolean> {
  if (out.length > MAX_REPOS || --budget.dirs < 0) return false
  let entries: fs.Dirent[]
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return false }
  const dotGit = entries.find((e) => e.name === '.git')
  if (dotGit) out.push({ dir, kind: dotGit.isFile() ? 'linked' : 'work' })
  else if (['HEAD', 'objects', 'refs'].every((n) => entries.some((e) => e.name === n))) { out.push({ dir, kind: 'bare' }); return true }
  const subdirs = entries.filter((e) => e.isDirectory() && !e.isSymbolicLink() && !SKIP_DIRS.has(e.name))
  if (subdirs.length === 0) return true
  // Past the depth limit, a repo's own tree is covered by its status; anything else is unseen.
  if (depth >= MAX_DEPTH) return !!dotGit
  let complete = true
  for (const e of subdirs) complete = (await findRepos(path.join(dir, e.name), depth + 1, out, budget)) && complete
  return complete
}

export interface TaskDirInspection {
  /** Why the directory must stay; empty when nothing in it is unique. */
  reasons: string[]
  /** git dirs OUTSIDE the directory that list a worktree inside it (pruned after a removal). */
  worktreeOwners: string[]
}

const isNoHead = (msg: string) => /unknown revision|ambiguous argument 'HEAD'|does not have any commits|bad revision 'HEAD'/i.test(msg)

/**
 * Uncommitted changes or untracked files. An untracked SYMLINK does not count:
 * it holds nothing of its own (a clone's `node_modules -> <the main checkout's>`
 * would otherwise keep every such clone forever).
 */
async function hasLocalChanges(repo: string, git: GitRunner): Promise<boolean> {
  const out = await git(repo, ['status', '--porcelain', '-z', '--untracked-files=normal', '--ignore-submodules=none'])
  for (const entry of out.split('\0')) {
    if (!entry) continue
    if (!entry.startsWith('?? ')) return true
    const rel = entry.slice(3).replace(/\/$/, '')
    try { if (!fs.lstatSync(path.join(repo, rel)).isSymbolicLink()) return true } catch { return true }
  }
  return false
}

/** `--remotes=<name>` for each remote whose copy will still be there tomorrow. */
async function trustedRemoteArgs(repo: string, root: string, volatile: string[], git: GitRunner): Promise<string[]> {
  const names = (await git(repo, ['remote'])).split('\n').map((s) => s.trim()).filter(Boolean)
  const out: string[] = []
  for (const name of names) {
    const url = (await git(repo, ['remote', 'get-url', name]).catch(() => '')).trim()
    if (!url) continue
    const local = url.startsWith('file://') ? url.slice(7) : (url.startsWith('/') || url.startsWith('.') || url.startsWith('~')) ? url : null
    if (local !== null) {
      const abs = path.resolve(repo, local.replace(/^~(?=\/|$)/, os.homedir()))
      if (!fs.existsSync(abs)) continue
      const r = real(abs)
      if (within(r, root) || volatile.some((v) => within(r, real(v)) || within(abs, v))) continue
    }
    out.push(`--remotes=${name}`)
  }
  return out
}

/** Commits reachable from the branches (and HEAD) that no trusted remote has; retried without HEAD when it has none (an orphan branch). */
async function unpushed(repo: string, trusted: string[], git: GitRunner, withHead = true): Promise<boolean> {
  const args = ['log', '--branches', ...(withHead ? ['HEAD'] : []), ...(trusted.length ? ['--not', ...trusted] : []), '-n', '1', '--format=%h']
  try {
    return (await git(repo, args)).trim() !== ''
  } catch (err) {
    if (withHead && isNoHead((err as Error).message || '')) return unpushed(repo, trusted, git, false)
    throw err
  }
}

export async function inspectTaskDir(
  dir: string,
  git: GitRunner = defaultGitRunner,
  ctx: { root?: string; volatile?: string[] } = {},
): Promise<TaskDirInspection> {
  dir = real(dir)
  const root = real(ctx.root ?? path.dirname(dir))
  const volatile = ctx.volatile ?? volatileRoots()
  const repos: FoundRepo[] = []
  const complete = await findRepos(dir, 0, repos, { dirs: MAX_DIRS })
  if (repos.length > MAX_REPOS) return { reasons: [`more than ${MAX_REPOS} repos to check`], worktreeOwners: [] }
  const reasons: string[] = complete ? [] : ['too large or unreadable to check every folder']
  const owners = new Set<string>()
  for (const repo of repos) {
    const name = path.relative(dir, repo.dir) || '.'
    try {
      if (repo.kind === 'bare') {
        // Nothing says whether its commits exist anywhere else.
        if ((await git(repo.dir, ['for-each-ref', '--count=1', '--format=%(refname)'])).trim()) reasons.push(`${name}: a bare repo with commits`)
        continue
      }
      if (await hasLocalChanges(repo.dir, git)) reasons.push(`${name}: uncommitted or untracked files`)
      if ((await git(repo.dir, ['stash', 'list', '-n', '1'])).trim()) reasons.push(`${name}: a stash`)
      const common = real(path.resolve(repo.dir, (await git(repo.dir, ['rev-parse', '--git-common-dir'])).trim()))
      if (repo.kind === 'linked' && !within(common, dir)) {
        // A worktree of a repo kept elsewhere: its branches live there and
        // outlast this directory; only a detached HEAD's own commits go with it.
        const own = await git(repo.dir, ['log', 'HEAD', '--not', '--branches', '--tags', '--remotes', '-n', '1', '--format=%h'])
          .catch((e) => { if (isNoHead((e as Error).message || '')) return ''; throw e })
        if (own.trim()) reasons.push(`${name}: commits only on its detached HEAD`)
        owners.add(common)
        continue
      }
      // A worktree of THIS repo outside the directory would lose its repo.
      if (repo.kind === 'work') {
        const listed = await git(repo.dir, ['worktree', 'list', '--porcelain'])
        const outside = listed.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => real(l.slice(9)))
          .filter((p) => p !== real(repo.dir) && !within(p, dir))
        if (outside.length > 0) reasons.push(`${name}: a worktree of it lives outside (${outside[0]})`)
      }
      if (await unpushed(repo.dir, await trustedRemoteArgs(repo.dir, root, volatile, git), git)) reasons.push(`${name}: commits not on any remote`)
    } catch (err) {
      const msg = (err as Error).message || ''
      reasons.push(`${name}: could not check (${msg.split('\n')[0].slice(0, 120)})`)
    }
  }
  return { reasons, worktreeOwners: [...owners] }
}

/** Why this directory must stay, or [] when nothing in it is unique. */
export async function unmergedWork(dir: string, git: GitRunner = defaultGitRunner, ctx?: { root?: string; volatile?: string[] }): Promise<string[]> {
  return (await inspectTaskDir(dir, git, ctx)).reasons
}

export interface RemoveResult {
  removed: string[]
  kept: Array<{ taskId: string; reasons: string[] }>
  missing: string[]
}

/** A removal request: a task id, or the id with the time (ms) the server last saw the directory used. */
export type RemoveItem = string | { taskId: string; usedBefore?: number }

/** Everything but the marker first, then the marker and the directory. */
async function removeDir(dir: string): Promise<void> {
  for (const name of await fsp.readdir(dir)) {
    if (name !== TASK_DIR_MARKER) await fsp.rm(path.join(dir, name), { recursive: true, force: true })
  }
  await fsp.rm(dir, { recursive: true, force: true })
}

/**
 * Remove the named task directories that hold nothing unique. `busy` says a
 * live session on this host belongs to the task or works inside the path,
 * which keeps it. `usedBefore` keeps one a session used since the server
 * looked: the marker is read again right before anything is deleted.
 */
export async function removeTaskDirs(
  root: string,
  items: unknown[],
  opts: { busy?: (dir: string, taskId: string) => boolean; git?: GitRunner; volatile?: string[] } = {},
): Promise<RemoveResult> {
  const res: RemoveResult = { removed: [], kept: [], missing: [] }
  const realRoot = path.resolve(root)
  if (realRoot.split(path.sep).filter(Boolean).length < 2) return res
  const git = opts.git ?? defaultGitRunner
  for (const raw of items.slice(0, 500)) {
    const item = raw as RemoveItem
    const id = typeof item === 'string' ? item : item && typeof item === 'object' ? item.taskId : undefined
    if (!isTaskDirId(id)) continue
    const usedBefore = typeof item === 'object' && typeof item.usedBefore === 'number' ? item.usedBefore : undefined
    const dir = taskDirPath(realRoot, id)!
    const stillUnused = (): boolean => {
      if (usedBefore === undefined) return true
      const last = Date.parse(readMarker(dir)?.lastUsedAt ?? '')
      return !Number.isFinite(last) || last <= usedBefore
    }
    const marker = readMarker(dir)
    if (!marker) { res.missing.push(id); continue }
    if (marker.taskId !== id) { res.kept.push({ taskId: id, reasons: ['marker names another task'] }); continue }
    if (opts.busy?.(dir, id)) { res.kept.push({ taskId: id, reasons: ['a live session works in it'] }); continue }
    const { reasons, worktreeOwners } = await inspectTaskDir(dir, git, { root: realRoot, volatile: opts.volatile })
    if (reasons.length > 0) { res.kept.push({ taskId: id, reasons }); continue }
    // The check can take a while; a session that started meanwhile wins.
    if (!stillUnused() || opts.busy?.(dir, id)) { res.kept.push({ taskId: id, reasons: ['used again since the sweep looked'] }); continue }
    try {
      await removeDir(dir)
      res.removed.push(id)
      // The repo a removed worktree belonged to forgets it, so its branch can be checked out again.
      for (const owner of worktreeOwners) await git(path.dirname(owner), ['--git-dir', owner, 'worktree', 'prune']).catch(() => {})
    } catch (err) {
      res.kept.push({ taskId: id, reasons: [`remove failed: ${(err as Error).message}`] })
    }
  }
  return res
}

// ── Pruning a finished task's directory (task-dir-prune-v1) ──
// A day after its task completed, the bulk goes and the rest stays until the
// whole directory may go: each repo that holds nothing unique (the rule above,
// for that repo alone), and rebuildable build output git does not track. The
// evidence, notes and any repo with work of its own stay. 2026-10-31: task
// directories held 27 GB, most of it clean clones and node_modules of tasks
// already done, and the Mac fell under 25 GB free.

/** Rebuildable wherever it is, when git does not track it. */
/** src/binary/runtime-tree.ts RUNTIME_MARKER (a literal: this file is also the daemon's sidecar). */
const RUNTIME_TREE_MARKER = '.walnut-runtime'
const BUILD_DIRS = new Set(['node_modules', '.build', '.next', '.turbo'])
/** Rebuildable only when the repo holding it ignores it: outside one (or unignored) a `dist/` or a test report is usually kept as evidence. */
const IGNORED_BUILD_DIRS = new Set(['dist', 'playwright-report', 'test-results'])
/** Ignored files a clean clone may hold and still go whole: build output and OS litter. Any other ignored file (an .env, local notes) keeps it. */
const isDisposableIgnored = (rel: string): boolean =>
  rel.split('/').some((seg) => BUILD_DIRS.has(seg) || IGNORED_BUILD_DIRS.has(seg)) || /(^|\/)\.DS_Store$|\.tsbuildinfo$/.test(rel)

export interface PruneResult {
  pruned: Array<{ taskId: string; repos: string[]; builds: string[] }>
  kept: Array<{ taskId: string; reasons: string[] }>
  missing: string[]
}

/** Every objects directory a repo under the root borrows from (`clone --shared`): removing one breaks the borrower. Null when the walk could not see everything. */
async function borrowedObjectDirs(root: string): Promise<Set<string> | null> {
  const out = new Set<string>()
  const budget = { dirs: 500_000 }
  const readAlternates = async (objects: string) => {
    let text = ''
    try { text = await fsp.readFile(path.join(objects, 'info', 'alternates'), 'utf8') } catch { return }
    for (const line of text.split('\n')) if (line.trim() && !line.startsWith('#')) out.add(real(path.resolve(objects, line.trim())))
  }
  // No depth limit: a borrower nested anywhere must be seen (the budget bounds the cost).
  const walk = async (dir: string, depth: number): Promise<boolean> => {
    if (--budget.dirs < 0) return false
    let entries: fs.Dirent[]
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return false }
    // A git dir (a .git, a bare repo): read what it borrows, and skip its object store.
    const gitDir = entries.some((e) => e.name === 'objects' && e.isDirectory()) && entries.some((e) => e.name === 'HEAD')
    if (gitDir) await readAlternates(path.join(dir, 'objects'))
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name === 'node_modules' || (gitDir && e.name === 'objects')) continue
      if (!(await walk(path.join(dir, e.name), depth + 1))) return false
    }
    return true
  }
  let names: string[]
  try { names = await fsp.readdir(root) } catch { return null }
  for (const name of names) if (isTaskDirId(name) && !(await walk(path.join(root, name), 0))) return null
  return out
}

/** Build output dirs under dir (not inside .git, not below another build dir, never through a symlink); `derived` collects the Xcode derived data folders found by their shape. */
async function findBuildDirs(dir: string, depth: number, out: string[], budget: { dirs: number; partial?: boolean }, derived: Set<string>, read?: fs.Dirent[]): Promise<void> {
  if (depth > MAX_DEPTH + 2 || --budget.dirs < 0) return
  let entries: fs.Dirent[]
  if (read) entries = read
  else try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { budget.partial = true; return }
  // A compiled Walnut file's unpacked runtime tree (src/binary/runtime-tree.ts RUNTIME_MARKER): its
  // node_modules and dist are the program's own files, not build output (2026-11-10: a Demo's file
  // died at boot, 'Missing tiktoken_bg.wasm', after its tree lost node_modules here).
  if (entries.some((e) => e.name === RUNTIME_TREE_MARKER && !e.isDirectory())) return
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink() || e.name === '.git') continue
    const p = path.join(dir, e.name)
    if (BUILD_DIRS.has(e.name) || IGNORED_BUILD_DIRS.has(e.name)) { out.push(p); continue }
    // Deeper than the walk goes: unseen, so the round is not finished.
    if (depth + 1 > MAX_DEPTH + 2) { budget.partial = true; continue }
    let inner: fs.Dirent[]
    try { inner = await fsp.readdir(p, { withFileTypes: true }) } catch { budget.partial = true; continue }
    if (!inner.some((x) => x.name === '.git') && isDerivedData(inner)) {
      for (const x of inner) if (x.isDirectory() && !x.isSymbolicLink() && DERIVED_PARTS.has(x.name)) { out.push(path.join(p, x.name)); derived.add(path.join(p, x.name)) }
      continue
    }
    await findBuildDirs(p, depth + 1, out, budget, derived, inner)
  }
}

/**
 * The nearest repo above a build folder, up to and including the task
 * directory: its path, null when none holds it, 'unsure' when an ancestor is a
 * bare repo or cannot be read. (Repos INSIDE the folder: scanBuild.)
 */
function repoHolding(build: string, top: string): string | null | 'unsure' {
  for (let p = path.dirname(build); within(p, top); p = path.dirname(p)) {
    let names: string[]
    try { names = fs.readdirSync(p) } catch { return 'unsure' }
    if (names.includes('.git')) return p
    if (['HEAD', 'objects', 'refs'].every((n) => names.includes(n))) return 'unsure'
    if (p === top) break
  }
  return null
}

const BUILD_SCAN_DIRS = 400_000
const BUILD_SCAN_FILES = 2_000_000

/**
 * The whole build folder, walked before it may go: whether a repo (a `.git`,
 * a bare repo) lives anywhere in it, the folder itself included (a clone kept
 * in DerivedData or node_modules may hold work of its own: never removed);
 * whether the walk saw everything (over budget or unreadable: asked again next
 * round); and the newest time of anything in it.
 */
async function scanBuild(root: string): Promise<{ repo: boolean; complete: boolean; newest: number }> {
  let dirs = BUILD_SCAN_DIRS
  let files = BUILD_SCAN_FILES
  let newest = 0
  const stack = [root]
  while (stack.length > 0) {
    if (--dirs < 0) return { repo: false, complete: false, newest }
    const d = stack.pop()!
    let entries: fs.Dirent[]
    try { entries = await fsp.readdir(d, { withFileTypes: true }); newest = Math.max(newest, fs.lstatSync(d).mtimeMs) } catch { return { repo: false, complete: false, newest } }
    if (entries.some((e) => e.name === '.git')) return { repo: true, complete: true, newest }
    if (['HEAD', 'objects', 'refs'].every((n) => entries.some((e) => e.name === n))) return { repo: true, complete: true, newest }
    for (const e of entries) {
      if (e.isDirectory() && !e.isSymbolicLink()) { stack.push(path.join(d, e.name)); continue }
      // A file rewritten in place changes no folder's time.
      if (--files < 0) return { repo: false, complete: false, newest }
      try { newest = Math.max(newest, fs.lstatSync(path.join(d, e.name)).mtimeMs) } catch { /* gone meanwhile */ }
    }
    // Yield now and then: one walk can lstat a million files.
    if (dirs % 2000 === 0) await new Promise((r) => setImmediate(r))
  }
  return { repo: false, complete: true, newest }
}

/**
 * Every path under `under` some process on this host has open right now: a working
 * directory, an open file, a mapped binary (a running app's executable). From `lsof`, or
 * /proc where there is no lsof; null when neither answers, so nothing in use is pruned.
 */
export async function readOpenPaths(under: string): Promise<string[] | null> {
  const prefix = real(under)
  const keep = (p: string) => p === prefix || p.startsWith(prefix + path.sep) || p.startsWith(under + path.sep)
  let lsofMissing = false
  const fromLsof = await new Promise<string[] | null>((resolve) => {
    execFile('lsof', ['-n', '-P', '-w', '-F', 'n'], { timeout: 90_000, maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | null
      if (e?.code === 'ENOENT') { lsofMissing = true; return resolve(null) }
      // Only a whole answer counts: exit 0, or 1 (lsof's "some file could not be listed", printed
      // in full otherwise). A timeout, a kill, a full buffer or any other error is no answer.
      if (e && !(e.code as unknown === 1 && !e.killed && !e.signal)) return resolve(null)
      if (!stdout) return resolve(null)
      resolve(stdout.split('\n').filter((l) => l.startsWith('n')).map((l) => l.slice(1)).filter(keep))
    })
  })
  if (fromLsof) return [...new Set(fromLsof)]
  if (!lsofMissing || !fs.existsSync('/proc/self/fd')) return null
  const out = new Set<string>()
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    const links = ['cwd', 'exe']
    try { for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) links.push(`fd/${fd}`) } catch { /* not ours or gone */ }
    for (const l of links) { try { const t = fs.readlinkSync(`/proc/${pid}/${l}`); if (keep(t)) out.add(t) } catch { /* gone */ } }
  }
  return [...out]
}

/** What runs on the host now: a live session, a running host command, an ACP worker. */
export interface HostWork { task?: unknown; cwd?: unknown }

/**
 * Whether the task's directory is in use: work of the task itself, or work
 * whose folder is the directory or inside it, comparing real paths (macOS
 * /var is /private/var; a home reached through a link). The daemons' `busy`.
 */
export function taskDirInUse(dir: string, taskId: string, work: Iterable<HostWork>): boolean {
  let realDir: string | undefined
  for (const w of work) {
    if (w.task === taskId) return true
    if (typeof w.cwd !== 'string' || !w.cwd) continue
    realDir ??= real(dir)
    if (within(real(w.cwd), realDir)) return true
  }
  return false
}

/** The newest change time of a folder and its direct entries (a build folder that something is writing into reads new). */
function newestMtime(dir: string): number {
  let newest = 0
  try {
    newest = fs.lstatSync(dir).mtimeMs
    let n = 0
    for (const name of fs.readdirSync(dir)) {
      if (++n > 5000) break
      try { newest = Math.max(newest, fs.lstatSync(path.join(dir, name)).mtimeMs) } catch { /* gone meanwhile */ }
    }
  } catch { return Number.POSITIVE_INFINITY }
  return newest
}

export interface PruneOptions {
  busy?: (dir: string, taskId: string) => boolean
  git?: GitRunner
  volatile?: string[]
  now?: Date
  dryRun?: boolean
  /** Only build output, never a repo, and the marker records `buildsPrunedAt` (pruneTaskBuilds). */
  buildsOnly?: boolean
  /** Keep a build folder that it, any folder inside it, its parent or a direct entry of those changed at or after this time (ms). */
  idleBefore?: number
  /**
   * With buildsOnly, while the host's disk is below its floor: a directory in use is pruned
   * too, but only build output untouched for LIVE_MIN_IDLE_MS whose project folder (the one
   * holding it) no process has open (a working directory, an open or mapped file). Read once
   * per directory right before its first removal; null = could not tell, so nothing goes.
   */
  openPaths?: () => Promise<string[] | null>
}

/**
 * The least a build folder of a task in use stays untouched before a low disk takes it. An app
 * under test is only read, which changes no time (2026-11-08: a pass took a running simulator
 * check's app); the open-file check is what protects one in use right now.
 */
export const LIVE_MIN_IDLE_MS = 6 * 3_600_000

/** A `dist` beside the package.json and the src it is built from: rebuildable. A lone dist may be a package's only code. */
const isSourceTreeDist = (b: string): boolean => {
  if (path.basename(b) !== 'dist') return false
  const p = path.dirname(b)
  try { return fs.statSync(path.join(p, 'package.json')).isFile() && fs.statSync(path.join(p, 'src')).isDirectory() } catch { return false }
}

/**
 * Prune the named task directories. Never the directory itself, never a repo
 * the removal rule keeps, never a repo another repo under the root borrows
 * objects from, never tracked files. The directory's mtime is put back, so
 * pruning does not count as a use, and the marker records `prunedAt`.
 */
export async function pruneTaskDirs(root: string, items: unknown[], opts: PruneOptions = {}): Promise<PruneResult> {
  const res: PruneResult = { pruned: [], kept: [], missing: [] }
  const realRoot = path.resolve(root)
  if (realRoot.split(path.sep).filter(Boolean).length < 2) return res
  const git = opts.git ?? defaultGitRunner
  let borrowed: Set<string> | null | undefined
  for (const raw of items.slice(0, 200)) {
    const item = raw as RemoveItem
    const id = typeof item === 'string' ? item : item && typeof item === 'object' ? item.taskId : undefined
    if (!isTaskDirId(id)) continue
    const usedBefore = typeof item === 'object' && typeof item.usedBefore === 'number' ? item.usedBefore : undefined
    const dir = taskDirPath(realRoot, id)!
    const marker = readMarker(dir)
    if (!marker) { res.missing.push(id); continue }
    if (marker.taskId !== id) { res.kept.push({ taskId: id, reasons: ['marker names another task'] }); continue }
    // A low disk on a host prunes a directory in use too, guarded by the open-file check below.
    const live = opts.buildsOnly === true && opts.openPaths !== undefined
    const inUse = opts.busy?.(dir, id) === true
    const unused = (): boolean => {
      if (live) return true
      if (opts.busy?.(dir, id)) return false
      if (usedBefore === undefined) return true
      const last = Date.parse(readMarker(dir)?.lastUsedAt ?? '')
      return !Number.isFinite(last) || last <= usedBefore
    }
    if (!unused()) { res.kept.push({ taskId: id, reasons: ['a live session works in it'] }); continue }
    if (!opts.buildsOnly && borrowed === undefined) borrowed = await borrowedObjectDirs(realRoot)
    if (!opts.buildsOnly && !borrowed) { res.kept.push({ taskId: id, reasons: ['could not check which repos borrow objects'] }); continue }
    let before: fs.Stats | null = null
    try { before = fs.statSync(dir) } catch { /* gone */ }
    const done = { taskId: id, repos: [] as string[], builds: [] as string[] }
    const repos: FoundRepo[] = []
    if (!opts.buildsOnly) await findRepos(dir, 0, repos, { dirs: MAX_DIRS })
    const top = repos.filter((r) => r.dir !== dir && !repos.some((o) => o !== r && within(r.dir, o.dir) && o.dir !== r.dir))
    for (const repo of top) {
      const { reasons, worktreeOwners } = await inspectTaskDir(repo.dir, git, { root: realRoot, volatile: opts.volatile })
      if (reasons.length > 0) continue
      // Stricter than the whole-directory rule, which runs days later: an ignored file that is not build output keeps the repo.
      try {
        const ignored = (await git(repo.dir, ['status', '--porcelain', '-z', '--ignored=matching', '--untracked-files=normal'])).split('\0')
          .filter((e) => e.startsWith('!! ')).map((e) => e.slice(3).replace(/\/$/, ''))
        if (ignored.some((rel) => !isDisposableIgnored(rel))) continue
      } catch { continue }
      let objects = ''
      try { objects = real(path.resolve(repo.dir, (await git(repo.dir, ['rev-parse', '--git-path', 'objects'])).trim())) } catch { continue }
      if ([...borrowed!].some((b) => within(b, real(repo.dir)) || b === objects)) continue
      if (!unused()) break
      try {
        if (!opts.dryRun) await fsp.rm(repo.dir, { recursive: true, force: true })
        done.repos.push(path.relative(dir, repo.dir))
        for (const owner of worktreeOwners) await git(path.dirname(owner), ['--git-dir', owner, 'worktree', 'prune']).catch(() => {})
      } catch { /* left for the whole-directory removal */ }
    }
    const builds: string[] = []
    const derived = new Set<string>()
    // Each build folder's repo is read from its own ancestors, so a tree too big or too deep
    // for the repo walk (a copied source tree, a test data home) still has its build output
    // judged (2026-11-08: every large directory on the Mac had `sawAll` false and kept all of it).
    const budget: { dirs: number; partial?: boolean } = { dirs: MAX_DIRS }
    await findBuildDirs(dir, 0, builds, budget, derived)
    // A round that left something for later is not a finished one: the marker is not stamped.
    // A directory in use is never stamped done: its next round looks again.
    let deferred = budget.dirs < 0 || budget.partial === true || (live && inUse)
    const idleBefore = live ? Math.min(opts.idleBefore ?? Date.now(), Date.now() - LIVE_MIN_IDLE_MS) : opts.idleBefore
    // Read anew right before each removal: a process may start in another copy while the checks run.
    const realDir = real(dir)
    const openNear = async (b: string): Promise<boolean> => {
      if (!live) return false
      const open = (await opts.openPaths!().catch(() => null))?.map(real) ?? null
      if (open === null) return true
      const project = real(derived.has(b) ? path.dirname(path.dirname(b)) : path.dirname(b))
      // Inside the project, or a folder above it inside the task directory: a server working
      // from there reads the build lazily and holds no file of it open between requests.
      return open.some((o) => within(o, project) || (within(project, o) && within(o, realDir)))
    }
    // The folder holding a build folder (a clone, a copied tree, a derived data folder) counts too:
    // tests writing their reports beside node_modules mean someone works there.
    // `fresh` also reads the time of everything inside the folder (the walk below): a build
    // something wrote into lately is someone's.
    const fresh = (b: string, newest = 0) => idleBefore !== undefined
      && Math.max(newest, newestMtime(b), newestMtime(path.dirname(b))) >= idleBefore
    for (const b of builds) {
      if (!fs.existsSync(b) || !unused()) continue
      if (fresh(b)) { deferred = true; continue }
      const holder = repoHolding(b, dir)
      // Could not tell: try again next round.
      if (holder === 'unsure') { deferred = true; continue }
      if (holder) {
        const rel = path.relative(holder, b)
        try { if ((await git(holder, ['ls-files', '-z', '--', rel])).length > 0) continue } catch { deferred = true; continue }
        if (IGNORED_BUILD_DIRS.has(path.basename(b))) {
          // check-ignore exits 1 for "not ignored" (kept for good) and 128 on an error (asked again).
          try { await git(holder, ['check-ignore', '-q', '--', rel]) } catch (err) { if ((err as { code?: unknown }).code !== 1) deferred = true; continue }
        }
      } else if (!BUILD_DIRS.has(path.basename(b)) && !derived.has(b) && !isSourceTreeDist(b)) continue
      if (opts.dryRun && done.repos.some((r) => within(b, path.join(dir, r)))) continue
      const scan = await scanBuild(b)
      if (scan.repo) continue
      if (!scan.complete) { deferred = true; continue }
      // The checks above awaited git and a walk: a session that started meanwhile, or a write into the folder, wins.
      if (!unused()) { deferred = true; break }
      if (fresh(b, scan.newest)) { deferred = true; continue }
      // Last, so the open files are read right before the removal.
      if (await openNear(b)) { deferred = true; continue }
      try {
        if (!opts.dryRun) {
          // Put the parent's time back: a removal is not a use, and a sibling build folder judged next must not read new.
          let parent: fs.Stats | null = null
          try { parent = fs.statSync(path.dirname(b)) } catch { /* gone */ }
          await fsp.rm(b, { recursive: true, force: true })
          if (parent) try { fs.utimesSync(path.dirname(b), parent.atime, parent.mtime) } catch { /* left new: the next round waits */ }
        }
        done.builds.push(path.relative(dir, b))
      } catch { deferred = true }
    }
    if (!opts.dryRun) try {
      const m = readMarker(dir)
      const at = (opts.now ?? new Date()).toISOString()
      const stamp = opts.buildsOnly ? (deferred ? {} : { buildsPrunedAt: at }) : { prunedAt: at }
      if (m && Object.keys(stamp).length > 0) fs.writeFileSync(path.join(dir, TASK_DIR_MARKER), JSON.stringify({ ...m, ...stamp }) + '\n', { mode: 0o600 })
      if (before) fs.utimesSync(dir, before.atime, before.mtime)
    } catch { /* the next sweep prunes again */ }
    res.pruned.push(done)
  }
  return res
}

/**
 * The build output alone of directories whose task may still be open
 * (task-dir-prune-builds-v1): every repo, file and evidence stays, and so does
 * a build folder that changed after `idleBefore`. 2026-11-08: open tasks (leads,
 * long reviews, tasks waiting for days) held 70 of 74 GB of task directories,
 * and only a finished task was ever pruned, so the Mac filled to 99%.
 */
export function pruneTaskBuilds(root: string, items: unknown[], opts: Omit<PruneOptions, 'buildsOnly'> = {}): Promise<PruneResult> {
  return pruneTaskDirs(root, items, { ...opts, buildsOnly: true })
}

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

/** `home` is the data home of the Walnut that first made it: a host two Walnuts share keeps each one's dirs apart. */
interface Marker { taskId: string; home?: string; createdAt?: string; lastUsedAt?: string; prunedAt?: string }

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

export interface TaskDirEntry { taskId: string; path: string; home?: string; createdAt?: string; lastUsedAt?: string; prunedAt?: string; mtimeMs: number }

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
    out.push({ taskId: name, path: dir, home: marker.home, createdAt: marker.createdAt, lastUsedAt: marker.lastUsedAt, prunedAt: marker.prunedAt, mtimeMs })
  }
  return out
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string>

const GIT_TIMEOUT_MS = 20_000
const MAX_REPOS = 40
const MAX_DEPTH = 6
const MAX_DIRS = 20_000
// Only names that can never hold a repo the session made; ignored dirs
// (`build/`, `vendor/`, `.claude/worktrees/`) are walked like any other.
const SKIP_DIRS = new Set(['node_modules', '.git'])

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
const BUILD_DIRS = new Set(['node_modules', 'DerivedData', '.build', '.next', '.turbo'])
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

/** Build output dirs under dir (not inside .git, not below another build dir, never through a symlink). */
async function findBuildDirs(dir: string, depth: number, out: string[], budget: { dirs: number }): Promise<void> {
  if (depth > MAX_DEPTH + 2 || --budget.dirs < 0) return
  let entries: fs.Dirent[]
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink() || e.name === '.git') continue
    const p = path.join(dir, e.name)
    if (BUILD_DIRS.has(e.name) || IGNORED_BUILD_DIRS.has(e.name)) out.push(p)
    else await findBuildDirs(p, depth + 1, out, budget)
  }
}

/**
 * Prune the named task directories. Never the directory itself, never a repo
 * the removal rule keeps, never a repo another repo under the root borrows
 * objects from, never tracked files. The directory's mtime is put back, so
 * pruning does not count as a use, and the marker records `prunedAt`.
 */
export async function pruneTaskDirs(
  root: string,
  items: unknown[],
  opts: { busy?: (dir: string, taskId: string) => boolean; git?: GitRunner; volatile?: string[]; now?: Date; dryRun?: boolean } = {},
): Promise<PruneResult> {
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
    const unused = (): boolean => {
      if (opts.busy?.(dir, id)) return false
      if (usedBefore === undefined) return true
      const last = Date.parse(readMarker(dir)?.lastUsedAt ?? '')
      return !Number.isFinite(last) || last <= usedBefore
    }
    if (!unused()) { res.kept.push({ taskId: id, reasons: ['a live session works in it'] }); continue }
    if (borrowed === undefined) borrowed = await borrowedObjectDirs(realRoot)
    if (borrowed === null) { res.kept.push({ taskId: id, reasons: ['could not check which repos borrow objects'] }); continue }
    let before: fs.Stats | null = null
    try { before = fs.statSync(dir) } catch { /* gone */ }
    const done = { taskId: id, repos: [] as string[], builds: [] as string[] }
    const repos: FoundRepo[] = []
    // A repo the walk missed would make its build dirs look like loose output: no build pruning then.
    const sawAll = await findRepos(dir, 0, repos, { dirs: MAX_DIRS }) && repos.length <= MAX_REPOS
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
      if ([...borrowed].some((b) => within(b, real(repo.dir)) || b === objects)) continue
      if (!unused()) break
      try {
        if (!opts.dryRun) await fsp.rm(repo.dir, { recursive: true, force: true })
        done.repos.push(path.relative(dir, repo.dir))
        for (const owner of worktreeOwners) await git(path.dirname(owner), ['--git-dir', owner, 'worktree', 'prune']).catch(() => {})
      } catch { /* left for the whole-directory removal */ }
    }
    const builds: string[] = []
    if (sawAll) await findBuildDirs(dir, 0, builds, { dirs: MAX_DIRS })
    for (const b of builds) {
      if (!fs.existsSync(b) || !unused()) continue
      const holder = repos.filter((r) => fs.existsSync(r.dir) && within(b, r.dir)).sort((x, y) => y.dir.length - x.dir.length)[0]
      if (holder) {
        const rel = path.relative(holder.dir, b)
        try { if ((await git(holder.dir, ['ls-files', '-z', '--', rel])).length > 0) continue } catch { continue }
        if (IGNORED_BUILD_DIRS.has(path.basename(b))) {
          try { await git(holder.dir, ['check-ignore', '-q', '--', rel]) } catch { continue }
        }
      } else if (!BUILD_DIRS.has(path.basename(b))) continue
      if (opts.dryRun && done.repos.some((r) => within(b, path.join(dir, r)))) continue
      try { if (!opts.dryRun) await fsp.rm(b, { recursive: true, force: true }); done.builds.push(path.relative(dir, b)) } catch { /* next round */ }
    }
    if (!opts.dryRun) try {
      const m = readMarker(dir)
      if (m) fs.writeFileSync(path.join(dir, TASK_DIR_MARKER), JSON.stringify({ ...m, prunedAt: (opts.now ?? new Date()).toISOString() }) + '\n', { mode: 0o600 })
      if (before) fs.utimesSync(dir, before.atime, before.mtime)
    } catch { /* the next sweep prunes again */ }
    res.pruned.push(done)
  }
  return res
}

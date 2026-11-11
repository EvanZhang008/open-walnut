/**
 * Building the walnut file for a host from this server's checkout
 * (host-file.ts says when). Never in the checkout itself: build-binary.mjs
 * rebuilds dist/web/static, the shipped plugins and dist-bin/ where it runs,
 * and this checkout's dist is the one the running server serves (a deploy that
 * wiped its assets is a known outage), while its working tree may hold other
 * people's unfinished changes. So the build runs in a clone of the commit the
 * running dist was built from, the way scripts/deploy-committed.sh deploys (a
 * dist built from uncommitted changes is refused before this: host-file.ts):
 *
 *   git clone --shared --no-checkout <checkout> <work>/tree; checkout <commit>
 *   node_modules: every entry linked to the checkout's, except the workspace
 *     packages, which are the clone's own (as deploy-committed.sh links them);
 *     when the checkout's install cannot stand in for the commit's (a dependency
 *     it lacks, or one patched with another patch: clone-deps.ts), the commit's
 *     lockfile is installed in the clone instead, as the deploy does
 *   dist/web/static: a copy of the running server's, so the file serves the same
 *     web app and the web build is skipped (--reuse-web)
 *   bun scripts/build-binary.mjs --target <t> [--target <u>...]   one run for
 *     every target asked at once, in the utility QoS band, output to a log
 *
 * Every step is a child process in its own process group with a deadline: a
 * build that runs too long is ended with its children, and nothing here holds
 * the event loop. A build whose daemon is not the one this server runs (its
 * version, from the build's dist/binary-stage/sizes.json) is refused, never
 * handed on: the host would refuse it after the upload anyway, and the cache
 * would send that same file on every later try.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gitChildEnv } from '../../lib/git-env.js'
import { withUtilityQosClamp } from '../../lib/background-qos.js'
import { safeKillProcessGroup } from '../process-group-kill.js'
import { DAEMON_SOURCE_FILES } from '../../providers/daemon-version-check.js'
import { daemonVersionAt, staleDependencies } from './clone-deps.js'
import type { HostFileTarget } from './host-target.js'

export interface CloneBuild {
  /** The git checkout this server's dist was built in. */
  checkout: string
  /** The running dist: its web/static goes into the file. */
  distDir: string
  commit: string
  /** One build-binary run makes all of them. */
  targets: HostFileTarget[]
  /** An empty dir to build in; the caller removes it. */
  work: string
  /** The build's output (appended). */
  log: string
  bun: string
  timeoutMs?: number
  /**
   * The daemon version this server runs (walnut-daemon-<12 hex>): a build whose
   * daemon says another is refused. Absent, or not of that form (a package
   * version, a source run): not compared.
   */
  expectDaemonVersion?: string | null
  /** The files the daemon's version hashes (default daemon-version-check.ts's list); tests give their own. */
  daemonSources?: readonly string[]
}

const STEP_MS = 120_000
export const BUILD_MS = 15 * 60_000
/** `bun install --frozen-lockfile` in the clone, when the checkout's install is stale for the commit. */
export const INSTALL_MS = 10 * 60_000
const DAEMON_VERSION = /^walnut-daemon-[0-9a-f]{12}$/
/** After SIGTERM at the deadline, the group gets this long before SIGKILL. */
const KILL_GRACE_MS = 10_000

interface Ran { code: number | null; stdout: Buffer; stderr: string }

function run(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; input?: Buffer; timeoutMs?: number; logFd?: number }): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const stdio: Array<'pipe' | 'ignore' | number> = [opts.input ? 'pipe' : 'ignore', opts.logFd ?? 'pipe', opts.logFd ?? 'pipe']
    // Its own group: the deadline ends bun and every compiler child it started, not only the wrapper.
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? gitChildEnv(), stdio, detached: true })
    const out: Buffer[] = []
    let err = ''
    child.stdout?.on('data', (c: Buffer) => out.push(c))
    child.stderr?.on('data', (c: Buffer) => { err = (err + c.toString()).slice(-4000) })
    let hard: ReturnType<typeof setTimeout> | undefined
    const signal = (sig: NodeJS.Signals) => { safeKillProcessGroup(child.pid, sig) }
    const timer = setTimeout(() => {
      signal('SIGTERM')
      hard = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS)
    }, opts.timeoutMs ?? STEP_MS)
    const done = () => { clearTimeout(timer); if (hard) clearTimeout(hard) }
    child.once('error', (e) => { done(); reject(e) })
    child.once('close', (code) => { done(); resolve({ code, stdout: Buffer.concat(out), stderr: err }) })
    if (opts.input) {
      // A child that exits before reading its input fails the write with EPIPE as an
      // 'error' event; unheard it would end the server. Its exit code reports the failure.
      child.stdin!.on('error', () => {})
      child.stdin!.end(opts.input)
    }
  })
}

async function git(cwd: string, args: string[], input?: Buffer): Promise<Buffer> {
  const r = await run('git', args, { cwd, ...(input ? { input } : {}) })
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().slice(-300) || `exit ${r.code}`}`)
  return r.stdout
}

/** The workspace packages of the clone (package.json `workspaces`), by name. */
async function workspaces(tree: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const pkg = JSON.parse(await fs.promises.readFile(path.join(tree, 'package.json'), 'utf8')) as { workspaces?: unknown }
  for (const dir of Array.isArray(pkg.workspaces) ? pkg.workspaces : []) {
    if (typeof dir !== 'string') continue
    try {
      const name = (JSON.parse(await fs.promises.readFile(path.join(tree, dir, 'package.json'), 'utf8')) as { name?: unknown }).name
      if (typeof name === 'string') out.set(name, path.join(tree, dir))
    } catch { /* a workspace that is not in this commit */ }
  }
  return out
}

/** node_modules of the clone: links to the checkout's entries, the workspace packages to the clone's own (web/'s too, unless `web: false`). */
export async function linkDependencies(checkout: string, tree: string, opts: { web?: boolean } = {}): Promise<void> {
  const src = path.join(checkout, 'node_modules')
  const dst = path.join(tree, 'node_modules')
  const ws = await workspaces(tree)
  const scopes = new Set([...ws.keys()].filter((n) => n.startsWith('@')).map((n) => n.split('/')[0]!))
  // A node_modules already there (a link to the checkout's) would get these links written into the checkout.
  if (await fs.promises.lstat(dst).then(() => true, () => false)) throw new Error(`${dst} already exists`)
  await fs.promises.mkdir(dst)
  for (const entry of await fs.promises.readdir(src)) {
    if (!scopes.has(entry)) { await fs.promises.symlink(path.join(src, entry), path.join(dst, entry)); continue }
    await fs.promises.mkdir(path.join(dst, entry), { recursive: true })
    for (const child of await fs.promises.readdir(path.join(src, entry))) {
      const name = `${entry}/${child}`
      await fs.promises.symlink(ws.get(name) ?? path.join(src, entry, child), path.join(dst, entry, child))
    }
  }
  for (const [name, dir] of ws) {
    const link = path.join(dst, name)
    if (!fs.existsSync(link)) { await fs.promises.mkdir(path.dirname(link), { recursive: true }); await fs.promises.symlink(dir, link) }
  }
  const webModules = path.join(checkout, 'web', 'node_modules')
  if (opts.web !== false && fs.existsSync(webModules) && fs.existsSync(path.join(tree, 'web'))) await fs.promises.symlink(webModules, path.join(tree, 'web', 'node_modules'))
}

/**
 * How the clone gets its dependencies: the checkout's linked, or the commit's lockfile
 * installed (`root`, or `web` alone). The daemon a host checks decides first: when this
 * server runs a build-hash daemon and the linked clone hashes to it, the links build that
 * same daemon (a server built in the checkout itself, `dev:prod`, expects the checkout's
 * install, stale or not); when it hashes to another, the commit is installed fresh (the
 * deploy did that: 2026-11-11). With no such version to compare, the deploy's rules
 * (clone-deps.ts) decide. A root dependency the checkout lacks is always installed, and
 * web/'s matter only when the build makes the web app (no --reuse-web).
 */
async function chooseDependencies(b: CloneBuild, tree: string, reuseWeb: boolean): Promise<{ install: 'root' | 'web' | null; why: string }> {
  const stale = await staleDependencies(b.checkout, tree)
  const lacking = stale.filter((r) => /^root (?!patched |unpatched )/.test(r))
  const webStale = reuseWeb ? [] : stale.filter((r) => r.startsWith('web '))
  if (lacking.length) return { install: 'root', why: `the checkout's node_modules lacks what this commit declares (${lacking.join(', ')})` }
  const want = b.expectDaemonVersion
  if (want && DAEMON_VERSION.test(want)) {
    await linkDependencies(b.checkout, tree, { web: webStale.length === 0 })
    const linked = await daemonVersionAt(tree, b.daemonSources ?? DAEMON_SOURCE_FILES)
    if (linked === want) return webStale.length ? { install: 'web', why: `the checkout's web/node_modules lacks what this commit declares (${webStale.join(', ')})` } : { install: null, why: '' }
    // Links only (to the checkout's entries and the clone's own packages): removing them touches neither.
    await fs.promises.rm(path.join(tree, 'node_modules'), { recursive: true, force: true })
    await fs.promises.rm(path.join(tree, 'web', 'node_modules'), { force: true })
    const rules = stale.length ? `; ${stale.join(', ')}` : ''
    return { install: 'root', why: `the checkout's install builds ${linked ?? 'a daemon of unknown version'}, not this server's ${want}${rules}` }
  }
  const rootStale = stale.filter((r) => r.startsWith('root '))
  if (rootStale.length) return { install: 'root', why: `the checkout's node_modules is not this commit's install (${rootStale.join(', ')})` }
  await linkDependencies(b.checkout, tree, { web: webStale.length === 0 })
  return webStale.length ? { install: 'web', why: `the checkout's web/node_modules lacks what this commit declares (${webStale.join(', ')})` } : { install: null, why: '' }
}

/** A clone build whose daemon is not the one this server runs: a host would refuse it, so it is not kept. */
export class DaemonMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DaemonMismatchError'
  }
}

/** Build the files in a clone; returns each target's path (inside `work`). */
export async function buildFileInClone(b: CloneBuild): Promise<Partial<Record<HostFileTarget, string>>> {
  if (b.targets.length === 0) throw new Error('no target to build')
  const tree = path.join(b.work, 'tree')
  await git(b.work, ['clone', '--quiet', '--shared', '--no-checkout', b.checkout, tree])
  await git(tree, ['checkout', '--quiet', '--detach', b.commit])
  const args = ['scripts/build-binary.mjs', ...b.targets.flatMap((t) => ['--target', t])]
  const statics = path.join(b.distDir, 'web', 'static')
  const reuseWeb = fs.existsSync(path.join(statics, 'index.html'))
  if (reuseWeb) {
    await fs.promises.cp(statics, path.join(tree, 'dist', 'web', 'static'), { recursive: true, dereference: true })
    args.push('--reuse-web')
  }
  const deps = await chooseDependencies(b, tree, reuseWeb)
  const log = await fs.promises.open(b.log, 'a')
  try {
    await log.write(`${new Date().toISOString()} building the walnut file for ${b.targets.join(', ')} from ${b.commit}\n`)
    const env = gitChildEnv({ PATH: `${path.dirname(b.bun)}${path.delimiter}${process.env.PATH ?? ''}` })
    if (deps.install) {
      await log.write(`${deps.why}; installing the commit's lockfile in the clone${deps.install === 'web' ? "'s web/" : ''}\n`)
      const [icmd, iargs] = withUtilityQosClamp(b.bun, ['install', '--frozen-lockfile'])
      const ri = await run(icmd, iargs, { cwd: deps.install === 'root' ? tree : path.join(tree, 'web'), env, timeoutMs: INSTALL_MS, logFd: log.fd })
      if (ri.code !== 0) {
        throw new Error(`installing this commit's dependencies for the walnut file failed (${ri.code === null ? 'it took too long' : `exit ${ri.code}`}): ${deps.why}; the whole log is ${b.log}`)
      }
    }
    const [cmd, cmdArgs] = withUtilityQosClamp(b.bun, args)
    const r = await run(cmd, cmdArgs, { cwd: tree, env, timeoutMs: b.timeoutMs ?? BUILD_MS, logFd: log.fd })
    if (r.code !== 0) {
      const tail = (await fs.promises.readFile(b.log, 'utf8').catch(() => '')).trim().split('\n').slice(-3).join(' ')
      throw new Error(`building the walnut file for ${b.targets.join(', ')} failed (${r.code === null ? 'it took too long' : `exit ${r.code}`}): ${tail.slice(-300)}; the whole log is ${b.log}`)
    }
  } finally {
    await log.close()
  }
  const files: Partial<Record<HostFileTarget, string>> = {}
  for (const t of b.targets) {
    const file = path.join(tree, 'dist-bin', `walnut-${t}`)
    if (!fs.existsSync(file)) throw new Error(`the build left no dist-bin/walnut-${t}; see ${b.log}`)
    files[t] = file
  }
  const want = b.expectDaemonVersion
  if (want && DAEMON_VERSION.test(want)) {
    const built = await builtDaemonVersion(tree)
    if (built !== want) {
      throw new DaemonMismatchError(`the walnut file built for ${b.targets.join(', ')} runs ${built ?? 'a daemon of unknown version'}, but this server runs ${want}, so it was not kept: a host would refuse it. Its build log is ${b.log}`)
    }
  }
  return files
}

/** The daemon version build-binary.mjs baked into the files (its stage's sizes.json), or null. */
async function builtDaemonVersion(tree: string): Promise<string | null> {
  try {
    const sizes = JSON.parse(await fs.promises.readFile(path.join(tree, 'dist', 'binary-stage', 'sizes.json'), 'utf8')) as { daemonVersion?: unknown }
    return typeof sizes.daemonVersion === 'string' && sizes.daemonVersion.trim() ? sizes.daemonVersion.trim() : null
  } catch {
    return null
  }
}

/** package.json as of `commit` in the checkout (never its working tree, which may hold other changes). */
export async function packageJsonAt(checkout: string, commit: string): Promise<string> {
  return (await git(checkout, ['show', `${commit}:package.json`])).toString('utf8')
}

/** What a build's work dir says about who made it, so a later server can tell an abandoned one. */
export const WORK_OWNER = 'owner.json'

function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * Remove the build dirs (`<prefix>*` in `dir`) a server left when it stopped
 * mid-build: their owner is gone, or they are older than any build may take.
 * A clone and its dist-bin are a few hundred MB each.
 */
export async function pruneAbandonedWork(dir: string, prefix: string, now = Date.now()): Promise<string[]> {
  const removed: string[] = []
  let names: string[] = []
  try { names = await fs.promises.readdir(dir) } catch { return removed }
  for (const n of names) {
    if (!n.startsWith(prefix)) continue
    const work = path.join(dir, n)
    const owner = await fs.promises.readFile(path.join(work, WORK_OWNER), 'utf8').then((t) => JSON.parse(t) as { pid?: unknown; at?: unknown }, () => null)
    const st = await fs.promises.stat(work).catch(() => null)
    if (!st?.isDirectory()) continue
    const at = typeof owner?.at === 'number' ? owner.at : st.mtimeMs
    const old = now - at > 2 * BUILD_MS
    // A dir without its owner file is one being made right now, unless it is old.
    if (old || (owner && !alive(owner.pid))) {
      await fs.promises.rm(work, { recursive: true, force: true }).catch(() => undefined)
      removed.push(work)
    }
  }
  return removed
}

/** `bun@1.4.4` (package.json packageManager) as `1.4.4`, or null. */
export function pinnedBun(packageJson: string): string | null {
  try {
    const pm = (JSON.parse(packageJson) as { packageManager?: unknown }).packageManager
    const m = typeof pm === 'string' ? /^bun@(\d+\.\d+\.\d+)/.exec(pm) : null
    return m ? m[1]! : null
  } catch {
    return null
  }
}

function newerOrSame(v: string, min: string): boolean {
  const a = v.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return true
}

export type BunPick = { path: string; version: string } | { why: string }

/**
 * A bun on this computer to build with: $WALNUT_BUN, the one running this
 * process, PATH, then the usual install places, the first of `min` or newer
 * (the file carries the runtime of the bun that built it, so an older one would
 * ship an older runtime than the code was written for).
 */
export async function findBun(
  env: NodeJS.ProcessEnv = process.env,
  min: string | null = null,
  places: string[] = [path.join(os.homedir(), '.bun', 'bin', 'bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun'],
  self: string | null = process.versions.bun && path.basename(process.execPath).startsWith('bun') ? process.execPath : null,
): Promise<BunPick> {
  const candidates: string[] = []
  if (env.WALNUT_BUN && path.isAbsolute(env.WALNUT_BUN)) candidates.push(env.WALNUT_BUN)
  if (self) candidates.push(self)
  for (const dir of (env.PATH ?? '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, 'bun'))
  candidates.push(...places)
  const older: string[] = []
  for (const c of [...new Set(candidates)]) {
    try { await fs.promises.access(c, fs.constants.X_OK) } catch { continue }
    const r = await run(c, ['--version'], { cwd: os.tmpdir(), env: { PATH: env.PATH ?? '', HOME: os.homedir() }, timeoutMs: 10_000 }).catch(() => null)
    const version = r?.code === 0 ? r.stdout.toString().trim() : ''
    if (!/^\d+\.\d+\.\d+/.test(version)) continue
    if (!min || newerOrSame(version, min)) return { path: c, version }
    older.push(`${version} at ${c}`)
  }
  return {
    why: older.length
      ? `Building the walnut file needs bun ${min} or newer (package.json packageManager); this computer has only ${older.join(', ')}. Run \`bun upgrade\`, or set WALNUT_BUN to a newer bun.`
      : 'Building the walnut file needs bun on this computer (https://bun.sh); none was found ($WALNUT_BUN, PATH, ~/.bun/bin).',
  }
}
